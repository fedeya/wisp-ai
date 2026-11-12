import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { createAgentHandler } from '../apps/bridge/src/agent-server.ts';
import { GameRequests } from '../apps/bridge/src/game-requests.ts';
import { newChat } from '../apps/bridge/src/chat-lifecycle.ts';
import { mailHarness } from './addon/mail-harness.ts';
import { mkdtemp, open, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'eve/client';
import { appPaths, prepareEngine } from '../apps/bridge/src/app-paths.ts';
import { startEveProcess, stopEveProcess } from '../apps/bridge/src/agent-process.ts';
import { vi } from 'vitest';
import { inspectionSchema } from '../packages/protocol/src/game-inspection.ts';
import { defaultCapabilities } from '../packages/protocol/src/capabilities.ts';

test('mail inspection is bounded, strict and has its own capability', () => {
  expect(inspectionSchema.parse({ kind: 'mail', args: {} })).toEqual({
    kind: 'mail',
    args: { limit: 10 },
  });
  for (const args of [
    { limit: 0 },
    { limit: 51 },
    { includeBodies: true },
    { refresh: true },
    { sender: 'x' },
  ]) {
    expect(inspectionSchema.safeParse({ kind: 'mail', args }).success).toBe(false);
  }
  expect(defaultCapabilities().some((x) => x.id === 'tool:inspect_mail')).toBe(true);
});

test(
  'actual escaped Send retains useful IDs at maximum attachments and discloses omissions',
  { timeout: 30000 },
  () => {
    const h = mailHarness();
    try {
      h.run(String.raw`
loaded=50;total=77
-- Deliberately adversarial public caller text in the OUTER Inspect result.
-- It is not a plausible player name, but catches row-only budgeting that
-- ignores complete escaped result/envelope size before Transport.Send.
function UnitName()return string.rep(string.char(1),5000)end
function GetInboxHeaderInfo(i)return nil,nil,'PRIVATE_SENDER','PRIVATE_SUBJECT',i,500,i/10,16 end
function HasInboxItem()return true end
function GetInboxItem(i,s)
 local name={};for n=1,100 do name[#name+1]=string.char((i*17+s*31+n*7)%32)..'\\"é材料' end
 return table.concat(name),2589+i,nil,s*3,nil,nil,false
end
`);
      const result = h.inspect(50);
      expect(result.status).toBe('available');
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(48000);
      expect(result.data).toMatchObject({
        loadedCount: 50,
        totalCount: 77,
        scannedRows: 50,
        partial: true,
        truncated: true,
        optionalTextOmitted: true,
      });
      expect(result.data.returnedRows).toBeGreaterThan(0);
      expect(result.data.returnedRows).toBeLessThan(50);
      expect(result.data.rows[0].attachments).toHaveLength(16);
      expect(result.data.rows[0].attachments[0]).toMatchObject({
        itemId: 2590,
        quantity: 3,
        linkStatus: 'unknown',
      });
      expect(result.data.rows[0].attachments[0].name).toBeUndefined();
      // Maximal legal identifiers containing JSON escapes, not an invalid giant
      // envelope that the real host would reject before game-request dispatch.
      const wire = h.send('"\\\n'.repeat(66) + 'xx', '\n\\"'.repeat(66) + 'xx');
      expect(wire.jsonBytes).toBeLessThanOrEqual(60000);
      expect(wire.compressedBytes).toBeLessThanOrEqual(65535);
      expect(wire.packet.data.status).toBe('available');
      expect(wire.packet.data.data).toMatchObject({
        partial: true,
        truncated: true,
        scannedRows: 50,
      });
      expect(wire.packet.data.data.rows[0].attachments[0]).toMatchObject({
        itemId: 2590,
        quantity: 3,
        linkStatus: 'unknown',
      });
      expect(wire.packet.data.data.returnedRows).toBeGreaterThan(0);
      expect(wire.packet.data.data.returnedRows).toBeLessThanOrEqual(result.data.returnedRows);
      expect(JSON.stringify(wire.packet)).not.toContain('PRIVATE_');
      console.log('adversarial escaped mail Send', {
        ...wire,
        packet: undefined,
        completedResultBytes: Buffer.byteLength(JSON.stringify(result)),
        returnedRows: wire.packet.data.data.returnedRows,
      });
    } finally {
      h.close();
    }
  },
);

test('exact overlong links and malformed/restricted fields stay unknown; no cache loading', () => {
  const h = mailHarness();
  try {
    h.run(`
function GetInboxHeaderInfo()return nil,nil,'PRIVATE','PRIVATE',nil,-1,nil,1,nil,nil,nil,nil,nil,nil,'|Hitem:2589:|h['..string.rep('x',2000)..']|h' end
function GetInboxItem()return 'Cloth',2589,nil,0,nil,nil,false end
`);
    const result = h.inspect();
    expect(result.status).toBe('available');
    expect(result.data.partial).toBe(true);
    expect(result.data.rows[0].fields).toEqual({
      money: 'unknown',
      cod: 'unknown',
      expiry: 'unknown',
      attachmentCount: 'known',
    });
    expect(result.data.rows[0].attachments[0]).toMatchObject({
      itemId: 2589,
      linkStatus: 'unknown',
      quantityStatus: 'unknown',
    });
    expect(result.data.rows[0].attachments[0].link).toBeUndefined();
    h.run(
      `GetInboxHeaderInfo=function()return nil,nil,nil,nil,0,0,2,1,nil,nil,nil,nil,nil,nil,'not a native link item:2589' end`,
    );
    expect(h.inspect().data.rows[0].attachments[0].link).toBeUndefined();
    h.run(`issecretvalue=function(v)return type(v)=='number' and v==2589 end`);
    expect(h.inspect().data.rows[0].attachments[0].itemId).toBeUndefined();
    h.run('GetInboxNumItems=function()return nil,nil end');
    expect(h.inspect().data).toMatchObject({
      countsStatus: 'partial',
      partial: true,
      scannedRows: 0,
    });
  } finally {
    h.close();
  }
});

test('budget preserves unknown links and maximal useful rows when names are loading', () => {
  const h = mailHarness();
  try {
    h.run(`
loaded=50;total=50
function GetInboxHeaderInfo()return nil,nil,nil,nil,0,0,2,16 end
function HasInboxItem()return true end
function GetInboxItem()return nil,2589,nil,5,nil,nil,false end
`);
    const result = h.inspect(50);
    expect(result.status).toBe('available');
    expect(result.data.optionalTextOmitted).toBeUndefined();
    expect(result.data).toMatchObject({ partial: true, truncated: true, scannedRows: 50 });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(48000);
    for (const row of result.data.rows) {
      expect(row.attachments).toHaveLength(16);
      for (const attachment of row.attachments) {
        expect(attachment).toMatchObject({ itemId: 2589, quantity: 5, linkStatus: 'unknown' });
        expect(attachment.name).toBeUndefined();
        expect(attachment.link).toBeUndefined();
      }
    }
    const extra = structuredClone(result.data.rows[0]);
    extra.position = result.data.returnedRows + 1;
    const next = structuredClone(result);
    next.data.rows.push(extra);
    next.data.returnedRows++;
    expect(Buffer.byteLength(JSON.stringify(next))).toBeGreaterThan(48000);
    const wire = h.send();
    expect(wire.packet.data.status).toBe('available');
    expect(wire.packet.data.data).toEqual(result.data);
  } finally {
    h.close();
  }
});

test(
  'diverse control/quote/backslash/UTF-8 attachment text survives production escaped framing',
  { timeout: 15000 },
  () => {
    const h = mailHarness();
    try {
      h.run(String.raw`
loaded=3;total=4
function GetInboxHeaderInfo(i)return nil,nil,'PRIVATE_SENDER','PRIVATE_SUBJECT',i,0,i/10,16 end
function HasInboxItem()return true end
function GetInboxItem(i,s)
 return string.rep(string.char((i*7+s)%32),40)..'"\\é材料'..string.rep('z',180),2589+i,nil,s,nil,nil,false
end
`);
      const result = h.inspect();
      expect(result.data.optionalTextOmitted).toBeUndefined();
      expect(result.data.rows[0].attachments[0].nameTruncated).toBe(true);
      const wire = h.send();
      expect(wire.packet.data.data.rows[2].attachments[15]).toEqual(
        result.data.rows[2].attachments[15],
      );
      expect(wire.packet.data.data.rows[0].attachments[0].name).toContain('材料');
      expect(wire.jsonBytes).toBeLessThanOrEqual(60000);
      expect(wire.frames).toBeGreaterThan(1);
      console.log('escaped text roundtrip', { ...wire, packet: undefined });
    } finally {
      h.close();
    }
  },
);

test('mail events perform no background reads, closed windows do not scan, and row limits bound both passes', () => {
  const h = mailHarness();
  try {
    h.run("fire('MAIL_INBOX_UPDATE');fire('MAIL_SUCCESS');assert(reads==0);open=false");
    expect(h.inspect().status).toBe('unavailable');
    h.run('assert(reads==0);open=true');
    const result = h.inspect(2);
    expect(result.data).toMatchObject({
      scannedRows: 2,
      returnedRows: 2,
      truncated: true,
      partial: true,
      coverageScope: 'loaded cache only',
      unseenMailStatus: 'unknown',
    });
    h.run('assert(reads==4)'); // two present slots, twice; no polling or automatic capture
  } finally {
    h.close();
  }
});

test('inconsistent attachment coverage never associates a first-link variant with multiple slots', () => {
  const h = mailHarness();
  try {
    h.run('HasInboxItem=function(_,slot)return slot<=2 end');
    const result = h.inspect();
    expect(result.data.partial).toBe(true);
    expect(result.data.rows[0].attachments).toHaveLength(2);
    expect(
      result.data.rows[0].attachments.every((item: { link?: string }) => item.link === undefined),
    ).toBe(true);
  } finally {
    h.close();
  }
});

test('mail wire budgeting leaves unrelated scalar packet data untouched', () => {
  const h = mailHarness();
  try {
    h.run(
      "ns.Character._BoundMailPacket({data=3},60000);ns.Character._BoundMailPacket({data='text'},60000);ns.Character._BoundMailPacket({data=true},60000)",
    );
  } finally {
    h.close();
  }
});

test.each(['nested unrelated', 'unavailable mail', 'malformed mail rows', 'other packet kind'])(
  'production Send does not trim %s',
  (mode) => {
    const h = mailHarness();
    try {
      h.run(`
local mail={kind='mail',rows={{attachments={{slot=1,name=string.rep('x',61000),linkStatus='unknown'}}}}}
result={status='available',data=mail}
${mode === 'nested unrelated' ? "result.data={kind='resources',nested=mail}" : ''}
${mode === 'unavailable mail' ? "result.status='unavailable';result.error='closed'" : ''}
${mode === 'malformed mail rows' ? 'mail.rows[2]={attachments={false}}' : ''}
${mode === 'other packet kind' ? "local send=ns.Transport.Send;ns.Transport.Send=function(packet)packet.type='poll';return send(packet)end" : ''}
`);
      const wire = h.send();
      expect(wire.packet.data.status).toBe(
        mode === 'unavailable mail' ? 'unavailable' : 'available',
      );
      const data = wire.packet.data.data;
      const mail = mode === 'nested unrelated' ? data.nested : data;
      expect(mail.rows[0].attachments[0].name).toHaveLength(61000);
      expect(mail.optionalTextOmitted).toBeUndefined();
      expect(mail.truncated).toBeUndefined();
      expect(wire.jsonBytes).toBeGreaterThan(60000);
      expect(wire.compressedBytes).toBeLessThanOrEqual(65535);
    } finally {
      h.close();
    }
  },
);

test.each([
  'header',
  'counts',
  'presence',
  'item',
  'secret presence',
  'secret currency',
  'currency',
])('mail guards preserve unknown coverage for %s', (mode) => {
  const h = mailHarness();
  try {
    h.run(`
loaded=1;total=1
${mode === 'header' ? "GetInboxHeaderInfo=function()error('synthetic getter failure')end" : ''}
${mode === 'counts' ? "GetInboxNumItems=function()error('synthetic getter failure')end" : ''}
${mode === 'presence' ? "HasInboxItem=function()error('synthetic getter failure')end" : ''}
${mode === 'item' ? "GetInboxItem=function()error('synthetic getter failure')end" : ''}
${mode === 'secret presence' ? 'local secret={};HasInboxItem=function()return secret end;issecretvalue=function(v)return v==secret end' : ''}
${mode === 'secret currency' ? 'issecretvalue=function(v)return v==false end' : ''}
${mode === 'currency' ? "GetInboxItem=function()return 'Currency',2589,nil,7,nil,nil,true end" : ''}
`);
    const result = h.inspect();
    expect(result.status).toBe('available');
    expect(result.data.partial).toBe(true);
    if (mode === 'counts') {
      expect(result.data).toMatchObject({ countsStatus: 'partial', scannedRows: 0 });
    } else if (mode === 'header') {
      expect(result.data.rows[0].fields.money).toBe('unknown');
    } else if (mode === 'presence' || mode === 'secret presence') {
      expect(result.data.rows[0].unknownSlots).toBe(16);
    } else {
      const attachment = result.data.rows[0].attachments[0];
      expect(attachment.itemId).toBeUndefined();
      expect(attachment.kind).toBe(mode === 'currency' ? 'currency' : 'unknown');
      expect(attachment.linkStatus).toBe('unknown');
      if (mode === 'currency') expect(attachment.quantity).toBe(7);
    }
  } finally {
    h.close();
  }
});

test(
  'optional exact links are omitted before losing useful single-attachment rows',
  { timeout: 15000 },
  () => {
    const h = mailHarness();
    try {
      h.run(String.raw`
loaded=50;total=50
function GetInboxHeaderInfo(i)
 return nil,nil,'PRIVATE','PRIVATE',0,0,i,1,nil,nil,nil,nil,nil,nil,'|Hitem:2589:|h['..string.rep(string.char(i%32),900)..']|h'
end
`);
      const result = h.inspect(50);
      expect(result.data).toMatchObject({
        optionalTextOmitted: true,
        returnedRows: 50,
        truncated: false,
        partial: false,
        unseenMailStatus: 'unknown',
      });
      expect(result.data.rows[49].attachments[0]).toMatchObject({
        itemId: 2589,
        quantity: 250,
        linkStatus: 'omitted_budget',
      });
      expect(result.data.rows[49].attachments[0].link).toBeUndefined();
      expect(h.send().jsonBytes).toBeLessThanOrEqual(60000);
    } finally {
      h.close();
    }
  },
);

test.each(['close/reopen', 'event', 'same-count', 'count'])(
  'rejects mixed mailbox data on %s churn',
  (mode) => {
    const h = mailHarness();
    try {
      h.run(`
local original=GetInboxItem
function GetInboxItem(i,s)
 reads=reads+1
 if reads==1 then
  ${mode === 'close/reopen' ? "fire('MAIL_CLOSED');fire('MAIL_SHOW')" : mode === 'event' ? "fire('MAIL_INBOX_UPDATE')" : mode === 'count' ? 'loaded=2' : ''}
 end
 if ${mode === 'same-count' ? 'reads>3' : 'false'} then return 'Cloth',2589,nil,999,nil,nil,false end
 return 'Cloth',2589,nil,i*5,nil,nil,false
end
`);
      const result = h.inspect();
      expect(result.status).toBe('unavailable');
      expect(result.data).toBeUndefined();
    } finally {
      h.close();
    }
  },
);

test('manual retrieval followed by explicit fresh mail/resources replaces observations without double counting', () => {
  const h = mailHarness();
  try {
    h.run(`
NUM_BAG_SLOTS=0
C_Container={GetContainerNumSlots=function()return 10 end,GetContainerNumFreeSlots=function()return 9 end}
function GetMoney()return 100 end
ns.Character.ReadBags=function()return {items={{id=2589,count=retrieved and 7 or 2}}}end
`);
    const before = h.inspect();
    expect(before.data.rows[0].attachments[0].quantity).toBe(5);
    h.run("retrieved=true;fire('MAIL_INBOX_UPDATE')");
    const after = h.inspect();
    expect(after.data.rows[0]).toMatchObject({ attachmentCount: 0, attachmentsStatus: 'complete' });
    h.run("result=ns.Character.Inspect({kind='resources',args={}})");
    const resources = h.send().packet.data;
    expect(resources.data.bags[0].count).toBe(7);
    expect(resources.data.moneyCopper).toBe(100);
    expect(after.data.rows[1].moneyCopper).toBe(12345);
    expect(after.data.rows[2].codCopper).toBe(500);
    expect(before.data.rows[0].attachments[0].quantity).toBe(5); // detached old observation, never a cache merge
  } finally {
    h.close();
  }
});

test(
  'real Eve deferred discovery executes mail through authenticated bridge and native Lua',
  { timeout: 100_000 },
  async () => {
    const scratch = process.env.WISP_TEST_SCRATCH_ROOT || tmpdir();
    const root = await mkdtemp(path.join(scratch, 'wisp-048-eve-'));
    const h = mailHarness();
    const chat = newChat('eve-mail', 'game');
    chat.status = 'working';
    const flags = path.join(root, 'capabilities.json');
    await writeFile(
      flags,
      JSON.stringify({
        enabled: {
          ...Object.fromEntries(defaultCapabilities().map((capability) => [capability.id, false])),
          'tool:inspect_mail': true,
        },
      }),
    );
    const observed: Record<string, unknown>[] = [];
    const pending = new GameRequests(() =>
      queueMicrotask(() => {
        for (const request of pending.snapshot()) {
          observed.push(request);
          const inspection = inspectionSchema.parse(request.inspection);
          expect(inspection.kind).toBe('mail');
          h.inspect(inspection.kind === 'mail' ? inspection.args.limit : undefined);
          const wire = h.send(request.chat, request.id);
          pending.receive(request.id, 'game', request.chat, wire.packet.data);
        }
      }),
    );
    const handler = createAgentHandler({
      token: 'offline',
      getChats: () => [chat],
      currentTransport: () => 'game',
      capabilitySettings: { enabled: (id: string) => id === 'tool:inspect_mail' },
      pending,
    } as unknown as Parameters<typeof createAgentHandler>[0]);
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      if (req.url?.startsWith('/session-model?')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            model: 'offline-test',
            effort: 'provider-default',
            contextWindow: 128000,
          }),
        );
        return;
      }
      if (req.url !== '/model/responses') return handler(req, res);
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      const n = requests.length;
      const planned =
        n === 1
          ? { name: 'eve__search', input: { query: 'wow__inspect_mail' } }
          : n === 2 || n === 4
            ? { name: 'eve__tool', input: { name: 'wow__inspect_mail', input: {} } }
            : undefined;
      const item = planned
        ? {
            id: 'item-' + n,
            type: 'function_call',
            call_id: 'call-' + n,
            status: 'completed',
            name: planned.name,
            arguments: JSON.stringify(planned.input),
          }
        : {
            id: 'item-' + n,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'Loaded mail inspected; not bag inventory.',
                annotations: [],
              },
            ],
          };
      const events = [
        {
          type: 'response.created',
          response: { id: 'r-' + n, model: 'offline-test', created_at: 1 },
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: planned ? { ...item, arguments: '' } : { ...item, content: [] },
        },
        ...(planned
          ? [
              {
                type: 'response.function_call_arguments.delta',
                item_id: item.id,
                output_index: 0,
                delta: item.arguments,
              },
              {
                type: 'response.function_call_arguments.done',
                item_id: item.id,
                output_index: 0,
                arguments: item.arguments,
              },
            ]
          : [
              {
                type: 'response.output_text.delta',
                item_id: item.id,
                output_index: 0,
                delta: item.content![0]!.text,
              },
              {
                type: 'response.output_text.done',
                item_id: item.id,
                output_index: 0,
                text: item.content![0]!.text,
              },
            ]),
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'r-' + n,
            model: 'offline-test',
            created_at: 1,
            output: [item],
            usage: { input_tokens: 20, output_tokens: 10 },
          },
        },
      ];
      res
        .writeHead(200, { 'content-type': 'text/event-stream' })
        .end(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const engine = path.join(root, 'engine');
    await prepareEngine(appPaths(process.cwd()).agent, engine);
    const log = await open(path.join(root, 'eve.log'), 'a');
    const child = startEveProcess({
      root: engine,
      logFile: log.fd,
      port,
      environment: {
        ...process.env,
        NODE_ENV: 'development',
        EVE_MOCK_AUTHORED_MODELS: '0',
        WOW_BRIDGE_TOKEN: 'offline',
        WOW_BRIDGE_URL: origin,
        WOW_CAPABILITIES_FILE: flags,
        WOW_MCP_CONFIG: path.join(root, 'mcp.json'),
      },
      onError: () => {},
      onExit: () => {},
    });
    const client = new Client({
      baseUrl: 'http://127.0.0.1:' + port,
      auth: { bearer: () => 'offline' },
    });
    try {
      await vi.waitFor(() => client.health(), { timeout: 75000, interval: 200 });
      const session = (await client.sessions.create()).session;
      chat.eveId = session.id;
      const delivery = await session.send(
        'Inspect only the already-loaded mail in my open mailbox.',
        { signal: AbortSignal.timeout(20000) },
      );
      const events = [];
      for await (const event of delivery.stream({ signal: AbortSignal.timeout(20000) })) {
        events.push(event);
      }
      expect((await delivery.result()).status).toBe('completed');
      expect(requests).toHaveLength(3);
      expect((requests[0]!.tools as { name: string }[]).map((x) => x.name)).not.toContain(
        'wow__inspect_mail',
      );
      const output = (step: number, callId: string) =>
        JSON.parse(
          (requests[step]!.input as { type?: string; call_id?: string; output?: string }[]).find(
            (item) => item.type === 'function_call_output' && item.call_id === callId,
          )!.output!,
        );
      expect(output(1, 'call-1').results).toContainEqual(
        expect.objectContaining({ tool: 'wow__inspect_mail' }),
      );
      const mail = output(2, 'call-2');
      expect(mail).toMatchObject({ status: 'available', data: { loadedCount: 3, totalCount: 8 } });
      expect(mail.data.rows[1].moneyCopper).toBe(12345);
      expect(mail.data.rows[0].expiryDays).toBe(2);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        chat: chat.id,
        inspection: { kind: 'mail', args: { limit: 10 } },
      });
      expect(JSON.stringify(events)).not.toContain('PRIVATE_');
      await writeFile(
        flags,
        JSON.stringify({
          enabled: Object.fromEntries(
            defaultCapabilities().map((capability) => [capability.id, false]),
          ),
        }),
      );
      const denied = await session.send(
        'The mail capability is now disabled. Try its tool to verify denial.',
        { signal: AbortSignal.timeout(20000) },
      );
      for await (const event of denied.stream({ signal: AbortSignal.timeout(20000) })) {
        events.push(event);
      }
      expect((await denied.result()).status).toBe('completed');
      expect(requests).toHaveLength(5);
      expect(observed).toHaveLength(1); // Native Eve permission removal prevents any new RPC/game read.
      expect(output(4, 'call-4').error).toContain('No tool named');
      console.log(
        'real Eve search -> tool -> authenticated RPC -> native Inspect -> escaped Send: passed',
      );
    } catch (error) {
      console.error(
        'Eve fixture diagnostics',
        root,
        await readFile(path.join(root, 'eve.log'), 'utf8'),
        requests,
        observed,
      );
      throw error;
    } finally {
      pending.cancelAll('test finished');
      const exited = new Promise<void>((resolve) =>
        child.exitCode !== null ? resolve() : child.once('exit', () => resolve()),
      );
      await stopEveProcess(child);
      await exited;
      await log.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      h.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);

