import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, cp, access, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  SLOT_COUNT,
  BIT_COUNT,
  addonHelperTocs,
  initialAddonPayload,
} from '@wisp/protocol/addon-helpers';
import { migrateGameSaves, retireLegacyAddons } from '../src/migrations/addon-rename.ts';
import { appPaths } from '../src/app-paths.ts';
import { addonVersionFromToc } from '../src/addon-version.ts';
const root = process.env.WISP_RESOURCE_ROOT || fileURLToPath(new URL('../../../', import.meta.url));
const paths = appPaths(root);
await mkdir(paths.runtime, { recursive: true });
const wow = process.argv[2];
if (!wow) {
  throw Error('Choose the WoW client folder.');
}
await access(path.join(wow, 'Wow.exe'));
const addons = path.join(wow, 'Interface', 'AddOns');
await mkdir(addons, { recursive: true });
await migrateGameSaves(wow);
const source = path.join(root, 'addon', 'WispAI');
const toc = await readFile(path.join(source, 'WispAI.toc'), 'utf8');
const addonVersion = addonVersionFromToc(toc);
const payloadDir = path.join(addons, 'WispAI_Payload');
await mkdir(payloadDir, { recursive: true });
const payloadFile = path.join(payloadDir, 'Payload.lua');
const payloadTemporary = payloadFile + '.' + randomUUID() + '.tmp';
try {
  await writeFile(payloadTemporary, initialAddonPayload);
  // The game may load the payload during installation. Publish it in one rename.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(payloadTemporary, payloadFile);
      break;
    } catch (error) {
      if (attempt >= 5) {
        throw error;
      }
      await delay(30);
    }
  }
} catch (error) {
  await rm(payloadTemporary, { force: true }).catch(() => {});
  throw error;
}
for (const helper of addonHelperTocs(addonVersion)) {
  const directory = path.join(addons, helper.name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${helper.name}.toc`), helper.toc);
}
// Complete the helpers before Desktop can see the new main addon on disk.
await cp(source, path.join(addons, 'WispAI'), { recursive: true });
if (!process.argv.slice(3).includes('--skip-config')) {
  let config: { wow: string; model?: string } = { wow };
  try {
    config = { ...JSON.parse(await readFile(paths.config, 'utf8')), wow };
  } catch {}
  await writeFile(paths.config, JSON.stringify(config, null, 2) + '\n');
}
const retired = await retireLegacyAddons(wow);
if (retired.count) {
  console.log('Previous addon installation backed up to ' + retired.backup);
}
console.log(
  `Wisp installed in ${addons}. ${SLOT_COUNT} channels, ${BIT_COUNT} bits. Restart WoW to discover the new files.`,
);
