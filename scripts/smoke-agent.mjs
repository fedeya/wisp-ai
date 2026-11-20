import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const repository = fileURLToPath(new URL('../', import.meta.url));
const root = process.env.WISP_RESOURCE_ROOT || repository;
const bridge = process.env.WISP_RESOURCE_ROOT || path.join(repository, 'apps/bridge');
const require = createRequire(path.join(bridge, 'package.json'));
const agent = path.dirname(require.resolve('@wisp/agent/package.json'));
const eve = fileURLToPath(new URL('../../bin/eve.js', pathToFileURL(require.resolve('eve'))));
const dir =
  process.env.WISP_SMOKE_DIR || path.resolve(repository, '../../work', 'agent-smoke-' + Date.now());
await mkdir(dir, { recursive: true });
const load = (p) => import(pathToFileURL(path.join(bridge, p)).href);
const { ChatGPTAuth } = await load('src/auth/chatgpt-auth.ts'),
  { NativeVault } = await load('src/auth/secret-vault.ts'),
  { proxyModel } = await load('src/models/model-proxy.ts'),
  { TheWoWDB } = await load('src/integrations/thewowdb.ts'),
  { searchPublicWeb } = await load('src/integrations/search/public-web-search.ts'),
  { applyEvent } = await load('src/chat/events.ts'),
  { ReplyProjection } = await load('src/reply/reply-stream.ts'),
  { turnInput } = await load('src/chat/context.ts');
const { Client } = await import(pathToFileURL(require.resolve('eve/client')).href);
const { Simulator } = await load('src/integrations/simulation/simulator.ts');
const { CapabilitySettings } = await load('src/integrations/capabilities.ts');
const addonFixtures =
  process.env.WISP_SMOKE_ADDONS === '1'
    ? (await import('./addon-smoke-fixtures.ts')).addonSmokeFixtures(repository)
    : undefined;
const simulationSnapshot = process.env.WISP_SMOKE_CHARACTER
  ? JSON.parse(await readFile(process.env.WISP_SMOKE_CHARACTER, 'utf8'))
  : undefined;
const researchMode = process.env.WISP_SMOKE_RESEARCH === '1';
const simulator = new Simulator(root);
const dataRoot = process.env.WISP_DATA_DIR || root;
const config = JSON.parse(await readFile(path.join(dataRoot, 'config.local.json'), 'utf8')),
  model = config.model || 'gpt-6.1-sol';
const auth = new ChatGPTAuth(
  path.join(dataRoot, 'runtime'),
  new NativeVault(
    process.env.WISP_DESKTOP_EXE ||
      path.join(repository, 'apps/desktop/src-tauri/target/release/wisp.exe'),
  ),
);
await auth.load();
const t = auth.saved.profiles.find((p) => p.id === auth.saved.activeId)?.tokens;
if (!t || t.expiresAt - Date.now() < 600000) {
  throw Error('Token too close to expiry for isolated smoke; avoid concurrent renewal');
}
const scopedAuth = {
  models: async () => [{ slug: model }],
  authorized: async (url, init) => {
    const headers = new Headers(init.headers);
    headers.set('authorization', 'Bearer ' + t.accessToken);
    return fetch(url, { ...init, headers, redirect: 'error' });
  },
};
const { prepareEngine } = await load('src/app-paths.ts');
await prepareEngine(agent, dir);
for (const file of ['agent/agent.ts', 'src/agent-rpc.ts', 'agent/tools/wow__query_character.ts']) {
  const p = path.join(dir, file);
  await writeFile(p, (await readFile(p, 'utf8')).replaceAll('43187', '43197'));
}
const capabilities = new CapabilitySettings(path.join(dir, 'capabilities.json'));
capabilities.agentFile = path.join(dir, 'agent-capabilities.json');
await capabilities.load();
await capabilities.set('integration:questie', false);
if (!simulationSnapshot) {
  capabilities.availability.set('core:wow', { available: false, status: 'waiting' });
}
if (researchMode) {
  capabilities.availability.set('core:wow', { available: true, status: 'fixture' });
  for (const entry of capabilities.snapshot()) {
    if (entry.toolName?.startsWith('wow__') && entry.id !== 'tool:query_training') {
      capabilities.availability.set(entry.id, {
        available: false,
        status: 'unavailable',
        reason: 'No live game in this smoke test.',
      });
    }
  }
}
if (addonFixtures) {
  const { IntegrationState } = await load('src/integrations/integration-state.ts');
  const state = new IntegrationState(capabilities);
  assert.ok(state.receive(addonFixtures.report));
  await capabilities.set('integration:questie', true);
  await capabilities.set('mcp:everloot', false);
}
await capabilities.publish();
const token = randomBytes(32).toString('hex'),
  database = new TheWoWDB(),
  rpc = [];
