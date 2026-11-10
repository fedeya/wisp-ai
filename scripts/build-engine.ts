import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { findNpmDirectory } from './node-runtime.ts';

export async function buildEngine() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw Error('Engine packaging currently supports Windows x64.');
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const require = createRequire(import.meta.url);
  const directory = path.join(root, 'dist/engine-build');
  if (directory !== path.resolve(root, 'dist', 'engine-build')) {
    throw Error('Invalid engine build directory.');
  }
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  execFileSync(
    process.execPath,
    [require.resolve('eve/package.json').replace(/package\.json$/, 'bin/eve.js'), 'build'],
    {
      cwd: path.join(root, 'apps/agent'),
      windowsHide: true,
      stdio: 'inherit',
    },
  );
  await cp(path.join(root, 'apps/agent/.output/server'), path.join(directory, 'eve'), {
    recursive: true,
  });
  await cp(
    path.join(directory, 'eve/node_modules/undici'),
    path.join(directory, 'node_modules/undici'),
    { recursive: true },
  );
  await cp(await findNpmDirectory(), path.join(directory, 'npm'), { recursive: true });
  await build({
    absWorkingDir: root,
    entryPoints: {
      bridge: 'apps/bridge/src/main.ts',
      install: 'apps/bridge/scripts/install.ts',
      'migrate-desktop': 'apps/bridge/scripts/migrate-desktop.ts',
    },
    outdir: directory,
    outExtension: { '.js': '.mjs' },
    platform: 'node',
    target: 'node24',
    format: 'esm',
    bundle: true,
    banner: {
      js: "import { createRequire as __wispCreateRequire } from 'node:module'; const require = __wispCreateRequire(import.meta.url);",
    },
  });
  await cp(path.join(root, 'scripts/engine-entry.mjs'), path.join(directory, 'engine.mjs'));
  await cp(path.join(root, 'apps/bridge/src/db/migrations'), path.join(directory, 'migrations'), {
    recursive: true,
  });
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify(
      {
        name: 'wisp-engine',
        version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
        private: true,
        type: 'module',
        bin: 'engine.mjs',
        pkg: {
          assets: ['*.mjs', 'migrations/**/*', 'eve/**/*', 'node_modules/**/*', 'npm/**/*'],
          sea: true,
          compress: 'GZip',
          targets: [`node${process.versions.node}-win-x64`],
        },
      },
      null,
      2,
    ),
  );
  execFileSync(
    process.execPath,
    [
      require.resolve('@yao-pkg/pkg/lib-es5/bin.js'),
      '.',
      '--output',
      path.join(root, 'dist/wisp-engine.exe'),
    ],
    {
      // pkg embeds absolute asset paths; use the physical directory when dist
      // is a Windows junction so the entry point and assets share one root.
      cwd: await realpath(directory),
      windowsHide: true,
      stdio: 'inherit',
    },
  );
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      'tests/vitest.config.ts',
      'tests/agent-integration.test.ts',
      'tests/packaged-engine.test.ts',
    ],
    {
      cwd: root,
      windowsHide: true,
      stdio: 'inherit',
      env: { ...process.env, WISP_TEST_ENGINE_EXECUTABLE: path.join(root, 'dist/wisp-engine.exe') },
    },
  );
  return path.join(root, 'dist/wisp-engine.exe');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildEngine();
}
