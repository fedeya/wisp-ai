import { expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { createServer } from 'node:http';
import { Effect } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import { createAgentHandler } from '../src/agent/agent-server.ts';
import { Simulator } from '../src/integrations/simulation/simulator.ts';
import { bridgeLogging } from '../src/logger.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { layer as SessionStateLayer } from '#/session';

it.live(
  'simulation RPC skips game reads and transport freshness for hypothetical requests only',
  () =>
    Effect.gen(function* () {
      const chat = {
        ...newChat('sim', 'old-addon'),
        status: 'working' as const,
        agentSession: 'eve',
      };
      const readSimulationCharacter = vi.fn(async () => ({ sections: {} }));
      const run = vi.fn<Simulator['Service']['run']>(() =>
        Effect.succeed({ status: 'unavailable', error: 'Not simulated in this test.' }),
      );
      const simulator = Simulator.of({
        prepare: () => Effect.die('The RPC does not prepare requests.'),
        run,
        available: Effect.succeed(true),
      });
      let enabled = true;
      let transport = 'new-addon';
      const handler = yield* createAgentHandler({
        token: 'test',
        getChats: () => [chat],
        currentTransport: () => transport,
        capabilitySettings: { enabled: () => enabled },
        readSimulationCharacter,
        simulator,
      } as unknown as Parameters<typeof createAgentHandler>[0]);
      const server = yield* Effect.acquireRelease(
        Effect.callback<ReturnType<typeof createServer>>((resume) => {
          const server = createServer(handler);
          server.listen(0, '127.0.0.1', () => resume(Effect.succeed(server)));
        }),
        (server) =>
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          }),
      );
      const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/simulate';
      const post = (input: object) =>
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.bearerToken('test'),
          HttpClientRequest.bodyJsonUnsafe({ agentSession: 'eve', ...input }),
          HttpClient.execute,
          Effect.map((response) => response.status),
        );

      const nativeRequest = { raid: {}, padding: 'x'.repeat(33000) };
      expect(yield* post({ nativeRequest })).toBe(200);
      expect(run).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ nativeRequest }));
      const hypothetical = {
        character: { class: 'MAGE', level: 14, raceToken: 'Human' },
        includeCurrentEquipment: false,
        equipmentSets: [{ label: 'Naked', base: 'empty', replacements: [] }],
        plans: [{ label: 'Idle', priority: [] }],
      };
      expect(yield* post(hypothetical)).toBe(200);
      expect(readSimulationCharacter).not.toHaveBeenCalled();
      expect(yield* post({ plans: hypothetical.plans })).toBe(503);
      expect(readSimulationCharacter).not.toHaveBeenCalled();
      transport = 'old-addon';
      expect(yield* post({ plans: hypothetical.plans })).toBe(200);
      expect(readSimulationCharacter).toHaveBeenCalledOnce();
      enabled = false;
      expect(yield* post({ nativeRequest })).toBe(503);
      expect(run).toHaveBeenCalledTimes(3);
    }).pipe(
      Effect.scoped,
      Effect.provide([bridgeLogging, FetchHttpClient.layer, SessionStateLayer]),
    ),
);
