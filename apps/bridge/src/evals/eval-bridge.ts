// Model bridge for Eve evals (apps/agent/evals). It uses Wisp's own ChatGPT
// sign-in and model proxy with a separate data folder, so eval sessions never
// share or refresh the installed app's tokens. Game tools are eval stubs.
//
//   node apps/bridge/src/evals/eval-bridge.ts sign-in   one-time ChatGPT sign-in
//   node apps/bridge/src/evals/eval-bridge.ts serve     prints {"url","token"} and serves
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatGPTAuth } from '../auth/chatgpt-auth.ts';
import { NativeVault } from '../auth/secret-vault.ts';
import { proxyModel } from '../models/model-proxy.ts';

const dataDir = path.resolve(
  process.env.WISP_EVAL_DATA_DIR || path.join(os.homedir(), '.wisp-evals'),
);
const desktop =
  process.env.WISP_DESKTOP_EXE ||
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Wisp AI', 'wisp.exe');

async function connect() {
  await mkdir(dataDir, { recursive: true });
  // The native vault keeps secrets under WISP_DATA_DIR, apart from the app's.
  process.env.WISP_DATA_DIR = dataDir;
  const auth = new ChatGPTAuth(dataDir, new NativeVault(desktop));
  await auth.load();
  return auth;
}

async function signIn() {
  const auth = await connect();
  if (auth.state().status === 'connected') {
    console.log('Evals are already signed in to ChatGPT as ' + auth.state().account + '.');
    return;
  }
  const { authorizationUrl } = await auth.beginSignIn(undefined, true);
  console.log('Open this link to sign in to ChatGPT for Wisp evals:\n\n' + authorizationUrl + '\n');
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const state = auth.state();
    if (state.status === 'connected') {
      // Let the vault finish saving the new session before the process exits.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      console.log('Signed in as ' + state.account + '. You can run the evals now.');
      return;
    }
    if (state.status !== 'authorizing') {
      throw new Error(state.message || 'Sign-in did not finish (' + state.status + ').');
    }
  }
}

async function serve() {
  const auth = await connect();
  if (auth.state().status !== 'connected') {
    throw new Error(
      'Evals are not signed in to ChatGPT. Run: node apps/bridge/src/evals/eval-bridge.ts sign-in',
    );
  }
  const models = await auth.models();
  const model = process.env.WISP_EVAL_MODEL || models[0]?.slug;
  if (!model || !models.some((entry) => entry.slug === model)) {
    throw new Error(
      'Choose an available eval model with WISP_EVAL_MODEL: ' +
        models.map((entry) => entry.slug).join(', '),
    );
  }
  const effort = process.env.WISP_EVAL_EFFORT || 'medium';
  const token = randomBytes(24).toString('hex');
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== 'Bearer ' + token) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/session-model') {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ model, effort, webSearchAvailable: true }));
        return;
      }
      // Evals run one fixture character with empty, throwaway memory.
      if (req.method === 'POST' && url.pathname === '/identity') {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ characterKey: 'eval-character' }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/memory') {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ entries: [] }));
        return;
      }
      // Fixture item sources (WISP_EVAL_ITEM_SOURCES), answered for the
      // requested IDs only, as the real bridge composes them.
      if (
        req.method === 'POST' &&
        url.pathname === '/inspect' &&
        process.env.WISP_EVAL_ITEM_SOURCES
      ) {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
        }
        const inspection = JSON.parse(raw).inspection as {
          kind?: string;
          args?: { itemIds?: number[] };
        };
        if (inspection?.kind === 'item_sources') {
          const known = JSON.parse(await readFile(process.env.WISP_EVAL_ITEM_SOURCES, 'utf8'));
          const items = [...new Set(inspection.args?.itemIds ?? [])].map(
            (itemId) => known[itemId] ?? { itemId, sourceKnown: false, sourcesStatus: 'available' },
          );
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              status: 'available',
              items,
              priceStatus: 'available',
              realm: 'Vorn',
              note: 'Player-observed sources need 3 agreeing installs; game-file sources are unconfirmed. sourceKnown=false means no known source, not proof the item is unobtainable. Auction prices are cached unit prices in copper.',
            }),
          );
          return;
        }
        res
          .writeHead(503, { 'content-type': 'text/plain' })
          .end('Not available in evals: stub this tool (/inspect).');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/model/responses') {
        await proxyModel(req, res, auth);
        return;
      }
      res
        .writeHead(503, { 'content-type': 'text/plain' })
        .end('Not available in evals: stub this tool (' + url.pathname + ').');
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
      } else {
        res
          .writeHead(503, { 'content-type': 'application/json', 'x-wisp-model-error': 'true' })
          .end(
            JSON.stringify({
              error: { message: error instanceof Error ? error.message : 'Eval bridge failed' },
            }),
          );
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  console.log(JSON.stringify({ url: 'http://127.0.0.1:' + port, token, model }));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

const command = process.argv[2];
(command === 'sign-in'
  ? signIn()
  : command === 'serve'
    ? serve()
    : Promise.reject(new Error('Usage: eval-bridge.ts sign-in | serve'))
).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
