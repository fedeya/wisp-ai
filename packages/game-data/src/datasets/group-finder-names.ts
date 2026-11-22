import type { Dataset } from '../dataset.ts';
import type { LuaTable } from '../lua.ts';
import { num, str } from '../rows.ts';

const DUNGEONS = 2; // GroupFinderCategoryID for dungeons

// English names of the group finder's dungeon activities, wings included, so
// the addon can match English names on a localized client, where the game
// only returns the client's language.
export function groupFinderNames(): Dataset {
  return {
    name: 'group-finder-names',
    description: 'Group finder dungeon activity ID -> English name.',
    tables: ['GroupFinderActivity'],
    output: {
      format: 'lua',
      path: 'addon/WispAI/Data/GroupFinderNames.lua',
      name: 'GroupFinderNames',
    },
    async build(tables) {
      const value: LuaTable = {};
      for (const row of await tables.read('GroupFinderActivity')) {
        if (num(row, 'GroupFinderCategoryID') === DUNGEONS) {
          value[str(row, 'ID')] = str(row, 'FullName_lang');
        }
      }
      return value;
    },
  };
}
