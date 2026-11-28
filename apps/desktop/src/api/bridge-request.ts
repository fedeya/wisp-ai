import { Schema } from 'effect';
import { desktopRoutes, type DesktopRoute } from '@wisp/protocol/desktop-routes';
import { desktop } from './desktop';
const isRoute = (route: string): route is DesktopRoute => Object.hasOwn(desktopRoutes, route);
/**
 * The untyped transport under the typed `bridge` client. The webview never
 * speaks HTTP: Rust holds the bridge token and forwards the call, so failures
 * reject with the bridge's message. Inputs are decoded before crossing IPC and
 * every reply is decoded with its contract schema.
 */
export async function bridgeRequest(route: string, body?: unknown): Promise<unknown> {
  if (!isRoute(route)) {
    throw Error('Unsupported desktop operation.');
  }
  const contract = desktopRoutes[route];
  const result = await desktop<unknown>('bridge_request', {
    method: contract.method.toUpperCase(),
    route,
    body: 'input' in contract ? await Schema.decodeUnknownPromise(contract.input)(body) : null,
  });
  return Schema.decodeUnknownPromise(contract.output)(result);
}
