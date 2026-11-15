import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

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
