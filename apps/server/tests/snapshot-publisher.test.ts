import { Deferred, Effect } from 'effect';
import { expect, test } from 'vitest';
import type { Connection } from '@wisp/wow-bridge';
import { createSnapshotPublisher } from '../src/game/snapshot-publisher.ts';
import { createSessionState } from '../src/session-state.ts';

test('a character switch during a panel read discards the old addon snapshot', async () => {
  const state = createSessionState();
  state.activeTransport = 'session';
  state.currentCharacterKey = 'mage';
  const readsStarted = Deferred.makeUnsafe<void>();
  const releaseRead = Deferred.makeUnsafe<void>();
  const published = Deferred.makeUnsafe<void>();
  const snapshots: Parameters<Connection['publish']>[0][] = [];
  const transport: Pick<Connection, 'publish'> = {
    publish: (view) =>
      Effect.sync(() => {
        snapshots.push(view);
        Deferred.doneUnsafe(published, Effect.void);
      }),
  };
  const publisher = await Effect.runPromise(
    createSnapshotPublisher({
      state,
      transport: () => transport,
      inputs: Effect.fnUntraced(function* () {
        const characterKey = state.currentCharacterKey ?? '';
        if (characterKey === 'mage') {
          yield* Deferred.succeed(readsStarted, undefined);
          yield* Deferred.await(releaseRead);
        }
        return {
          connected: true,
          bridgeVersion: 'test',
          expectedAddonVersion: undefined,
          appUpdateVersion: null,
          contextWindowTokens: undefined,
          defaultModel: 'test',
          panels: [
            {
              characterKey,
              id: 'panel',
              title: 'Panel',
              updatedAt: 0,
              ui: [],
              bindings: [],
              references: {},
            },
          ],
          routines: [],
          routineRuns: [],
          routinesAllowed: false,
          capabilities: [],
          features: {},
        };
      }),
    }),
  );
  try {
    publisher.flush();
    await Effect.runPromise(Deferred.await(readsStarted));
    state.currentCharacterKey = 'warrior';
    publisher.invalidate();
    await Effect.runPromise(Deferred.succeed(releaseRead, undefined));
    await Effect.runPromise(Deferred.await(published));
    expect(snapshots).toEqual([
      expect.objectContaining({
        panels: [expect.objectContaining({ characterKey: 'warrior' })],
      }),
    ]);
  } finally {
    await Effect.runPromise(publisher.stop);
  }
});
