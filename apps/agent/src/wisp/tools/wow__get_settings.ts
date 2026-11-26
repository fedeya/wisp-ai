import { defineTool } from '@wisp/agent/tool';
import { enabledTool } from '@wisp/agent/enabled-tool';
import { runGame } from '../../tools/game-tool.ts';
import { settingsRead } from '../../contract/settings.ts';
export default enabledTool(
  'get_settings',
  defineTool({
    deferred: true,
    description:
      'Discovers and reads live game CVars, registered AceConfig addon options, installed addons, keybindings and action bar contents. Use sections, addon, query or exact opaque IDs with pagination. Only registered/loaded options are discoverable. Missing settings require a Wisp integration, never source edits or guessing global variables. Bars and bindings are read-only.',
    inputSchema: settingsRead,
    label: { start: () => 'Reading settings', complete: () => 'Read settings' },
    execute: (args, ctx) => runGame(ctx, (game) => game.readSettings(ctx.session.id, args)),
  }),
);
