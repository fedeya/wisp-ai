import { execFileSync, spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stageEngine, stageTauri } from './stage-tauri.ts';
import { buildEngine } from './build-engine.ts';
import { createRequire } from 'node:module';
import { writeUpdateManifest } from './update-manifest.ts';
import {
  nativeBuildContext,
  nativeBuildKey,
  restoreNativeBinary,
  saveNativeBinary,
} from './native-cache.ts';
const desktop = path.resolve('apps/desktop');
const require = createRequire(path.join(desktop, 'package.json'));
const cli = require.resolve('@tauri-apps/cli/tauri.js');
const tauriOptions = {
  windowsHide: true,
  stdio: 'inherit',
  cwd: desktop,
  env: {
    ...process.env,
    PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || ''),
  },
} as const;
function tauri(args: string[]) {
  execFileSync(process.execPath, [cli, ...args], tauriOptions);
}
// Runs in the background, so other work can proceed while Tauri compiles.
function startTauri(args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], tauriOptions);
  const finished = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(Error('tauri ' + args[0] + ' failed: ' + (signal || 'exit code ' + code))),
    );
  });
  return { child, finished };
}
const task = process.env.npm_lifecycle_event;
if (task === 'package:windows' && process.platform !== 'win32') {
  throw Error('package:windows runs on Windows.');
}
if (task === 'package:linux' && process.platform !== 'linux') {
  throw Error('package:linux runs on Linux.');
}
const hostBinary = process.platform === 'win32' ? 'wisp.exe' : 'wisp';
const started = performance.now();
// Stages everything but the engine, which builds while the native executable compiles.
await stageTauri({ packaged: true });
const staged = performance.now();
// Build the frontend first: its actual output, including VITE_* substitutions,
// belongs to the cache key because Tauri embeds it in the native executable.
execFileSync(
  process.execPath,
  [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build'],
  {
    cwd: desktop,
    windowsHide: true,
    stdio: 'inherit',
  },
);
const frontendBuilt = performance.now();
const context = nativeBuildContext();
const key = await nativeBuildKey(process.cwd(), context);
const cache = path.resolve('node_modules/.cache/wisp-native');
const executable = path.join(desktop, 'src-tauri/target/release', hostBinary);
// Custom Tauri overrides may reference inputs outside the checked-in project.
// They always use a fresh build rather than risk reusing the wrong executable.
const cacheable = !process.env.TAURI_CONFIG;
const reused =
  cacheable &&
  process.env.WISP_FORCE_NATIVE_BUILD !== '1' &&
  (await restoreNativeBinary(cache, key, executable));
// The native executable does not embed the payload: the bundle step reads it from
// the source tree, as when a cached executable is reused. So the engine builds
// while Rust compiles, and joins the payload only after the compiler is done with it.
const native = reused ? undefined : startTauri(['build', '--no-bundle', '--', '--locked']);
let engine: string;
try {
  engine = await buildEngine();
} catch (error) {
  native?.child.kill();
  throw error;
}
const engineBuilt = performance.now();
if (native) {
  await native.finished;
  if (cacheable) {
    if (key !== (await nativeBuildKey(process.cwd(), context))) {
      throw Error('Native build inputs changed during compilation. No binary was cached.');
    }
    await saveNativeBinary(cache, key, executable);
  }
}
const nativeBuilt = performance.now();
await stageEngine(engine);
const nativeBinarySha256 = createHash('sha256')
  .update(await readFile(executable))
  .digest('hex');
// Always assemble current bridge/agent/addon/simulator resources. Only the
// unchanged, fully optimized native executable may be reused.
const signed = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY);
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
if (process.platform === 'win32') {
  tauri([
    'bundle',
    '--bundles',
    'nsis',
    '--config',
    JSON.stringify({ bundle: { createUpdaterArtifacts: signed } }),
  ]);
} else if (process.platform === 'linux') {
  tauri([
    'bundle',
    '--bundles',
    'appimage,deb',
    '--config',
    JSON.stringify({ bundle: { createUpdaterArtifacts: signed } }),
  ]);
} else {
  throw Error('Desktop packaging supports Windows and Linux.');
}
const bundled = performance.now();
await mkdir('dist', { recursive: true });
const metricsName =
  process.platform === 'linux' ? 'build-metrics-linux.json' : 'build-metrics.json';
await writeFile(
  'dist/' + metricsName,
  JSON.stringify(
    {
      nativeCacheHit: Boolean(reused),
      nativeInputsKey: key,
      nativeBinarySha256,
      milliseconds: {
        stage: staged - started,
        frontend: frontendBuilt - staged,
        // The engine and native executable build at the same time.
        engine: engineBuilt - frontendBuilt,
        native: nativeBuilt - frontendBuilt,
        bundle: bundled - nativeBuilt,
        total: bundled - started,
      },
    },
    null,
    2,
  ),
);
const destinations = await publishBundles(version, signed);
for (const destination of destinations) {
  console.log(destination);
}

async function publishBundles(version: string, signed: boolean) {
  if (process.platform === 'win32') {
    const folder = 'apps/desktop/src-tauri/target/release/bundle/nsis';
    const source = await soleBundle(folder, '.exe', (file) => file.endsWith('-setup.exe'));
    const destination = 'dist/WispAI-' + version + '-windows-x64-setup.exe';
    await publishOne(source, destination, signed);
    if (signed) {
      await writeUpdateManifest(version, destination);
    }
    return [destination];
  }
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : '';
  if (!arch) {
    throw Error('Linux packaging supports x64 and arm64.');
  }
  const root = 'apps/desktop/src-tauri/target/release/bundle';
  const appImage = await soleBundle(path.join(root, 'appimage'), '.AppImage');
  const deb = await soleBundle(path.join(root, 'deb'), '.deb');
  const appDestination = `dist/WispAI-${version}-linux-${arch}.AppImage`;
  const debDestination = `dist/WispAI-${version}-linux-${arch}.deb`;
  await publishOne(appImage, appDestination, signed);
  await chmod(appDestination, 0o755);
  // Tauri signs the AppImage for the updater. The .deb is installed by the
  // system package manager and has no updater signature.
  await publishOne(deb, debDestination, false);
  return [appDestination, debDestination];
}

async function soleBundle(
  folder: string,
  extension: string,
  accept = (file: string) => file.endsWith(extension),
) {
  const files = (await readdir(folder)).filter(
    (file) => accept(file) && !file.endsWith(extension + '.sig'),
  );
  const [file] = files;
  if (files.length !== 1 || !file) {
    throw Error(`Expected one ${extension} bundle in ${folder}.`);
  }
  return path.join(folder, file);
}

async function publishOne(source: string, destination: string, signed: boolean) {
  await copyFile(source, destination);
  if (signed) {
    await copyFile(source + '.sig', destination + '.sig');
  }
  const hash = createHash('sha256')
    .update(await readFile(destination))
    .digest('hex');
  await writeFile(destination + '.sha256', hash + '  ' + path.basename(destination) + '\n');
}
