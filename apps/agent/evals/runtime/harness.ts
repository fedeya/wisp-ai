import { isDeepStrictEqual } from 'node:util';
import { Effect } from 'effect';
import { inspectWith, unavailableGameAccess } from '../../src/host/game-access.ts';
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
import { itemSourcesFixture, playerMessage } from '../fixtures/fedrath.ts';
import { gameItemReadings } from '../fixtures/dungeon-loot.ts';

const lootItems = gameItemReadings();
const itemSources = itemSourcesFixture();

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
        inspectGame: inspectWith((_session, inspection) => {
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
          if (inspection.kind === 'item_sources') {
            return Effect.sync(() => ({
              status: 'available',
              items: [...new Set(inspection.args.itemIds)].map(
                (itemId) =>
                  itemSources[itemId] ?? { itemId, sourceKnown: false, sourcesStatus: 'available' },
              ),
              priceStatus: 'available',
              realm: 'Vorn',
              note: 'Player-observed sources need 3 agreeing installs; game-file sources are unconfirmed. sourceKnown=false means no known source, not proof the item is unobtainable. Auction prices are cached unit prices in copper.',
            }));
          }
          return Effect.fail(new Error('Not available in evals: stub this inspection tool.'));
        }),
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
