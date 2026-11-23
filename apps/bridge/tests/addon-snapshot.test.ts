import { test } from 'vitest';
import assert from 'node:assert/strict';
import { COMPACTION_THRESHOLD } from '@wisp/protocol/context-usage';
import type { Routine, RoutineRun } from '@wisp/protocol/routines';
import {
  buildAddonSnapshot,
  ROUTINE_INSTRUCTION_MAX_LENGTH,
  ROUTINE_TRIGGER_MAX_LENGTH,
  type AddonSnapshotInputs,
} from '../src/addon/addon-snapshot.ts';
import { createSessionState } from '../src/session-state.ts';
import type { Chat } from '../src/chat/events.ts';
import type { AccountModel } from '../src/chat/chat-model.ts';

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'bags',
    title: 'Bags',
    instruction: 'Tell me when my bags are full.',
    triggers: [{ kind: 'event', event: 'bags_changed', filters: [] }],
    cooldownSeconds: 600,
    once: false,
    characterKey: 'Realm-Hero',
    enabled: true,
    updatedAt: 1,
    nextAt: 0,
    ...overrides,
  };
}

function inputs(overrides: Partial<AddonSnapshotInputs> = {}): AddonSnapshotInputs {
  const state = createSessionState();
  state.activeTransport = 'session-1';
  state.currentCharacterKey = 'Realm-Hero';
  return {
    state,
    connected: true,
    bridgeVersion: '1.2.3',
    expectedAddonVersion: '1.2.3',
    appUpdateVersion: null,
    features: {},
    contextWindowTokens: 200_000,
    defaultModel: 'default-model',
    panels: [],
    routines: [],
    routineRuns: [],
    routinesAllowed: true,
    capabilities: [],
    requests: [],
    now: 1_000_000,
    ...overrides,
  };
}

test('keeps the payload key order the snapshot gate signs', () => {
  assert.deepEqual(Object.keys(buildAddonSnapshot(inputs())), [
    'v',
    'session',
    'connected',
    'bridgeVersion',
    'expectedAddonVersion',
    'appUpdateVersion',
    'features',
    'contextPolicy',
    'modelCatalog',
    'acks',
    'questRevision',
    'characterRevision',
    'activeChat',
    'chats',
    'notifications',
    'panels',
    'panelCommand',
    'routineCommand',
    'routines',
    'routineRuns',
    'routineSubscriptions',
    'routinesEnabled',
    'memory',
    'capabilities',
    'requests',
  ]);
});

test('prefers the active chat model window over the Eve-reported window', () => {
  const base = inputs();
  base.state.modelCatalog = [{ slug: 'big', contextWindow: 400_000 } as AccountModel];
  base.state.chats = [
    { id: 'chat-1', messages: [], modelSettings: { model: 'big' } } as unknown as Chat,
  ];
  assert.deepEqual(buildAddonSnapshot(base).contextPolicy, {
    windowTokens: 200_000,
    compactAt: COMPACTION_THRESHOLD,
  });
  base.state.activeChat = 'chat-1';
  assert.equal(buildAddonSnapshot(base).contextPolicy.windowTokens, 400_000);
});

test('shortens routine trigger and instruction text for the addon', () => {
  const triggers: Routine['triggers'] = [
    {
      kind: 'event',
      event: 'zone_changed',
      filters: [{ field: 'zone', op: 'contains', value: 'z'.repeat(300) }],
    },
  ];
  const snapshot = buildAddonSnapshot(
    inputs({
      routines: [routine({ triggers, instruction: 'x'.repeat(1000), lastStartedAt: 5 })],
    }),
  );
  const [projected] = snapshot.routines;
  assert.equal(projected.trigger.length, ROUTINE_TRIGGER_MAX_LENGTH);
  assert.equal(projected.instruction, 'x'.repeat(ROUTINE_INSTRUCTION_MAX_LENGTH));
  assert.deepEqual(Object.keys(projected), [
    'id',
    'title',
    'enabled',
    'trigger',
    'instruction',
    'lastStartedAt',
  ]);
});

test('subscribes once to each event of enabled routines', () => {
  const snapshot = buildAddonSnapshot(
    inputs({
      routines: [
        routine({ id: 'a' }),
        routine({
          id: 'b',
          triggers: [
            { kind: 'event', event: 'bags_changed', filters: [] },
            { kind: 'event', event: 'level_up', filters: [] },
            { kind: 'interval', seconds: 600 },
          ],
        }),
        routine({
          id: 'paused',
          enabled: false,
          triggers: [{ kind: 'event', event: 'zone_changed', filters: [] }],
        }),
      ],
    }),
  );
  assert.deepEqual(snapshot.routineSubscriptions, [
    { event: 'bags_changed', native: 'BAG_UPDATE_DELAYED' },
    { event: 'level_up', native: 'PLAYER_LEVEL_UP' },
  ]);
  assert.equal(snapshot.routinesEnabled, true);
});

test('drops routine subscriptions when the routine tool is disabled', () => {
  const snapshot = buildAddonSnapshot(inputs({ routines: [routine()], routinesAllowed: false }));
  assert.deepEqual(snapshot.routineSubscriptions, []);
  assert.equal(snapshot.routinesEnabled, false);
  assert.equal(snapshot.routines.length, 1);
});

test('omits run summaries from routine history', () => {
  const run: RoutineRun = {
    id: 'run-1',
    routineId: 'bags',
    characterKey: 'Realm-Hero',
    title: 'Bags',
    startedAt: 1,
    event: 'bags_changed',
    status: 'done',
    summary: 'private summary',
  };
  const { summary: _summary, ...withoutSummary } = run;
  assert.deepEqual(buildAddonSnapshot(inputs({ routineRuns: [run] })).routineRuns, [
    withoutSummary,
  ]);
});

test('shows no character content before a character is known', () => {
  const base = inputs({ routines: [routine()] });
  base.state.currentCharacterKey = undefined;
  const snapshot = buildAddonSnapshot(base);
  assert.deepEqual(snapshot.panels, []);
  assert.deepEqual(snapshot.routines, []);
  assert.deepEqual(snapshot.routineRuns, []);
  assert.deepEqual(snapshot.routineSubscriptions, []);
  assert.equal(snapshot.routinesEnabled, false);
});
test('sends the resolved feature flags to the addon', () => {
  const snapshot = buildAddonSnapshot({
    ...inputs(),
    features: { new_panel: true, dev_only: false },
  });
  assert.deepEqual(snapshot.features, { new_panel: true, dev_only: false });
});
