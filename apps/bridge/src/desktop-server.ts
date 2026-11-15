import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeJson } from './json-file.ts';
import { errorMessage } from './errors.ts';
import { listenOnLoopback } from './loopback-server.ts';
import path from 'node:path';
export async function startDesktopServer(
  runtime: string,
  handle: (method: string, url: string, data: unknown) => Promise<unknown>,
  port = 43190,
) {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    const expected = Buffer.from('Bearer ' + token),
      supplied = Buffer.from(req.headers.authorization || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (req.headers.origin) {
      res.writeHead(403).end('Browser origins are not allowed');
      return;
    }
    try {
      req.setEncoding('utf8');
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 100000) {
          throw Error('Request is too large');
        }
      }
      const result = await handle(
        req.method || 'GET',
        req.url || '/',
        body ? JSON.parse(body) : {},
      );
      res
        .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify(result ?? { ok: true }));
    } catch (error) {
      res
        .writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: errorMessage(error) }));
    }
  });
  try {
    const boundPort = await listenOnLoopback(server, port);
    await writeJson(path.join(runtime, 'desktop.json'), {
      port: boundPort,
      token,
      pid: process.pid,
    });
    return server;
  } catch (error) {
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
    throw error;
  }
}
