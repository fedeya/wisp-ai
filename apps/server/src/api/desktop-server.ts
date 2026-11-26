import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getRequestListener } from '@hono/node-server';
import { writeJson } from '../json-file.ts';
import { listenOnLoopback } from '../loopback-server.ts';
import path from 'node:path';
export async function startDesktopServer(
  runtime: string,
  app: { fetch: (request: Request) => Response | Promise<Response> },
  port = 43190,
) {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from('Bearer ' + token);
  const guarded = new Hono()
    .use(async (c, next) => {
      const supplied = Buffer.from(c.req.header('authorization') || '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return c.text('Forbidden', 403);
      }
      if (c.req.header('origin')) {
        return c.text('Browser origins are not allowed', 403);
      }
      await next();
    })
    .use(
      bodyLimit({
        maxSize: 100000,
        onError: (c) => c.json({ error: 'Request is too large' }, 400),
      }),
    )
    .all('*', (c) => app.fetch(c.req.raw));
  const server = createServer(getRequestListener(guarded.fetch));
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
