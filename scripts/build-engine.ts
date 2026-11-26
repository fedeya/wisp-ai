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
  // The agent's authored instructions and skills ship as assets; its tools are bundled.
  await cp(
    path.join(root, 'apps/agent/src/wisp/instructions.md'),
    path.join(directory, 'agent/instructions.md'),
  );
  await cp(path.join(root, 'apps/agent/src/wisp/skills'), path.join(directory, 'agent/skills'), {
    recursive: true,
  });
  await cp(await findNpmDirectory(), path.join(directory, 'npm'), { recursive: true });
  // impit (web_fetch's TLS client) loads a native addon, so it ships beside the
  // bundle instead of inside it.
  const impit = path.dirname(
    createRequire(path.join(root, 'apps/agent/package.json')).resolve('impit/package.json'),
  );
  const impitNative = path.dirname(
    createRequire(path.join(impit, 'package.json')).resolve('impit-win32-x64-msvc/package.json'),
  );
  for (const [source, name] of [
    [impit, 'impit'],
    [impitNative, 'impit-win32-x64-msvc'],
  ]) {
    await cp(source, path.join(directory, 'node_modules', name), {
      recursive: true,
      dereference: true,
    });
  }
  await build({
    absWorkingDir: root,
    entryPoints: {
      server: 'apps/server/src/main.ts',
      install: 'apps/server/scripts/install.ts',
      'migrate-desktop': 'apps/server/scripts/migrate-desktop.ts',
      // The self-test reads the agent's content with the code the bridge uses.
      'agent-content': 'scripts/engine-content.ts',
    },
    outdir: directory,
    outExtension: { '.js': '.mjs' },
    platform: 'node',
    target: 'node24',
    format: 'esm',
    bundle: true,
    external: ['impit'],
    banner: {
      js: "import { createRequire as __wispCreateRequire } from 'node:module'; const require = __wispCreateRequire(import.meta.url);",
    },
  });
  await cp(path.join(root, 'scripts/engine-entry.mjs'), path.join(directory, 'engine.mjs'));
  await cp(path.join(root, 'apps/server/src/db/migrations'), path.join(directory, 'migrations'), {
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
          assets: ['*.mjs', 'migrations/**/*', 'agent/**/*', 'node_modules/**/*', 'npm/**/*'],
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
