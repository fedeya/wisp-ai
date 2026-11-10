import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { releaseChannel } from '@wisp/releases';

// Stamp only the staged copy: authored addon sources remain development builds.
export async function stampAddonVersions(directory: string, version: string): Promise<void> {
  releaseChannel(version);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await stampAddonVersions(file, version);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.toc')) {
      const source = await readFile(file, 'utf8');
      const stamped = source.replace(
        /^(##[\t ]*Version:[\t ]*)[^\r\n]*/gm,
        (_match, prefix: string) => prefix + version,
      );
      if (stamped !== source) {
        await writeFile(file, stamped);
      }
    }
  }
}
