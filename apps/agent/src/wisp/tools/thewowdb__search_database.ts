import { defineTool } from '@wisp/agent/tool';
import { databaseSearch } from '../../contract/database.ts';
import { enabledTool } from '@wisp/agent/enabled-tool';

export default enabledTool(
  'search_database',
  defineTool({
    deferred: false,
    description:
      'Primary external catalog: search TheWoWDB for Forever items, spells, quests, NPCs or zones by name. Version is fixed to Forever by Wisp. Search first to resolve IDs, then thewowdb__get_database_entity for details. Preserve attribution, source links and build; missing results are missing coverage, not proof of absence.',
    inputSchema: databaseSearch,
    label: {
      start: ({ kind }) => 'Searching Forever ' + kind + ' database',
      complete: ({ kind }) => 'Searched Forever ' + kind + ' database',
    },
    execute: (args, ctx) => ctx.host('database', { operation: 'search', ...args }),
  }),
);
