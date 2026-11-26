import path from 'node:path';
import { rm } from 'node:fs/promises';

export function appPaths(root: string, data = process.env.WISP_DATA_DIR) {
  const dataRoot = data ? path.resolve(data) : root;
  return {
    root,
    dataRoot,
    runtime: path.join(dataRoot, 'runtime'),
    config: path.join(dataRoot, 'config.local.json'),
    /**
     * Where earlier versions kept the Eve engine: a copy of the agent and its
     * session store. Only a separate data folder ever held one.
     */
    legacyEngine: data ? path.join(dataRoot, 'engine') : undefined,
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

/**
 * Removes the Eve engine folder left by earlier versions. The agent now runs in
 * the bridge and keeps its history next to the conversations, so the old
 * sessions there can no longer be resumed.
 */
export async function retireLegacyEngine(directory: string | undefined) {
  if (directory && path.basename(directory) === 'engine') {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}
