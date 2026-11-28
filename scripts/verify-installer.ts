// @effect-migrated
// Installs, starts, upgrades and uninstalls a built installer in a disposable
// Windows CI profile, and writes what it saw to dist/installer-smoke.json.
//   node scripts/verify-installer.ts [installer]   (dist/WispAI-<version>-windows-x64-setup.exe)
import { tmpdir } from 'node:os';
import {
  Clock,
  Console,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Ref,
  Schedule,
  Schema,
  Stream,
} from 'effect';
import { Argument, Command } from 'effect/cli';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { addonVersionFromToc } from '../apps/server/src/game/addon-version.ts';
import { addonReleaseVersion } from './addon-release-version.ts';
import { output } from './child-process.ts';
import { environmentVariable } from './environment.ts';
import { fetchHttpClient } from './http-client.ts';
import { InstallerMismatch, installerBuildVersion } from './installer-version.ts';
import { runScript } from './run-script.ts';

export class InstallerCheckFailed extends Schema.TaggedError<InstallerCheckFailed>()(
  'InstallerCheckFailed',
  { message: Schema.String },
) {}

const failed = (message: string) => new InstallerCheckFailed({ message });

const PackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
/** The updater manifest beside the installer, as far as it identifies the signed build. */
const SignedBuild = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    platforms: Schema.Record(
      Schema.String,
      Schema.Struct({ url: Schema.String, signature: Schema.optionalKey(Schema.String) }),
    ),
  }),
);
/** runtime/desktop.json: the running bridge's process and how to reach it. */
const DesktopIdentity = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Int, port: Schema.Int, token: Schema.String }),
);
const ReadyStatus = Schema.Struct({ ready: Schema.optionalKey(Schema.Unknown) });
const AuthStatus = Schema.Struct({ auth: Schema.Struct({ status: Schema.String }) });

/** Milliseconds on the monotonic clock, as fractions like performance.now. */
const now = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos) / 1_000_000);

/** The version of the signed build `installer` is, from the updater manifest beside it. */
export const installerVersion = Effect.fnUntraced(function* (installer: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* Schema.decodeEffect(SignedBuild)(
    yield* fs.readFileString(path.join(path.dirname(installer), 'latest.json')),
  ).pipe(
    Effect.mapError(
      () =>
        new InstallerMismatch({
          message: 'Installer and update manifest must identify the same signed build.',
        }),
    ),
  );
  return yield* Effect.fromResult(installerBuildVersion(installer, manifest));
});

/** Fails with `message` if `file` exists. */
const absent = Effect.fnUntraced(function* (file: string, message: string) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* fs.exists(file)) {
    return yield* failed(message);
  }
});

/** Runs a command that must exit with 0 within `timeout`, as execFile with a timeout did. */
const run = (
  command: string,
  args: readonly string[],
  timeout: Duration.Input,
  options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> } = {},
) =>
  output(command, args, options).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(failed(`Timed out: ${[command, ...args].join(' ')}`)),
    }),
  );

/** The stages the installer's update log records, in order. */
export const updateStages = (log: string) =>
  log
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [milliseconds, stage] = line.split(' ');
      return { milliseconds: Number(milliseconds), stage };
    });

const requiredStages = [
  'installer-ready',
  'helper-extracted',
  'bridge-stopped',
  'copying-files',
  'files-installed',
];

/**
 * Waits for the bridge `pid` to report ready through its runtime/desktop.json
 * in `data`, trying 150 times 400 ms apart. A missing or unreadable identity,
 * or a status request that fails, is another try; `exited` ends the wait.
 */
export const waitUntilReady = Effect.fnUntraced(function* (
  data: string,
  pid: number,
  exited: Effect.Effect<boolean>,
  log: Effect.Effect<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const ready = Effect.gen(function* () {
    const running = yield* Schema.decodeEffect(DesktopIdentity)(
      yield* fs.readFileString(path.join(data, 'runtime/desktop.json')),
    );
    if (running.pid !== pid) {
      return false;
    }
    const response = yield* client.get('http://127.0.0.1:' + running.port + '/status', {
      headers: { authorization: 'Bearer ' + running.token },
    });
    const status = yield* HttpClientResponse.schemaBodyJson(ReadyStatus)(response);
    return status.ready === true;
  }).pipe(Effect.catch(() => Effect.succeed(false)));
  for (let attempt = 0; attempt < 150; attempt++) {
    if (yield* ready) {
      return;
    }
    if (yield* exited) {
      return yield* failed('Installed bridge exited: ' + (yield* log));
    }
    yield* Effect.sleep('400 millis');
  }
  return yield* failed('Installed agent did not become ready: ' + (yield* log));
});

