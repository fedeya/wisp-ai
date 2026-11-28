import { cp, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySimulator } from './simulator/verify.ts';
import { findNpmDirectory } from './engine/node-runtime.ts';

function payloadDirectory(root: string) {
  const stage = path.resolve(root, 'apps/desktop/src-tauri/resources/payload');
  if (stage !== path.join(root, 'apps', 'desktop', 'src-tauri', 'resources', 'payload')) {
    throw Error('Invalid payload directory.');
  }
  return stage;
}

export async function stageTauri({ packaged = false } = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const stage = payloadDirectory(root);
  // The addon version scripts run on Effect; this module calls them as commands.
  const addonVersionScript = path.join(root, 'scripts/addon-release-version.ts');
  const addonVersion = packaged
    ? execFileSync(process.execPath, [addonVersionScript, 'version'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      }).trim()
    : undefined;
  await verifySimulator(root);
  await rm(stage, { recursive: true, force: true });
  // Hoisting is restricted to the standalone deployment: Windows installer resources
  // must contain real directories, without junctions back to the developer's store.
  if (packaged) {
    // The packaged engine is added afterwards with stageEngine, so it can build
    // while the native executable compiles.
    await mkdir(stage, { recursive: true });
  } else {
    const executable = process.env.npm_execpath || 'pnpm';
    const args = [
      '--filter',
      '@wisp/server',
      '--prod',
      'deploy',
      '--legacy',
      '--ignore-scripts',
      '--config.node-linker=hoisted',
      stage,
    ];
    const javascript = /\.(?:c?js|mjs)$/.test(executable);
    execFileSync(
      javascript ? process.execPath : executable,
      javascript ? [executable, ...args] : args,
      { cwd: root, windowsHide: true, stdio: 'inherit' },
    );
  }
  for (const name of ['addon/WispAI', 'simulator']) {
    await cp(path.join(root, name), path.join(stage, name), { recursive: true });
  }
  if (addonVersion) {
    execFileSync(
      process.execPath,
      [addonVersionScript, 'stamp', path.join(stage, 'addon/WispAI/WispAI.toc'), addonVersion],
      { cwd: root, windowsHide: true, stdio: 'inherit' },
    );
  }
  for (const name of ['LICENSE', 'NOTICE']) {
    await copyFile(path.join(root, name), path.join(stage, name));
  }
  await mkdir(path.join(stage, 'runtime'), { recursive: true });
  await copyFile(
    process.execPath,
    path.join(stage, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  // npm remains available for user-configured npx MCP servers. It is not used
  // to install Wisp or to assemble its dependency graph.
  if (!packaged) {
    await cp(await findNpmDirectory(), path.join(stage, 'runtime/npm'), { recursive: true });
  }
  const license = await fetch(
    'https://raw.githubusercontent.com/nodejs/node/v' + process.versions.node + '/LICENSE',
  );
  if (!license.ok) {
    throw Error('Cannot obtain the bundled Node license.');
  }
  await writeFile(path.join(stage, 'runtime/NODE-LICENSE.txt'), await license.text());
  await writeFile(
    path.join(stage, 'BUILD.json'),
    JSON.stringify(
      {
        version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
      null,
      2,
    ),
  );
  console.log(
    'Staged the Wisp server and its dependencies without personal data or desktop build tools.',
  );
}

// Adds the packaged engine to a payload staged with stageTauri({ packaged: true }).
export async function stageEngine(executable: string) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const stage = payloadDirectory(root);
  await copyFile(executable, path.join(stage, 'wisp-engine.exe'));
  // The engine bundles Effect, which the agent runs on; ship its license beside it.
  const effect = path.dirname(fileURLToPath(import.meta.resolve('effect/package.json')));
  await copyFile(path.join(effect, 'LICENSE'), path.join(stage, 'EFFECT-LICENSE.txt'));
  await writeFile(
    path.join(stage, 'package.json'),
    JSON.stringify({
      name: '@wisp/engine-payload',
      version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
    }),
  );
}
