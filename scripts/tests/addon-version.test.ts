import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, layer } from '@effect/vitest';
import { Effect, FileSystem, Path, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { addonVersionFromToc } from '../../apps/server/src/game/addon-version.ts';
import { addonReleaseVersion, stampAddonReleaseVersion } from '../addon-release-version.ts';
import { gitIn, temporaryDirectory, writeFiles } from './fixtures.ts';

layer(NodeServices.layer)((it) => {
  it.effect(
    'release patch counts addon and helper changes from the current base version',
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory('wisp-addon-history-');
        const git = gitIn(root);
        const commit = Effect.fnUntraced(function* (file: string, content: string) {
          yield* writeFiles(root, { [file]: content });
          yield* git('add', file);
          yield* git('commit', '-m', file);
        });
        const version = (ref?: string) => addonReleaseVersion(root, ref);

        yield* git('init', '-b', 'main');
        yield* commit('addon/WispAI/Core.lua', 'initial addon');
        yield* commit('addon/WispAI/WispAI.toc', '## Version: 1.0.0\nCore.lua\n');
        yield* commit('scripts/addon-release-version.ts', 'start automatic versioning');
        expect(yield* version()).toBe('1.0.0');

        yield* commit('apps/desktop/package.json', '{"version":"0.1.3"}');
        yield* commit('packages/protocol/src/protocol.ts', 'unrelated packet schema');
        expect(yield* version()).toBe('1.0.0');

        yield* commit('addon/WispAI/Core.lua', 'updated addon');
        expect(yield* version()).toBe('1.0.1');
        yield* git('tag', 'v0.1.3');

        yield* git('switch', '-c', 'helpers');
        yield* commit('packages/protocol/src/addon-helpers.ts', 'first helper change');
        yield* commit('packages/protocol/src/addon-helpers.ts', 'second helper change');
        yield* git('switch', 'main');
        yield* git('merge', '--no-ff', '-m', 'Update addon helpers', 'helpers');
        expect(yield* version()).toBe('1.0.2');
        expect(yield* version('refs/tags/v0.1.3')).toBe('1.0.1');

        yield* git('tag', 'v0.1.4');
        yield* git('switch', '--detach', 'v0.1.4');
        expect(yield* version()).toBe('1.0.2');

        yield* git('switch', 'main');
        yield* commit('apps/desktop/package.json', '{"version":"2.0.0"}');
        expect(yield* version()).toBe('1.0.2');

        yield* commit('addon/WispAI/WispAI.toc', '## Version: 1.1.0\nCore.lua\n');
        expect(yield* version()).toBe('1.1.0');
        yield* commit('addon/WispAI/WispAI.toc', '## Version: 1.1.0\n## Title: Wisp\nCore.lua\n');
        expect(yield* version()).toBe('1.1.1');

        yield* git('switch', '-c', 'addon-major');
        yield* commit('addon/WispAI/WispAI.toc', '## Version: 2.0.0\n## Title: Wisp\nCore.lua\n');
        yield* git('switch', 'main');
        yield* git('merge', '--no-ff', '-m', 'Begin addon 2.0', 'addon-major');
        expect(yield* version()).toBe('2.0.0');
        yield* commit('packages/protocol/src/addon-helpers.ts', 'helper change for addon 2.0');
        expect(yield* version()).toBe('2.0.1');

        yield* commit('addon/WispAI/WispAI.toc', '## Version: 2.0.7\nCore.lua\n');
        expect((yield* Effect.flip(version())).message).toContain('MAJOR.MINOR.0');
      }),
    30_000,
  );

  it.effect(
    'the packaged addon version is inherited by the installed addon and helpers',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* temporaryDirectory('wisp-addon-version-');
        const payload = path.join(root, 'payload');
        const wow = path.join(root, 'fake WoW');
        const saves = path.join(wow, 'WTF/Account/PLAYER/SavedVariables');
        const installed = path.join(wow, 'Interface/AddOns');
        const toc = '## Interface: 16001\r\n## Version: 2.0.0\r\nCore.lua\r\n';
        yield* writeFiles(root, {
          'fake WoW/Wow.exe': '',
          'fake WoW/WTF/Account/PLAYER/SavedVariables/WispAI.lua': 'WispAIDB = { sidebar = false }',
          'payload/addon/WispAI/WispAI.toc': toc,
        });
        yield* stampAddonReleaseVersion(path.join(payload, 'addon/WispAI/WispAI.toc'), '2.0.1');

        const config = path.join(root, 'data/config.local.json');
        const savedModel = { model: 'local-model' };
        const Config = Schema.fromJsonString(
          Schema.Struct({
            model: Schema.optionalKey(Schema.String),
            wow: Schema.optionalKey(Schema.String),
          }),
        );
        for (const desktopVersion of ['0.1.3', '0.1.4-nightly.123.2']) {
          const managedByDesktop = desktopVersion.includes('nightly');
          if (managedByDesktop) {
            yield* fs.writeFileString(config, JSON.stringify(savedModel));
          }
          yield* fs.writeFileString(
            path.join(payload, 'package.json'),
            JSON.stringify({ version: desktopVersion }),
          );
          const args = ['apps/server/scripts/install.ts', wow];
          if (managedByDesktop) args.push('--skip-config');
          const handle = yield* spawner.spawn(
            ChildProcess.make(process.execPath, args, {
              cwd: path.resolve(),
              detached: false,
              env: { WISP_RESOURCE_ROOT: payload, WISP_DATA_DIR: path.join(root, 'data') },
              extendEnv: true,
            }),
          );
          const [stderr, exitCode] = yield* Effect.all(
            [
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
              handle.exitCode,
              Stream.runDrain(handle.stdout),
            ],
            { concurrency: 'unbounded' },
          );
          expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
          expect(yield* Schema.decodeEffect(Config)(yield* fs.readFileString(config))).toEqual(
            managedByDesktop ? savedModel : { wow },
          );
          const helpers = (yield* fs.readDirectory(installed)).filter((name) =>
            /^WispAI_[BS]\d+$/.test(name),
          );
          expect(helpers).toHaveLength(1152);
          expect(yield* fs.readFileString(path.join(installed, 'WispAI/WispAI.toc'))).toBe(
            toc.replace('2.0.0', '2.0.1'),
          );
          for (const name of helpers) {
            const helper = yield* fs.readFileString(path.join(installed, name, `${name}.toc`));
            expect(addonVersionFromToc(helper)).toBe('2.0.1');
          }
          expect(yield* fs.readFileString(path.join(saves, 'WispAI.lua'))).toBe(
            'WispAIDB = { sidebar = false }',
          );
        }
      }),
    45_000,
  );
});
