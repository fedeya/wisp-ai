import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  assertProfileReady,
  claimDevelopmentTarget,
  developmentLayout,
  seedDevelopmentProfile,
} from './dev-profile.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
}).trim();
const layout = developmentLayout(root, common, process.env.WISP_SHARED_DATA_DIR);
const { id, data, shared, native } = layout;
const mode = process.argv[2] || 'info';
if (
  !['info', 'seed', 'target', 'bridge', 'addon', 'desktop'].includes(mode) ||
  process.argv.length !== (['seed', 'target'].includes(mode) ? 4 : process.argv[2] ? 3 : 2)
) {
  throw Error(
    'Usage: pnpm dev:instance [info|seed <source-data>|target <dedicated-wow>|bridge|addon|desktop]',
  );
}
let config: { wow: string; model?: string } = await readFile(
  path.join(data, 'config.local.json'),
  'utf8',
)
  .then(JSON.parse)
  .catch((error) => {
    if (error.code === 'ENOENT') {
      return { wow: layout.wow };
    }
    throw error;
  });
console.log(
  JSON.stringify(
    { instance: `Wisp Dev ${id}`, root, data, shared, addon: config.wow, native },
    null,
    2,
  ),
);
async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function child(args: string[], env: NodeJS.ProcessEnv, cwd = root) {
  await new Promise<void>((resolve, reject) => {
    const spawned = spawn(process.execPath, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    const stop = () => {
      if (!spawned.pid) {
        return;
      }
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(spawned.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } else {
          process.kill(-spawned.pid, 'SIGTERM');
        }
      } catch {
        /* The child may have already exited. */
      }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    spawned.once('error', reject);
    spawned.once('exit', (code) => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      if (code === 0) {
        resolve();
      } else {
        reject(Error('Development command exited with code ' + (code ?? 'signal')));
      }
    });
  });
}
// Keep info usable before dependencies are built. Product schemas import the
// protocol's generated JS, so build it before loading those schemas.
if (mode === 'seed') {
  await child(
    [
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      path.join(root, 'packages/protocol/tsconfig.build.json'),
    ],
    process.env,
  );
  await seedDevelopmentProfile(process.argv[3], shared);
  console.log('Shared profile seeded; the source application was preserved.');
} else if (mode !== 'info') {
  const { ApplicationDatabase } = await import('@wisp/bridge/db/application-database');
  const { sharedLock } = await import('@wisp/bridge/shared-lock');
  await assertProfileReady(shared);
  const database = new ApplicationDatabase(path.join(shared, 'runtime', 'wisp.sqlite'));
  const launcher = new ApplicationDatabase(path.join(data, 'instance.sqlite'));
  try {
    await sharedLock(launcher)(
      'instance:' + id,
      async () => {
        await child(
          [
            path.join(root, 'node_modules/typescript/bin/tsc'),
            '-p',
            path.join(root, 'packages/protocol/tsconfig.build.json'),
          ],
          process.env,
        );
        await mkdir(layout.wow, { recursive: true });
        await writeFile(path.join(layout.wow, 'Wow.exe'), '', { flag: 'a' });
        // Adopt only an existing synthetic fixture inside this worktree.
        const physical = await realpath(layout.wow);
        if (
          !physical.toLowerCase().startsWith((await realpath(root)).toLowerCase() + path.sep) ||
          (await stat(path.join(layout.wow, 'Wow.exe'))).size !== 0
        ) {
          throw Error('The sandbox WoW folder must be an empty fixture inside this worktree.');
        }
        try {
          await writeFile(path.join(layout.wow, '.wisp-dev-owner'), id, { flag: 'wx' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
          }
        }
        const wow = await claimDevelopmentTarget(
          mode === 'target' ? process.argv[3] : config.wow,
          id,
        );
        if (mode === 'target') {
          config = { ...config, wow };
        }
        const defaults = (await readFile(path.join(shared, 'defaults.json'), 'utf8')
          .then(JSON.parse)
          .catch((error) => {
            if (error.code === 'ENOENT') {
              return {};
            }
            throw error;
          })) as { model?: string };
        config = { ...defaults, ...config };
        await writeFile(path.join(data, 'config.local.json'), JSON.stringify(config, null, 2));
        if (mode === 'target') {
          return;
        }
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          WISP_DATA_DIR: data,
          WISP_SHARED_DATA_DIR: shared,
          WISP_DEV_INSTANCE: id,
          WISP_DEV_WOW_DIR: wow,
          WISP_RESOURCE_ROOT: root,
          WISP_EVE_PORT: String(await availablePort()),
          WISP_AGENT_PORT: '0',
          WISP_DESKTOP_PORT: '0',
          WISP_PAYLOAD_ROOT: root,
          WISP_DEV_NODE: process.execPath,
          WISP_DESKTOP_EXE: path.join(
            native,
            'debug',
            process.platform === 'win32' ? 'wisp.exe' : 'wisp',
          ),
          CARGO_TARGET_DIR: native,
        };
        delete env.WISP_ENGINE_EXECUTABLE;
        if (mode === 'addon') {
          return child([path.join(root, 'apps/bridge/scripts/install.ts'), wow], env);
        }
        await child(
          [
            path.join(root, 'node_modules/typescript/bin/tsc'),
            '-p',
            path.join(root, 'apps/agent/tsconfig.build.json'),
          ],
          env,
        );
        if (mode === 'bridge') {
          return sharedLock(database)(
            'port:' + env.WISP_EVE_PORT,
            () => child([path.join(root, 'apps/bridge/src/main.ts')], env),
            0,
          );
        }
        const cargoBin = path.join(homedir(), '.cargo', 'bin');
        const originalPath = process.env.PATH || '';
        for (const key of Object.keys(env)) {
          if (key.toLowerCase() === 'path') {
            delete env[key];
          }
        }
        env.PATH = [
          path.dirname(process.execPath),
          ...(process.platform === 'win32' && existsSync(path.join(cargoBin, 'cargo.exe'))
            ? [cargoBin]
            : []),
          originalPath,
        ].join(path.delimiter);
        try {
          execFileSync('cargo', ['--version'], { env, windowsHide: true, stdio: 'ignore' });
        } catch {
          throw Error('Install Rust and native build tools before running the desktop preview.');
        }
        const { verifySimulator } = await import('./verify-simulator.ts');
        await verifySimulator(root);
        const uiPort = await availablePort();
        const configPath = path.join(data, 'tauri.dev.json');
        const base = JSON.parse(
          await readFile(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
        );
        const branch = execFileSync('git', ['branch', '--show-current'], {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
        }).trim();
        await writeFile(
          configPath,
          JSON.stringify({
            identifier: `com.wisp.dev.i${id}`,
            productName: `Wisp Dev ${id}`,
            bundle: { resources: [] },
            build: { devUrl: `http://127.0.0.1:${uiPort}` },
            app: {
              windows: base.app.windows.map((window: Record<string, unknown>) => ({
                ...window,
                title: `Wisp Dev ${id} — ${branch}`,
              })),
            },
          }),
        );
        env.VITE_DEV_PORT = String(uiPort);
        delete env.WISP_RESOURCE_ROOT;
        const cwd = path.join(root, 'apps/desktop');
        env.WISP_EVE_PORT = String(await availablePort());
        if (Number(env.WISP_EVE_PORT) === uiPort) {
          env.WISP_EVE_PORT = String(await availablePort());
        }
        await sharedLock(database)(
          'port:' + env.WISP_EVE_PORT,
          () =>
            sharedLock(database)(
              'port:' + uiPort,
              () =>
                child(
                  [
                    path.join(cwd, 'node_modules/@tauri-apps/cli/tauri.js'),
                    'dev',
                    '--config',
                    configPath,
                  ],
                  env,
                  cwd,
                ),
              0,
            ),
          0,
        );
      },
      0,
    );
  } finally {
    await launcher.close();
    await database.close();
  }
}
