import { defaultCapabilities } from '@wisp/protocol/capabilities';
import { expect, test } from 'vitest';
import { keyPages } from './components/connections/ConnectionEditor';
import { integrationGuide } from './components/integrations/integration-guides';
import capabilityFile from '../src-tauri/capabilities/default.json';

// The opener plugin turns clicks on `target="_blank"` links into `open_url`
// calls, which Tauri rejects unless the main window's capability allows the URL.
type Permission = string | { identifier: string; allow?: { url: string }[] };
const capability = capabilityFile as { permissions: Permission[] };
const allowed = capability.permissions
  .flatMap((permission) =>
    typeof permission === 'object' && permission.identifier === 'opener:allow-open-url'
      ? (permission.allow ?? [])
      : [],
  )
  .map(({ url }) => {
    const escaped = url.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`);
  });

const links = [
  'https://wisp.fedeya.sh/changelog',
  'https://wisp.fedeya.sh/changelog?channel=nightly',
  ...Object.values(keyPages),
  ...defaultCapabilities().flatMap(({ id }) => integrationGuide(id)?.link?.url ?? []),
];

test('every external link in the desktop app is allowed by the opener capability', () => {
  expect(links.length).toBeGreaterThan(8);
  for (const link of links) {
    // The opener script sends the normalized URL, as `new URL(href)` serializes it.
    const url = new URL(link!).href;
    expect(
      allowed.some((pattern) => pattern.test(url)),
      url,
    ).toBe(true);
  }
});

test('the opener capability does not allow arbitrary sites', () => {
  for (const url of [
    'https://example.com/',
    'https://everloot.app.example.com/',
    'http://thewowdb.com/',
  ]) {
    expect(
      allowed.some((pattern) => pattern.test(url)),
      url,
    ).toBe(false);
  }
});
