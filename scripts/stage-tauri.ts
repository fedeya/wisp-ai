import { cp, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySimulator } from './verify-simulator.ts';
import { findNpmDirectory } from './node-runtime.ts';
import { addonReleaseVersion, stampAddonReleaseVersion } from './addon-release-version.ts';
import { engineExecutableName } from './build-engine.ts';
import { runtimeNodeName } from '../apps/bridge/src/runtime-node.mjs';

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
  const addonVersion = packaged ? addonReleaseVersion(root) : undefined;
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
      '@wisp/bridge',
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
    await stampAddonReleaseVersion(path.join(stage, 'addon/WispAI/WispAI.toc'), addonVersion);
  }
  for (const name of ['LICENSE', 'NOTICE']) {
    await copyFile(path.join(root, name), path.join(stage, name));
  }
  await mkdir(path.join(stage, 'runtime'), { recursive: true });
  await copyFile(process.execPath, path.join(stage, 'runtime', runtimeNodeName()));
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
    'Deployed production bridge, agent and protocol without personal data or desktop build tools.',
  );
}

// Adds the packaged engine to a payload staged with stageTauri({ packaged: true }).
export async function stageEngine(executable: string) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const stage = payloadDirectory(root);
  await copyFile(executable, path.join(stage, engineExecutableName()));
  const eve = path.dirname(fileURLToPath(import.meta.resolve('eve/package.json')));
  await copyFile(path.join(eve, 'LICENSE'), path.join(stage, 'EVE-LICENSE.txt'));
  await copyFile(path.join(eve, 'NOTICE'), path.join(stage, 'EVE-NOTICE.txt'));
  await writeFile(
    path.join(stage, 'package.json'),
    JSON.stringify({
      name: '@wisp/engine-payload',
      version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
    }),
  );
}
