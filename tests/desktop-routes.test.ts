import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { desktopRoutes } from '@wisp/protocol/desktop-routes';

// The native host forwards webview bridge calls only for routes in `permitted()`;
// a contract route missing there fails in the installed app but not in UI tests.
test('the native host forwards every desktop contract route with its method', () => {
  const source = readFileSync('apps/desktop/src-tauri/src/main.rs', 'utf8');
  const body = source.match(
    /fn permitted\(method: &str, route: &str\) -> bool \{([\s\S]*?)\n\}/,
  )?.[1];
  expect(body).toBeDefined();
  const allowed = (method: string) => {
    const list = body!.match(new RegExp(`method == "${method}"\\s*&&\\s*\\[([^\\]]*)\\]`))?.[1];
    return new Set([...(list ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1]));
  };
  const native = { get: allowed('GET'), post: allowed('POST') };
  const missing = Object.entries(desktopRoutes)
    .filter(([route, contract]) => !native[contract.method].has(route))
    .map(([route, contract]) => `${contract.method.toUpperCase()} ${route}`);
  expect(missing).toEqual([]);
});
