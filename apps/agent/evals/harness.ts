import { isDeepStrictEqual } from 'node:util';
import { createHarness, toJsonValue } from 'vitest-evals';
import type { TranscriptEvent } from 'vitest-evals';
import { recordContextUsage } from '../src/contract/context-usage.ts';
import { createAgentEngine } from '../src/engine.ts';
import type { ToolStubOutcome } from '../src/engine.ts';
import { agentHost } from '../src/host/agent-host.ts';
import { MemoryHistory } from '../src/session/memory-history.ts';
import { playerMessage } from './fixtures/fedrath.ts';

export interface ToolStub {
  id: string;
  tool: string;
  match?: Record<string, { const: unknown }>;
  outcome: ToolStubOutcome;
}

export interface WispInput {
  question: string;
  stubs: ToolStub[];
}

function matches(stub: ToolStub, tool: string, input: unknown) {
  if (stub.tool !== tool) {
    return false;
  }
  const fields = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return Object.entries(stub.match ?? {}).every(([key, rule]) =>
    isDeepStrictEqual(fields[key], rule.const),
  );
}

export const wispHarness = createHarness<WispInput, { reply: string }>({
  name: 'wisp',
  async run({ input, signal }) {
    const host = agentHost();
    if (!host) {
      throw new Error('Start the eval bridge before running evals.');
    }
    const engine = createAgentEngine({
      origin: () => host.origin,
      token: host.token,
      history: new MemoryHistory(),
      logger: { info: () => {}, warn: () => {} },
      stub: (tool, args) => input.stubs.find((stub) => matches(stub, tool, args))?.outcome,
    });
    try {
      const timeout = AbortSignal.timeout(300_000);
      const turn = engine.send(
        engine.newSessionId(),
        playerMessage(input.question),
        signal ? AbortSignal.any([signal, timeout]) : timeout,
        'eval',
      );
      const events: TranscriptEvent[] = [
        { type: 'message', role: 'user', content: input.question },
      ];
      const texts: string[] = [];
      const chat: Parameters<typeof recordContextUsage>[0] = {};
      let steps = 0;
      for await (const event of turn.events) {
        const { type, data } = event;
        if (type === 'content.completed' && data.kind === 'text') {
          const content = String(data.value);
          texts.push(content);
          events.push({ type: 'message', role: 'assistant', content });
        } else if (type === 'call.requested') {
          const args = toJsonValue(data.input);
          events.push({
            type: 'tool_call',
            id: String(data.callId),
            name: (data.capability as { name: string }).name,
            arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : undefined,
          });
        } else if (type === 'call.settled') {
          events.push({
            type: 'tool_result',
            toolCallId: String(data.callId),
            content: toJsonValue(data.output),
            error: data.outcome === 'failed' ? (data.error as { message: string }) : undefined,
          });
        } else if (type === 'usage.recorded') {
          steps++;
          recordContextUsage(chat, event);
        }
      }
      const result = await turn.result;
      return {
        events,
        output: { reply: texts.join('\n\n') },
        usage: chat.usage && {
          inputTokens: chat.usage.inputTokens,
          outputTokens: chat.usage.outputTokens,
        },
        artifacts: { steps },
        errors:
          result.status === 'completed'
            ? []
            : [new Error(result.error?.message ?? `Turn ${result.status}`)],
      };
    } finally {
      await engine.close();
    }
  },
});
