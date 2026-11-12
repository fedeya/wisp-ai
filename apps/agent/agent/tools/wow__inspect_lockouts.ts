import { defineTool } from 'eve/tools';
import { lockoutsInput, lockoutsReading } from '@wisp/protocol/lockouts';
import { agentRPC } from '@wisp/agent/agent-rpc';
import { enabledTool } from '@wisp/agent/enabled-tool';

export default enabledTool(
  'inspect_lockouts',
  defineTool({
    deferred: true,
    description:
      'Read this character’s already-cached saved instance lockouts, native difficulty names/IDs, lock/extension flags and remaining reset seconds. Known active upcoming resets sort first. Cache update age is reported only if UPDATE_INSTANCE_INFO was actually observed; capture time is not freshness. Missing/zero cached records never prove raids or loot available. No refresh, network request, polling, extension, clearing, invitations or game actions. After a manual native refresh explicitly reread.',
    inputSchema: lockoutsInput,
    label: { start: () => 'Reading cached lockouts', complete: () => 'Read cached lockouts' },
    execute: async (args, ctx) =>
      lockoutsReading.parse(
        await agentRPC(
          'inspect',
          { eveSession: ctx.session.id, inspection: { kind: 'lockouts', args } },
          ctx.abortSignal,
        ),
      ),
  }),
);