/** Removes `directory`, retrying as fs.rm's maxRetries 10 and retryDelay 200 did. */
const removeWithRetries = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .remove(directory, { recursive: true, force: true })
    .pipe(
      Effect.retry(
        Schedule.recurs(10).pipe(
          Schedule.modifyDelay(({ attempt }) => Effect.succeed(Duration.millis(200 * attempt))),
        ),
      ),
    );
});

const verifyInstaller = Effect.fnUntraced(function* (installerArgument: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const client = yield* HttpClient.HttpClient;
  const appData = yield* environmentVariable('APPDATA');
  if (!(yield* environmentVariable('CI')) || !appData) {
    return yield* failed('Run installer verification in a disposable Windows CI profile.');
  }
  const { version: sourceVersion } = yield* Schema.decodeEffect(PackageJson)(
    yield* fs.readFileString('package.json'),
  );
  const addonVersion = yield* addonReleaseVersion(path.resolve());
  const installer = path.resolve(
    installerArgument || `dist/WispAI-${sourceVersion}-windows-x64-setup.exe`,
  );
  const version = yield* installerVersion(installer);
  const temporary = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ directory: tmpdir(), prefix: 'wisp-installer-' }),
    (directory) => Effect.orDie(removeWithRetries(directory)),
  );
  if (!temporary.startsWith(path.resolve(tmpdir()) + path.sep)) {
    return yield* failed('Unsafe test directory.');
  }
  const target = path.join(temporary, 'Installed');
  const data = path.join(appData, 'com.wisp.ai');

  const installStarted = yield* now;
  yield* run(installer, ['/S', '/D=' + target], '180 seconds');
  const installMilliseconds = (yield* now) - installStarted;
  const executable = path.join(target, 'wisp.exe');
  const payload = path.join(target, 'payload');
  yield* fs.access(executable);
  for (const name of [
    'config.local.json',
    '.eve',
    'runtime/chats.json',
    'runtime/wisp.sqlite',
    'runtime/wisp.sqlite-wal',
    'runtime/wisp.sqlite-shm',
    'runtime/chatgpt-host.json',
    'secrets',
    'tests',
    'apps/desktop',
    'src-tauri',
    'node_modules/@wisp/desktop',
  ]) {
    yield* absent(path.join(payload, name), 'Personal data included: ' + name);
  }
  yield* fs.makeDirectory(data, { recursive: true });
  yield* absent(
    path.join(data, 'config.local.json'),
    'Installer verification requires a fresh user profile.',
  );
  const env = { WISP_DATA_DIR: data, WISP_RESOURCE_ROOT: payload, WISP_DESKTOP_EXE: executable };
  yield* run(executable, ['--self-test'], '30 seconds', { env });
  const node = path.join(payload, 'runtime/node.exe');
  const engine = path.join(payload, 'wisp-engine.exe');
  yield* fs.access(engine);
  const wow = path.join(temporary, 'fake WoW client');
  yield* fs.makeDirectory(wow);
  yield* fs.writeFileString(path.join(wow, 'Wow.exe'), '');
  yield* run(engine, ['scripts/install.ts', wow], '60 seconds', { cwd: payload, env });
  for (const relative of [
    'WispAI/WispAI.toc',
    'WispAI_B001/WispAI_B001.toc',
    'WispAI_S0001/WispAI_S0001.toc',
  ]) {
    const toc = yield* fs.readFileString(path.join(wow, 'Interface/AddOns', relative));
    if (addonVersionFromToc(toc) !== addonVersion) {
      return yield* failed(
        'Installed addon version does not match the expected release version: ' + relative,
      );
    }
  }
  // Files, not links or folders, as Dirent#isFile counts them.
  let payloadFiles = 0;
  for (const entry of yield* fs.readDirectory(payload, { recursive: true })) {
    if ((yield* fs.lstat(path.join(payload, entry))).type === 'File') {
      payloadFiles++;
    }
  }
  for (const name of ['node_modules', 'runtime/npm']) {
    yield* absent(path.join(payload, name), 'Installer extracted loose dependencies: ' + name);
  }
  const windows = (yield* environmentVariable('WINDIR')) || 'C:\\Windows';
  // Closing the scope stops the bridge and its children if it is still running.
  const bridge = yield* spawner.spawn(
    ChildProcess.make(engine, ['src/main.ts'], {
      cwd: payload,
      env: { ...env, PATH: path.dirname(node) + ';' + path.join(windows, 'System32') },
      extendEnv: true,
      detached: false,
      stdin: 'ignore',
    }),
  );
  const log = yield* Ref.make('');
  yield* bridge.all.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) => Ref.update(log, (previous) => (previous + text).slice(-8000))),
    Effect.ignore,
    Effect.forkScoped,
  );
  const exited = bridge.isRunning.pipe(
    Effect.map((running) => !running),
    Effect.orElseSucceed(() => false),
  );
  // The bridge reports ready once the in-process agent has loaded its tools and skills.
  yield* waitUntilReady(data, bridge.pid, exited, Ref.get(log));
  const identity = yield* Schema.decodeEffect(DesktopIdentity)(
    yield* fs.readFileString(path.join(data, 'runtime/desktop.json')),
  );
  if (identity.pid !== bridge.pid) {
    return yield* failed('Installer test reached a different bridge.');
  }
  const status = yield* client
    .get('http://127.0.0.1:' + identity.port + '/status', {
      headers: { authorization: 'Bearer ' + identity.token, 'content-type': 'application/json' },
    })
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthStatus)));
  if (status.auth.status !== 'signed_out') {
    return yield* failed('Fresh installation unexpectedly has an account.');
  }
  yield* run(executable, ['--prepare-update'], '60 seconds', { env });
  yield* bridge.exitCode.pipe(
    Effect.ignore,
    Effect.timeoutOrElse({
      duration: '20 seconds',
      orElse: () => Effect.fail(failed('Bridge shutdown timed out.')),
    }),
  );
  yield* fs.writeFileString(path.join(data, 'preserve-on-uninstall.txt'), 'keep user data');
  yield* fs.makeDirectory(path.join(payload, 'tests'), { recursive: true });
  yield* fs.writeFileString(
    path.join(payload, 'tests/retired-file.txt'),
    'obsolete application resource',
  );
  const upgradeStarted = yield* now;
  yield* run(installer, ['/S', '/UPDATE', '/D=' + target], '180 seconds', { env });
  const upgradeMilliseconds = (yield* now) - upgradeStarted;
  yield* fs.access(path.join(data, 'runtime/addon-update-pending'));
  const stages = updateStages(yield* fs.readFileString(path.join(data, 'runtime/update.log')));
  if (!requiredStages.every((stage) => stages.some((entry) => entry.stage === stage))) {
    return yield* failed('Upgrade did not record all installer stages.');
  }
  yield* absent(
    path.join(payload, 'tests/retired-file.txt'),
    'Upgrade retained a retired application resource.',
  );
  yield* run(executable, ['--self-test'], '30 seconds', { env });
  yield* fs.access(path.join(data, 'config.local.json'));
  yield* fs.access(path.join(data, 'runtime/wisp.sqlite'));
  yield* run(path.join(target, 'uninstall.exe'), ['/S', '_?=' + target], '120 seconds');
  yield* fs.access(path.join(data, 'preserve-on-uninstall.txt'));
  const report = {
    version,
    addonVersion,
    installer: true,
    protectedCredentials: true,
    bundledNode: true,
    packagedEngine: true,
    noLooseNodeModules: true,
    payloadFiles,
    installMilliseconds,
    upgradeMilliseconds,
    updateStages: stages,
    agentReady: true,
    independentSignIn: true,
    noPersonalData: true,
    userDataPreserved: true,
    upgradePreservesHistory: true,
    retiredResourcesRemoved: true,
  };
  yield* fs.writeFileString('dist/installer-smoke.json', JSON.stringify(report, null, 2));
  yield* Console.log(JSON.stringify(report));
}, Effect.scoped);

if (import.meta.main) {
  Command.make(
    'verify-installer',
    {
      installer: Argument.String('installer').pipe(
        Argument.withDescription('The installer to verify; the built one in dist/ when absent'),
        Argument.optional,
      ),
    },
    ({ installer }) => verifyInstaller(Option.getOrElse(installer, () => '')),
  ).pipe(
    Command.withDescription('Install, run, upgrade and uninstall a built installer'),
    Command.run({ version: '1.0.0' }),
    Effect.provide(fetchHttpClient),
    runScript,
  );
}
