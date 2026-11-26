import { readdir, readFile, writeFile, mkdir, rename, access, lstat } from 'node:fs/promises';
import path from 'node:path';
// One-time import. Existing Wisp data always wins; original saves stay available.
export async function migrateGameSaves(wow: string) {
  const account = path.join(wow, 'WTF', 'Account');
  let count = 0;
  async function visit(directory: string) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw e;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isFile() && /^WoWCompanion\.lua(?:\.bak)?$/.test(entry.name)) {
        const target = path.join(directory, entry.name.replace('WoWCompanion', 'WispAI'));
        try {
          await access(target);
          continue;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw e;
          }
        }
        const data = (await readFile(file, 'utf8')).replace(/^WoWCompanionDB\s*=/m, 'WispAIDB =');
        await writeFile(target, data, { flag: 'wx' });
        count++;
      } else if (entry.isFile() && entry.name === 'bindings-cache.wtf') {
        const data = await readFile(file, 'utf8');
        const next = data.replace(/\bWOWCOMPANION_INLINE\b/g, 'WISPAI_INLINE');
        if (next !== data) {
          try {
            await writeFile(file + '.before-wisp', data, { flag: 'wx' });
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
              throw e;
            }
          }
          await writeFile(file, next);
          count++;
        }
      }
    }
  }
  await visit(account);
  return count;
}
export async function retireLegacyAddons(wow: string) {
  const addons = path.resolve(wow, 'Interface', 'AddOns'),
    backup = path.resolve(wow, 'Interface', 'WispAI-RenameBackup', String(Date.now()));
  let count = 0;
  for (const entry of await readdir(addons, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^WoWCompanion(?:_Payload|_B\d{3}|_S\d{4})?$/.test(entry.name)) {
      continue;
    }
    const source = path.resolve(addons, entry.name),
      target = path.resolve(backup, entry.name);
    if (path.dirname(source) !== addons || path.dirname(target) !== backup) {
      throw Error('Unsafe addon migration target');
    }
    if ((await lstat(source)).isSymbolicLink()) {
      throw Error('Cannot migrate a linked addon directory');
    }
    await mkdir(backup, { recursive: true });
    await rename(source, target);
    count++;
  }
  return { count, backup: count ? backup : null };
}