const modelTools = [];
const server = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== 'Bearer ' + token) {
      res.writeHead(403).end();
      return;
    }
    if (req.url.startsWith('/session-model?')) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ model, effort: 'medium' }));
      return;
    }
    if (req.url === '/model/responses') {
      if (process.env.WISP_SMOKE_WEB_FETCH === '1') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          const request = JSON.parse(body);
          for (const item of request.input ?? []) {
            if (['function_call', 'function_call_output'].includes(item.type)) {
              modelTools.push(item);
            }
          }
        });
      }
      await proxyModel(req, res, scopedAuth);
      return;
    }
    let raw = '';
    for await (const b of req) {
      raw += b;
    }
    const data = JSON.parse(raw),
      { eveSession: _session, ...args } = data;
    let value;
    const call = { endpoint: req.url, operation: data.operation };
    rpc.push(call);
    if (req.url === '/inspect' && researchMode && data.inspection?.kind === 'training') {
      // Deliberately reproduce the catalog-miss boundary. No names, levels or
      // facts about the real character are fabricated; web and model are live.
      value = {
        status: 'available',
        source: 'Synthetic catalog-miss fixture',
        data: {
          class: 'MAGE',
          spells: [],
          total: 0,
          unresolvedNames: 0,
          version: 'forever',
          note: 'Synthetic empty catalog result for this regression. Missing coverage is not proof of absence; investigate acquisition and availability with external sources.',
        },
      };
      call.kind = 'training';
    } else if (req.url === '/inspect' && addonFixtures) {
      const { inspectionSchema } = await import('../packages/protocol/dist/game-inspection.js');
      const inspection = inspectionSchema.parse(data.inspection);
      if (inspection.kind === 'questie_quest' || inspection.kind === 'questie_chain') {
        assert.equal(inspection.args.questId, 600001);
      }
      if (inspection.kind === 'object_locations') {
        assert.equal(inspection.args.objectId, 99);
        assert.equal(inspection.args.mapId, 1454);
      }
      if (inspection.kind === 'stored_item') {
        assert.equal(inspection.args.itemId, 123);
      }
      if (inspection.kind === 'item_prices') {
        assert.deepEqual(inspection.args.itemIds, [123, 999]);
      }
      value = addonFixtures.inspections[inspection.kind];
      if (!value) {
        throw Error('No synthetic fixture for ' + inspection.kind);
      }
      call.kind = inspection.kind;
    } else if (req.url === '/database') {
      value = await database.query(args);
    } else if (req.url === '/simulate' && simulationSnapshot) {
      value = await simulator.run(simulationSnapshot, args);
    } else if (req.url === '/state' && simulationSnapshot) {
      value = simulationSnapshot;
    } else if (req.url === '/wowhead') {
      call.query = args.query;
      value = await searchPublicWeb(args, scopedAuth, model);
      call.budget = value.budget;
      call.sources = value.sources?.map((source) => source.url);
      call.research = value.research;
    } else if (req.url === '/memory' && data.operation === 'list') {
      value = { entries: [] };
    } else if (req.url === '/identity') {
      value = { characterKey: null };
    } else {
      throw Error('Smoke forbids state changes and game actions: ' + req.url);
    }
    call.status = value.status;
    call.version = value.version ?? value.source?.version;
    if (req.url === '/simulate') {
      call.plans = value.results?.map((r) => ({
        label: r.label,
        dps: r.dps.average,
        spellIds: r.damageBySpell.map((a) => a.spellId),
      }));
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  } catch (e) {
    res.writeHead(500).end(e.message);
  }
});
await new Promise((r) => server.listen(43197, '127.0.0.1', r));
const log = await open(path.join(dir, 'eve.log'), 'a');
const child = spawn(
  process.execPath,
  [eve, 'dev', '--no-ui', '--no-default-extensions', '--port', '43196'],
  {
    cwd: dir,
    windowsHide: true,
    stdio: ['ignore', log.fd, log.fd],
    env: {
      ...process.env,
      WOW_BRIDGE_TOKEN: token,
      WOW_BRIDGE_URL: 'http://127.0.0.1:43197',
      WOW_MODEL: model,
      WOW_MCP_CONFIG: '',
      WOW_CAPABILITIES_FILE: capabilities.agentFile,
    },
  },
);
const client = new Client({ baseUrl: 'http://127.0.0.1:43196' }),
  report = { model, tests: [] };
