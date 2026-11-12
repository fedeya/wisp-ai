import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, cp, access, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { SLOT_COUNT, BIT_COUNT, luaJson } from '@wisp/protocol/protocol';
import { migrateGameSaves, retireLegacyAddons } from '../src/rename-migration.ts';
import { appPaths } from '../src/app-paths.ts';
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
await cp(path.join(root, 'addon', 'WispAI'), path.join(addons, 'WispAI'), { recursive: true });
const toc = await readFile(path.join(addons, 'WispAI', 'WispAI.toc'), 'utf8');
const addonVersion = toc.match(/^##[\t ]*Version:[\t ]*([^\r\n]+)/m)?.[1].trim();
const versionHeader = addonVersion ? `## Version: ${addonVersion}\n` : '';
const payloadDir = path.join(addons, 'WispAI_Payload');
await mkdir(payloadDir, { recursive: true });
const payloadFile = path.join(payloadDir, 'Payload.lua');
const payloadTemporary = payloadFile + '.' + randomUUID() + '.tmp';
try {
  await writeFile(
    payloadTemporary,
    luaJson(JSON.stringify({ v: 1, session: '', connected: false })),
  );
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
for (let n = 1; n <= BIT_COUNT; n++) {
  const name = `WispAI_B${String(n).padStart(3, '0')}`;
  await mkdir(path.join(addons, name), { recursive: true });
  await writeFile(
    path.join(addons, name, name + '.toc'),
    `## Interface: 16001\n## Title: Wisp bit ${n}\n${versionHeader}## Group: WispAI\n## LoadOnDemand: 1\n`,
  );
}
for (let n = 1; n <= SLOT_COUNT; n++) {
  const name = `WispAI_S${String(n).padStart(4, '0')}`;
  await mkdir(path.join(addons, name), { recursive: true });
  await writeFile(
    path.join(addons, name, name + '.toc'),
    `## Interface: 16001\n## Title: Wisp canal ${n}\n${versionHeader}## Group: WispAI\n## DefaultState: enabled\n## LoadOnDemand: 1\n## Dependencies: WispAI\n\n..\\WispAI_Payload\\Payload.lua\n`,
  );
}
let config: { wow: string; model?: string } = { wow };
try {
  config = { ...JSON.parse(await readFile(paths.config, 'utf8')), wow };
} catch {}
await writeFile(paths.config, JSON.stringify(config, null, 2) + '\n');
const retired = await retireLegacyAddons(wow);
if (retired.count) {
  console.log('Previous addon installation backed up to ' + retired.backup);
}
console.log(
  `Wisp installed in ${addons}. ${SLOT_COUNT} channels, ${BIT_COUNT} bits. Restart WoW to discover the new files.`,
);
