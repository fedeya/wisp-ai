import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import path from 'node:path';
import { cp, mkdir, readFile, realpath, lstat, symlink, unlink, rm } from 'node:fs/promises';

export function appPaths(root: string, data = process.env.WISP_DATA_DIR) {
  const dataRoot = data ? path.resolve(data) : root;
  const agent = process.env.WISP_ENGINE_EXECUTABLE
    ? path.join(dataRoot, 'engine')
    : path.dirname(fileURLToPath(import.meta.resolve('@wisp/agent/package.json')));
  return {
    root,
    agent,
    dataRoot,
    runtime: path.join(dataRoot, 'runtime'),
    config: path.join(dataRoot, 'config.local.json'),
    engine: data ? path.join(dataRoot, 'engine') : agent,
    simulatorExecutable: path.join(root, 'simulator', 'wowsimcli.exe'),
    desktopExecutable:
      process.env.WISP_DESKTOP_EXE ||
      path.join(
        root,
        'apps',
        'desktop',
        'src-tauri',
        'target',
        'release',
        process.platform === 'win32' ? 'wisp.exe' : 'wisp',
      ),
  };
}

export async function prepareEngine(root: string, engine: string) {
  if (root === engine) {
    await mkdir(engine, { recursive: true });
    if (process.env.WISP_ENGINE_EXECUTABLE) {
      // Older installers copied authored code and dependency junctions here.
      // Retire only that marked application code; keep Eve's durable .eve data.
      const marker = path.join(engine, 'package.json');
      let legacy = false;
      try {
        legacy = JSON.parse(await readFile(marker, 'utf8')).name === '@wisp/agent';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      if (legacy) {
        for (const name of ['src', 'agent', 'dist', 'node_modules', 'package.json']) {
          const target = path.resolve(engine, name);
          if (path.dirname(target) !== path.resolve(engine)) {
            throw Error('Invalid legacy engine directory.');
          }
          await rm(target, { recursive: true, force: true });
        }
      }
    }
    return;
  }
  await mkdir(engine, { recursive: true });
  for (const name of ['src', 'agent', 'dist', 'package.json']) {
    if (name !== 'package.json') {
      const target = path.resolve(engine, name);
      if (path.dirname(target) !== path.resolve(engine) || target === path.resolve(root)) {
        throw Error('Invalid engine code directory.');
      }
      await rm(target, { recursive: true, force: true });
    }
    await cp(path.join(root, name), path.join(engine, name), { recursive: true });
  }
  const manifest = z
    .object({
      dependencies: z
        .record(
          z.string().regex(/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/),
          z.string(),
        )
        .default({}),
    })
    .parse(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')));
  const dependencies = new Map<string, string>();
  for (const name of Object.keys(manifest.dependencies)) {
    let directory = path.resolve(root);
    while (true) {
      try {
        dependencies.set(name, await realpath(path.join(directory, 'node_modules', name)));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        throw Error('Cannot locate agent dependency: ' + name);
      }
      directory = parent;
    }
  }
  // Resolve each package before linking it. A junction to an isolated node_modules
  // relocates its relative pnpm links on Windows and makes the agent unloadable.
  const directory = path.resolve(engine, 'node_modules');
  if (path.dirname(directory) !== path.resolve(engine)) {
    throw Error('Invalid engine dependency directory.');
  }
  try {
    if ((await lstat(directory)).isSymbolicLink()) {
      await unlink(directory);
    } else {
      await rm(directory, { recursive: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  await mkdir(directory, { recursive: true });
  for (const [name, target] of dependencies) {
    const link = path.join(directory, name);
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
}
