import { isDeepStrictEqual } from 'node:util';
import { Effect } from 'effect';
import { gameReading, unavailableGameAccess } from '../../src/host/game-access.ts';
import {
  attachHarnessRunToError,
  createHarness,
  normalizeHarnessRun,
  toJsonValue,
} from 'vitest-evals';
import type { TranscriptEvent } from 'vitest-evals';
import { recordContextUsage } from '../../src/contract/context-usage.ts';
import { createAgentEngine } from '../../src/engine.ts';
import type { ToolStubOutcome } from '../../src/engine.ts';
import { agentHost } from '../../src/host/agent-host.ts';
import { MemoryHistory } from '../../src/session/memory-history.ts';
import { playerMessage } from '../fixtures/fedrath.ts';
import { gameItemReadings } from '../fixtures/dungeon-loot.ts';

const lootItems = gameItemReadings();

export interface ToolStub {
  id: string;
  tool: string;
  match?: Record<string, { const: unknown } | RegExp>;
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
  return Object.entries(stub.match ?? {}).every(([key, rule]) => {
    const value = fields[key];
    return rule instanceof RegExp
      ? typeof value === 'string' && value.search(rule) !== -1
      : isDeepStrictEqual(value, rule.const);
  });
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
      gameAccess: {
        ...unavailableGameAccess,
        inspectGame: (_session, inspection) => {
          if (inspection.kind === 'gear_candidates') {
            return Effect.sync(() => {
              const found = inspection.args.itemIds.map((id) => lootItems[id]).filter(Boolean);
              return {
                status: 'available',
                data: {
                  status: 'available',
                  items: found
                    .filter((entry) => entry.kind === 'item')
                    .map((entry) => entry.reading),
                  other: found
                    .filter((entry) => entry.kind === 'other')
                    .map((entry) => entry.reading),
                },
              };
            });
          }
          return Effect.tryPromise({
            try: async (signal) => {
              const response = await fetch(new URL('/fixture-inspection', host.origin), {
                method: 'POST',
                headers: {
                  authorization: 'Bearer ' + host.token,
                  'content-type': 'application/json',
                },
                body: JSON.stringify({ inspection }),
                signal,
              });
              if (!response.ok) throw new Error(await response.text());
              return gameReading.parse(await response.json());
            },
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          });
        },
      },
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
      const report = {
        events,
        output: { reply: texts.join('\n\n') },
        usage: chat.usage && {
          inputTokens: chat.usage.inputTokens,
          outputTokens: chat.usage.outputTokens,
        },
        artifacts: { steps },
      };
      if (result.status !== 'completed') {
        const error = new Error(result.error?.message ?? `Turn ${result.status}`);
        throw attachHarnessRunToError(
          error,
          normalizeHarnessRun(input, { ...report, errors: [error] }),
        );
      }
      return report;
    } finally {
      await engine.close();
    }
  },
});
