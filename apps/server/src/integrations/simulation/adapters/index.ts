import { mage } from './mage.ts';
import { warrior } from './warrior.ts';
import { rogue } from './rogue.ts';
import { hunter } from './hunter.ts';
import { paladin } from './paladin.ts';
import { priest } from './priest.ts';
import { shaman } from './shaman.ts';
import { warlock } from './warlock.ts';
import { druid } from './druid.ts';
import type { ClassAdapter } from './types.ts';
export const adapters: Record<string, ClassAdapter> = Object.fromEntries(
  [mage, warrior, rogue, hunter, paladin, priest, shaman, warlock, druid].map((a) => [a.token, a]),
);
