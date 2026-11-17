import type { Hono } from 'hono';
import { hc, parseResponse } from 'hono/client';
import type {
  DesktopRoute,
  DesktopRoutes,
  DesktopRouteInput,
  DesktopRouteOutput,
} from '@wisp/protocol/desktop-routes';
import { bridgeRequest } from './bridge-request';
export { native, desktop } from './desktop';
// The bridge's desktop server as seen by the webview, typed from the shared
// routes contract (the bridge proves at compile time that it serves it).
type DesktopSchema = {
  [P in DesktopRoute]: {
    [M in `$${DesktopRoutes[P]['method']}`]: {
      input: DesktopRouteInput<P> extends undefined ? {} : { json: DesktopRouteInput<P> };
      output: DesktopRouteOutput<P>;
      outputFormat: 'json';
      status: 200;
    };
  };
};
type DesktopApp = Hono<{}, DesktopSchema>;
async function bridgeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const text = request.method === 'GET' ? '' : await request.text();
  const route = new URL(request.url).pathname;
  return Response.json(await bridgeRequest(route, text ? JSON.parse(text) : undefined));
}
/** Typed client for the bridge: `await call(bridge.auth.start.$post({ json }))`. */
export const bridge = hc<DesktopApp>('http://bridge.invalid', { fetch: bridgeFetch });
export { parseResponse as call };
export type { DesktopInfo, Model, Mcp, Panel, Status } from '@wisp/protocol/desktop';
