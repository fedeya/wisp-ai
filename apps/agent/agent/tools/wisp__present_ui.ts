import { defineTool, toolOutput } from 'eve/tools';
import { replyPresentation } from '@wisp/protocol/reply-presentation';
import { agentRPC } from '@wisp/agent/agent-rpc';

export default defineTool({
  // Presentation is part of composing a reply; it must be available immediately.
  deferred: false,
  description:
    'Insert a complete native panel at this point in your reply, or register verified references for [[ref:key]] links. Write ordinary text before and after this call to interleave prose and panels. Use the component schema to compose cards, comparisons, tables and controls. This is presentation only: it performs no game action and saves no persistent panel. Never invent data to fill a panel. Use unique component IDs within the reply; reuse an ID only to update the same component.',
  inputSchema: replyPresentation,
  execute: (input, ctx) =>
    agentRPC(
      'present',
      {
        eveSession: ctx.session.id,
        callId: ctx.callId,
        presentation: input,
      },
      ctx.abortSignal,
    ),
  // Clients receive the full panel through call.settled; the model only needs
  // an acknowledgement instead of another copy of its presentation arguments.
  toModelOutput: () => toolOutput.json({ accepted: true }),
});
