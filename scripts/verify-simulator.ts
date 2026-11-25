import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { adapters } from '../apps/bridge/src/integrations/simulation/adapters/index.ts';

export async function verifySimulator(root: string, options: { requireBinary?: boolean } = {}) {
  const requireBinary = options.requireBinary ?? process.platform === 'win32';
  const directory = path.join(root, 'simulator');
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  let binary: Buffer | undefined;
  try {
    binary = await readFile(path.join(directory, 'wowsimcli.exe'));
  } catch (error) {
    if (requireBinary || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  if (
    !/^[a-f0-9]{40}$/.test(manifest.commit) ||
    (binary &&
      (!binary.length || createHash('sha256').update(binary).digest('hex') !== manifest.sha256))
  ) {
    throw Error('Simulator binary does not match its pinned manifest.');
  }
  if (requireBinary && !binary) {
    throw Error('Simulator binary does not match its pinned manifest.');
  }
  if (!Array.isArray(JSON.parse(await readFile(path.join(directory, 'items.json'), 'utf8')))) {
    throw Error('Invalid simulator metadata: items.json');
  }
  const classes = JSON.parse(await readFile(path.join(directory, 'classes.json'), 'utf8'));
  for (const adapter of Object.values(adapters)) {
    const metadata = classes[adapter.token];
    if (
      !manifest.supportedClasses?.includes(adapter.token) ||
      !Array.isArray(metadata?.talents) ||
      metadata.talents.length !== 3 ||
      metadata.talents.some((tree: { row?: number }[]) =>
        tree.some((t) => !Number.isInteger(t.row) || t.row! < 0),
      ) ||
      adapter.families.some((f) => !metadata.ranks?.[f]?.length)
    ) {
      throw Error('Invalid simulator class metadata: ' + adapter.token);
    }
  }
}
