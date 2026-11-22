import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Stands in for the desktop bridge during evals. It selects the eval model,
// forwards model requests to the OpenAI API with the caller's own key, and
// refuses every game or integration call, which evals replace with stubs.
const CONNECTION = '00000000-0000-4000-8000-000000000e5a';

export async function startFakeBridge() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Set OPENAI_API_KEY in this terminal before running Wisp evals.');
  }
  const token = randomBytes(24).toString('hex');
  const model = process.env.WISP_EVAL_MODEL || 'gpt-5.4';
  const effort = process.env.WISP_EVAL_EFFORT || 'medium';
  const server: Server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== 'Bearer ' + token) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/session-model') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            model,
            effort,
            provider: 'openai',
            modelId: model,
            connectionId: CONNECTION,
            webSearchAvailable: false,
          }),
        );
        return;
      }
      const prefix = '/model/connections/' + CONNECTION + '/';
      if (req.method === 'POST' && url.pathname.startsWith(prefix)) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const upstream = await fetch(
          'https://api.openai.com/v1/' + url.pathname.slice(prefix.length),
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer ' + apiKey,
            },
            body: Buffer.concat(chunks),
          },
        );
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/json',
        });
        if (upstream.body) {
          await pipeline(Readable.fromWeb(upstream.body as never), res);
        } else {
          res.end();
        }
        return;
      }
      res
        .writeHead(503, { 'content-type': 'text/plain' })
        .end('Not available in evals: stub this tool (' + url.pathname + ').');
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500).end(error instanceof Error ? error.message : 'Fake bridge failed');
      } else {
        res.destroy();
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  process.env.WOW_BRIDGE_URL = 'http://127.0.0.1:' + port;
  process.env.WOW_BRIDGE_TOKEN = token;
  return {
    model,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