test('authenticated active-session RPC reaches native Inspect and production escaped Send', async () => {
  const h = mailHarness();
  const chat = newChat('mail', 'game');
  chat.eveId = 'eve';
  chat.status = 'working';
  let transport = 'game';
  let enabled = true;
  const wires: ReturnType<typeof h.send>[] = [];
  const pending = new GameRequests(() => {
    queueMicrotask(() => {
      for (const request of pending.snapshot()) {
        const inspection = inspectionSchema.parse(request.inspection);
        expect(inspection.kind).toBe('mail');
        h.inspect(inspection.kind === 'mail' ? inspection.args.limit : undefined);
        const wire = h.send(request.chat, request.id);
        wires.push(wire);
        expect(pending.receive(request.id, 'wrong-session', request.chat, wire.packet.data)).toBe(
          false,
        );
        expect(pending.receive(request.id, 'game', 'wrong-chat', wire.packet.data)).toBe(false);
        pending.receive(request.id, 'game', request.chat, wire.packet.data);
      }
    });
  });
  const server = createServer(
    createAgentHandler({
      token: 'offline',
      getChats: () => [chat],
      currentTransport: () => transport,
      capabilitySettings: { enabled: (id: string) => enabled && id === 'tool:inspect_mail' },
      pending,
    } as unknown as Parameters<typeof createAgentHandler>[0]),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/inspect';
  const payload = { eveSession: 'eve', inspection: { kind: 'mail', args: {} } };
  const post = (body: unknown = payload, token = 'offline') =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    expect((await post(payload, 'wrong')).status).toBe(403);
    expect((await post({ ...payload, eveSession: 'other' })).status).toBe(503);
    transport = 'other';
    expect((await post()).status).toBe(503);
    transport = 'game';
    chat.status = 'done';
    expect((await post()).status).toBe(503);
    chat.status = 'working';
    enabled = false;
    expect((await post()).status).toBe(503);
    enabled = true;
    chat.proactive = true;
    expect((await post()).status).toBe(503);
    chat.proactive = false;
    expect(
      (await post({ ...payload, inspection: { kind: 'mail', args: { refresh: true } } })).status,
    ).toBe(503);
    expect(wires).toHaveLength(0);
    const response = await post();
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      status: 'available',
      data: { loadedCount: 3, totalCount: 8, partial: true },
    });
    expect(result.data.rows[0].attachments[0]).toMatchObject({ itemId: 2589, quantity: 5 });
    expect(result.data.rows[1].moneyCopper).toBe(12345);
    expect(result.data.rows[2]).toMatchObject({ codCopper: 500, fields: { expiry: 'unknown' } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|subject|sender|body/);
    expect(wires[0]!.jsonBytes).toBeLessThanOrEqual(60000);
    console.log('mail native/RPC/wire gates', { ...wires[0], packet: undefined });
  } finally {
    pending.cancelAll('test finished');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    h.close();
  }
});
