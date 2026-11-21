import { once } from 'node:events';
import { createServer, type AddressInfo, type Server } from 'node:net';

async function listen(server: Server, port: number): Promise<void> {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
}

export async function listenOnLoopback(server: Server, preferredPort: number): Promise<number> {
  try {
    await listen(server, preferredPort);
  } catch (error) {
    if (preferredPort === 0 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      throw error;
    }
    await listen(server, 0);
  }
  return (server.address() as AddressInfo).port;
}

/**
 * Find a loopback port for a server that another process will bind, such as
 * Eve: the preferred port when it is free, otherwise one the OS assigns.
 */
export async function freeLoopbackPort(preferredPort: number): Promise<number> {
  const probe = createServer();
  const port = await listenOnLoopback(probe, preferredPort);
  probe.close();
  await once(probe, 'close');
  return port;
}
