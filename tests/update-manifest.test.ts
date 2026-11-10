import { expect, test } from 'vitest';
import { updateManifest } from '../scripts/update-manifest.ts';

test('the update manifest references the exact versioned release artifact and embeds its signature', () => {
  const manifest = updateManifest('0.3.0', 'signed-data\n', 'Fixed connections.');
  expect(manifest.version).toBe('0.3.0');
  expect(manifest.notes).toBe('Fixed connections.');
  expect(manifest.platforms['windows-x86_64']).toEqual({
    signature: 'signed-data',
    url: 'https://github.com/fedeya/wisp-ai/releases/download/v0.3.0/WispAI-0.3.0-windows-x64-setup.exe',
  });
  expect(Number.isNaN(Date.parse(manifest.pub_date))).toBe(false);
});

test('unsigned and prerelease manifests cannot enter the stable update feed', () => {
  expect(() => updateManifest('0.3.0', ' ')).toThrow('signature');
  expect(() => updateManifest('0.3.0-beta.1', 'signature')).toThrow();
  expect(() => updateManifest('0.3.1-nightly.123.1', 'signature')).toThrow();
  expect(() => updateManifest('0.3.0', 'signature', '', 'nightly')).toThrow();
});

test('nightly manifests reference immutable builds and carry shared notes', () => {
  const manifest = updateManifest(
    '0.3.1-nightly.123.1',
    'signature',
    '# Preview\n\n- New feature',
    'nightly',
  );
  expect(manifest.platforms['windows-x86_64'].url).toContain(
    '/v0.3.1-nightly.123.1/WispAI-0.3.1-nightly.123.1-windows-x64-setup.exe',
  );
  expect(manifest.notes).toContain('New feature');
});
