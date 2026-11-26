import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import ipaddr from 'ipaddr.js';

export function publicWebUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('URL must be a public HTTPS URL without credentials.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    (ipaddr.isValid(host) && ipaddr.process(host).range() !== 'unicast')
  ) {
    throw new Error('URL must not target private, localhost or reserved addresses.');
  }
  return url;
}

export async function publicWebAddresses(host: string) {
  const addresses = await lookup(host.replace(/^\[|\]$/g, ''), { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => ipaddr.process(address).range() !== 'unicast')
  ) {
    throw new Error('URL must not resolve to private, localhost or reserved addresses.');
  }
  return addresses;
}

// Impit has no custom DNS lookup hook. A per-call CONNECT tunnel pins the
// validated public IP while preserving the origin's hostname, SNI and TLS
// fingerprint. It never decrypts traffic or delegates DNS back to Impit.
export async function publicWebTunnel(signal: AbortSignal) {
  signal.throwIfAborted();
  const token = randomBytes(24).toString('hex');
  const authorization = 'Basic ' + Buffer.from(token + ':' + token).toString('base64');
  const sockets = new Set<Socket>();
  let authority = '';
  let failure: Error | undefined;
  const server = createServer((_req, res) => res.writeHead(405).end());
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (req, downstream, head) => {
    void (async () => {
      try {
        if (req.headers['proxy-authorization'] !== authorization || req.url !== authority) {
          throw new Error('Unapproved web destination.');
        }
        const url = publicWebUrl('https://' + req.url);
        const addresses = await publicWebAddresses(url.hostname);
        signal.throwIfAborted();
        if (downstream.destroyed) {
          return;
        }
        const upstream = connect({ host: addresses[0]!.address, port: Number(url.port || 443) });
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));
        upstream.on('error', () => downstream.destroy());
        downstream.on('close', () => upstream.destroy());
        upstream.once('connect', () => {
          downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) {
            upstream.write(head);
          }
          downstream.pipe(upstream).pipe(downstream);
        });
      } catch (error) {
        failure = error instanceof Error ? error : new Error('Unsafe web destination.');
        downstream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      }
    })();
  });
  const close = () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) {
    close();
    signal.throwIfAborted();
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start web tunnel.');
  }
  return {
    proxyUrl: `http://${token}:${token}@127.0.0.1:${address.port}`,
    allow(url: URL) {
      authority = url.hostname + ':' + (url.port || '443');
    },
    failure: () => failure,
    close() {
      signal.removeEventListener('abort', close);
      close();
    },
  };
}
