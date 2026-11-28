import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, layer } from '@effect/vitest';
import { Effect, FileSystem, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { updateManifest, writeUpdateManifest } from '../update-manifest.ts';
import { temporaryDirectory, writeFiles } from './fixtures.ts';

const failure = (effect: Effect.Effect<unknown, { readonly message: string }>) =>
  Effect.map(Effect.flip(effect), (error) => error.message);

layer(NodeServices.layer)((it) => {
  it.effect(
    'the update manifest references the exact versioned release artifact and embeds its signature',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-11-20T10:30:00.000Z'));
        const manifest = yield* updateManifest('0.3.0', 'signed-data\n', 'Fixed connections.');
        expect(manifest.version).toBe('0.3.0');
        expect(manifest.notes).toBe('Fixed connections.');
        expect(manifest.platforms['windows-x86_64']).toEqual({
          signature: 'signed-data',
          url: 'https://github.com/fedeya/wisp-ai/releases/download/v0.3.0/WispAI-0.3.0-windows-x64-setup.exe',
        });
        expect(manifest.pub_date).toBe('2026-11-20T10:30:00.000Z');
      }),
  );

  it.effect('unsigned and prerelease manifests cannot enter the stable update feed', () =>
    Effect.gen(function* () {
      expect(yield* failure(updateManifest('0.3.0', ' '))).toContain('signature');
      expect(yield* failure(updateManifest('0.3.0-beta.1', 'signature'))).toContain('Unsupported');
      expect(yield* failure(updateManifest('0.3.1-nightly.123.1', 'signature'))).toContain(
        'release channel',
      );
      expect(yield* failure(updateManifest('0.3.0', 'signature', '', 'nightly'))).toContain(
        'release channel',
      );
    }),
  );

  it.effect('nightly manifests reference immutable builds and carry shared notes', () =>
    Effect.gen(function* () {
      const manifest = yield* updateManifest(
        '0.3.1-nightly.123.1',
        'signature',
        '# Preview\n\n- New feature',
        'nightly',
      );
      expect(manifest.platforms['windows-x86_64'].url).toContain(
        '/v0.3.1-nightly.123.1/WispAI-0.3.1-nightly.123.1-windows-x64-setup.exe',
      );
      expect(manifest.notes).toContain('New feature');
    }),
  );

  it.effect(
    'the written manifest carries the shared notes, or a link to the release without them',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const Written = Schema.fromJsonString(
          Schema.Struct({ version: Schema.String, notes: Schema.String }),
        );
        const installer = 'dist/WispAI-0.3.0-windows-x64-setup.exe';
        const root = yield* temporaryDirectory('wisp-update-manifest-');
        yield* writeFiles(root, { [`${installer}.sig`]: 'signed-data\n' });
        yield* writeUpdateManifest('0.3.0', installer, root);
        const text = yield* fs.readFileString(`${root}/dist/latest.json`);
        expect(text.endsWith('}\n')).toBe(true);
        expect(yield* Schema.decodeEffect(Written)(text)).toEqual({
          version: '0.3.0',
          notes: 'Release notes: https://github.com/fedeya/wisp-ai/releases/tag/v0.3.0',
        });
        yield* writeFiles(root, { 'dist/release-notes.md': '# Notes\n\n- Item\n' });
        yield* writeUpdateManifest('0.3.0', installer, root);
        expect(
          yield* Schema.decodeEffect(Written)(yield* fs.readFileString(`${root}/dist/latest.json`)),
        ).toEqual({ version: '0.3.0', notes: '# Notes\n\n- Item\n' });
      }),
  );
});