let session;
try {
  let ready = false;
  for (let i = 0; i < 400; i++) {
    try {
      await client.health();
      ready = true;
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.ok(ready, 'isolated Eve ready');
  session = (await client.sessions.create()).session;
  const chat = {
      id: 'smoke',
      title: 'Diagnostic',
      owner: 'smoke',
      status: 'working',
      messages: [],
      activity: [],
    },
    parts = new ReplyProjection();
  const run = async (name, question) => {
    console.log('START ' + name);
    const d = await session.send(
      turnInput(
        question,
        simulationSnapshot,
        { id: 'smoke', title: 'Diagnostic', titleGenerated: true },
        capabilities.snapshot(),
      ),
      { signal: AbortSignal.timeout(300_000) },
    );
    let calls = [];
    const failures = [];
    for await (const event of d.stream()) {
      applyEvent(chat, event, parts);
      if (event.type === 'call.requested') {
        calls.push(event.data.capability?.name);
        console.log('TOOL ' + event.data.capability?.name);
      }
      if (event.type === 'call.settled' && event.data.outcome !== 'completed') {
        console.log('TOOL_OUTCOME ' + event.data.outcome);
        failures.push(event.data.outcome);
      }
    }
    const r = await d.result();
    const row = {
      name,
      status: r.status,
      error: r.error?.message,
      calls,
      usage: structuredClone(chat.usage),
      reply: chat.messages.filter((m) => m.role === 'assistant').at(-1)?.text,
    };
    report.tests.push(row);
    await writeFile(path.join(dir, 'report.json'), JSON.stringify({ ...report, rpc }, null, 2));
    if (process.env.WISP_SMOKE_WEB_FETCH === '1') {
      await writeFile(path.join(dir, 'web-fetch-trace.json'), JSON.stringify(modelTools, null, 2));
    }
    console.log(JSON.stringify(row));
    assert.equal(r.status, 'completed');
    assert.deepEqual(failures, [], 'real tool calls must succeed');
    return row;
  };
  if (researchMode) {
    const result = await run(
      'availability research after a catalog miss',
      '¿Cuándo aprendo invisibilidad con el mago?',
    );
    const catalog = result.calls.indexOf('wow__query_training');
    const search = result.calls.indexOf('web__web_search');
    assert.ok(
      catalog >= 0 && search > catalog,
      'agent must consult the catalog and then investigate the web',
    );
    assert.ok(result.calls.includes('web_fetch'), 'agent must inspect original source evidence');
    report.scenario =
      'Synthetic catalog miss; real model, production tools, live database and global web search. No WoW session or game state.';
    // Save the answer and search dossiers for a human semantic review rather
    // than passing an expected game answer into the agent or grading keywords.
  } else if (process.env.WISP_SMOKE_WEB_FETCH === '1') {
    const result = await run(
      'Mobalytics full guide with continuation',
      'Abrí https://mobalytics.gg/wow-forever/classes/mage-leveling-guide con web_fetch y leé la guía completa. Si recibís nextCursor, volvé a llamar web_fetch usando ese cursor y la misma URL, hasta que no haya nextCursor y truncated sea false. No uses búsquedas ni otras fuentes, no guardes memoria. Al terminar dame un resumen breve en español, incluyendo algo del último fragmento, y confirmá cuántos fragmentos leíste y cuántos caracteres totales devolvió la herramienta.',
    );
    assert.ok(
      result.calls.filter((name) => name === 'web_fetch').length >= 2,
      'model must actually continue reading',
    );
    const items = [
      ...new Map(modelTools.map((item) => [item.type + ':' + item.call_id, item])).values(),
    ];
    const calls = items.filter(
      (item) => item.type === 'function_call' && item.name === 'web_fetch',
    );
    const fragments = calls.map((call) => {
      const args = JSON.parse(call.arguments);
      const output = items.find(
        (item) => item.type === 'function_call_output' && item.call_id === call.call_id,
      );
      assert.ok(output, 'model received tool output');
      const page = typeof output.output === 'string' ? JSON.parse(output.output) : output.output;
      return { args, ...page, content: undefined };
    });
    assert.ok(fragments.length >= 2);
    assert.equal(fragments[0].startOffset, 0);
    for (let i = 1; i < fragments.length; i++) {
      assert.equal(fragments[i].args.cursor, fragments[i - 1].nextCursor);
      assert.equal(fragments[i].startOffset, fragments[i - 1].endOffset);
    }
    const last = fragments.at(-1);
    assert.equal(last.truncated, false);
    assert.equal(last.nextCursor, undefined);
    assert.equal(last.endOffset, last.totalCharacters);
    report.fragments = fragments;
    console.log('FRAGMENTS ' + JSON.stringify(fragments));
  } else if (addonFixtures) {
    let result = await run(
      'Questie Lua adapter fixtures',
      'Prueba con datos sintéticos, no mi personaje: usá questie__get_quest y questie__get_quest_chain para questId=600001, y questie__find_object_locations para objectId=99,mapId=1454. Resumí requisitos, cadena y posición sin inferir elegibilidad real. No uses otras fuentes.',
    );
    for (const name of [
      'questie__get_quest',
      'questie__get_quest_chain',
      'questie__find_object_locations',
    ]) {
      assert.ok(result.calls.includes(name), name);
    }
    result = await run(
      'Syndicator Lua adapter fixture',
      'Con estos datos sintéticos consultá syndicator__find_item para itemId=123 y decime dónde está guardado. No consultes el inventario actual ni otras fuentes y aclará que es caché.',
    );
    assert.ok(result.calls.includes('syndicator__find_item'));
    result = await run(
      'Auctionator Lua adapter fixture',
      'Usá auctionator__get_item_prices para los itemIds 123 y 999 de la prueba sintética. Decime precio unitario y antigüedad; si falta alguno, no inventes cero. No consultes otras fuentes.',
    );
    assert.ok(result.calls.includes('auctionator__get_item_prices'));
    await capabilities.set('integration:syndicator', false);
    result = await run(
      'Disabled addon on existing Eve session',
      'Volvé a consultar syndicator__find_item para itemId=123. Si la integración está apagada, decímelo sin usar otras fuentes ni tools.',
    );
    assert.ok(!result.calls.includes('syndicator__find_item'));
    assert.equal(rpc.filter((call) => call.endpoint === '/inspect').length, 5);
  } else if (simulationSnapshot) {
    const result = await run(
      'current-level DPS simulation',
      'Compará con simulate_dps, al nivel real del personaje, estas dos rotaciones de 30 segundos a 5 yardas: A) repetir Descarga de Escarcha; B) apertura una vez de Descarga de Escarcha, Nova de Escarcha, Explosión de Fuego y Misiles Arcanos, después usar la varita. Primero consultá mis hechizos para elegir sus rangos aprendidos. Usá 500 iteraciones para ambas y explicá el resultado sin fingir kiteo ni ataques del enemigo.',
    );
    assert.ok(result.calls.includes('wowsims__simulate_dps'));
    const call = rpc.findLast((r) => r.endpoint === '/simulate');
    assert.equal(call?.status, 'available');
    assert.equal(call.plans.length, 2);
    for (const id of [205, 122, 2136, 5143, 5019]) {
      assert.ok(
        call.plans.some((p) => p.spellIds.includes(id)),
        'real agent comparison used spell ' + id,
      );
    }
    assert.match(result.reply, /11/);
  } else {
    let result = await run(
      'primary catalog',
      '¿Qué hace Nova de Escarcha (spell 122) en Forever? Usá get_database_entity para verificar el dato en TheWoWDB y citá su fuente. No consultes mi personaje: es una pregunta general.',
    );
    assert.ok(result.calls.includes('thewowdb__get_database_entity'));
    await capabilities.set('integration:thewowdb', false);
    result = await run(
      'disabled integration',
      'Consultá otra vez spell 122 usando TheWoWDB. Si esa integración ya no está habilitada, decímelo y no uses otra fuente ni inventes una consulta.',
    );
    assert.ok(
      !result.calls.some((name) => name?.startsWith('thewowdb__')),
      'disabled integration removed on an existing Eve session',
    );
    await capabilities.set('integration:thewowdb', true);
    result = await run(
      're-enabled integration',
      'Volví a habilitar TheWoWDB. Consultá spell 122 con thewowdb__get_database_entity para verificarlo de nuevo.',
    );
    assert.ok(result.calls.includes('thewowdb__get_database_entity'));
    result = await run(
      'Everloot complement',
      'Para verificar la cobertura: buscá Frost Nova con search_knowledge de la conexión everloot-search de Everloot. Descubrí la herramienta con eve__search y ejecutala con eve__tool aunque TheWoWDB ya tenga el hechizo. Informá si hay coincidencias confirmadas para Forever; no guardes nada en memoria.',
    );
    assert.ok(
      result.calls.some((n) => /eve__tool|search_knowledge/.test(n)),
      'real MCP invocation',
    );
    result = await run(
      'Wowhead fallback',
      'Buscá con web_search una guía de leveleo de mago escarcha en Wowhead Forever. Usá esa herramienta de búsqueda aunque haya otras fuentes. Dame 2 consejos con enlaces de esa guía, no de Retail ni Classic.',
    );
    assert.ok(result.calls.includes('web__web_search'));
    console.log('START manual compaction');
    const compact = await session.compact();
    for await (const event of compact.stream()) {
      applyEvent(chat, event, parts);
    }
    const cr = await compact.result();
    console.log(JSON.stringify({ compactionStatus: cr.status, usage: chat.usage }));
    assert.ok(chat.usage?.compactions >= 1, 'real compaction completed');
    result = await run(
      'post compaction',
      '¿Cuál era la versión del juego de las fuentes que estábamos consultando? Respondé brevemente y sin herramientas.',
    );
    assert.ok(result.usage.contextTokens > 0, 'usage after compact');
    for (const endpoint of ['/database', '/wowhead']) {
      assert.ok(
        rpc.some(
          (r) =>
            r.endpoint === endpoint &&
            r.status === 'available' &&
            (endpoint === '/wowhead' || r.version === 'forever'),
        ),
        endpoint + ' must return verified live data',
      );
    }
  }
  await writeFile(path.join(dir, 'report.json'), JSON.stringify({ ...report, rpc }, null, 2));
  console.log('PASS ' + dir);
} finally {
  if (session) {
    await session.end({ reason: 'Isolated smoke finished' }).catch(() => {});
  }
  await new Promise((r) =>
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () =>
      r(),
    ),
  );
  await new Promise((r) => server.close(r));
  await log.close();
}
