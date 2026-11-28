import { assert, describe, it } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import {
  Clock,
  Context,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Ref,
  Stream,
} from 'effect';
import * as PlatformError from 'effect/PlatformError';
import { TestClock } from 'effect/testing';
import { defaultCapabilities, toolFeatures } from '@wisp/protocol/capabilities';
import * as Capabilities from '#/capabilities';
import { featuresAt } from './fixture.ts';

const report = {
  version: '0.2',
  questie: { status: 'partial', npcs: true, trainers: false, services: false, version: '4' },
  polestar: { status: 'ready' },
};

/**
 * Integration state over the default catalog, on a file system that keeps
 * the agent's file in `published`, with each write in order.
 */
const services = Effect.gen(function* () {
  const published = yield* Ref.make<readonly string[]>([]);
  const failNext = yield* Ref.make(false);
  const fileSystem = FileSystem.layerNoop({
    makeDirectory: () => Effect.void,
    remove: () => Effect.void,
    rename: () => Effect.void,
    writeFileString: (path, data) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(failNext, false)) {
          return yield* PlatformError.systemError({
            _tag: 'Unknown',
            module: 'FileSystem',
            method: 'writeFile',
            pathOrDescriptor: path,
            cause: new Error('ENOSPC: no space left on device'),
          });
        }
        yield* Ref.update(published, (all) => [...all, data]);
      }),
  });
  const context = yield* Layer.build(
    Capabilities.integrationsLayer.pipe(
      Layer.provideMerge(
        Capabilities.settingsLayerWith({
          file: 'capabilities.json',
          agentFile: 'agent-capabilities.json',
          catalog: defaultCapabilities(),
          toolFlags: toolFeatures,
        }),
      ),
      Layer.provide(featuresAt(Effect.succeed({}))),
      Layer.provide([fileSystem, Path.layer, NodeCrypto.layerSecureRandom]),
    ),
  );
  return {
    capabilities: Context.get(context, Capabilities.CapabilitySettings),
    integrations: Context.get(context, Capabilities.IntegrationState),
    published,
    failNext,
  };
});

const availability = (views: readonly { readonly id: string; readonly status: string }[]) =>
  Object.fromEntries(views.map((view) => [view.id, view.status]));

describe('IntegrationState', () => {
  it.effect('starts waiting for the game', () =>
    Effect.gen(function* () {
      const { capabilities } = yield* services;
      assert.isFalse(yield* capabilities.enabled('tool:query_character'));
      assert.include(availability(yield* capabilities.snapshot), {
        'core:wow': 'waiting',
        'integration:questie': 'waiting',
        'tool:find_npc_locations': 'waiting',
        'integration:polestar': 'waiting',
        'tool:create_guide': 'waiting',
      });
    }),
  );

  it.effect('records what a report makes available and ignores one that does not decode', () =>
    Effect.gen(function* () {
      const { capabilities, integrations } = yield* services;
      assert.isTrue(yield* integrations.receive(report));
      assert.isTrue(yield* capabilities.enabled('tool:query_character'));
      assert.isTrue(yield* capabilities.enabled('tool:find_npc_locations'));
      assert.isFalse(yield* capabilities.enabled('tool:get_quest'), 'quests were not reported');
      assert.isFalse(yield* capabilities.enabled('tool:create_guide'), 'guides default to off');
      const questie = (yield* capabilities.snapshot).find(
        (view) => view.id === 'integration:questie',
      );
      assert.deepInclude(questie, {
        available: true,
        status: 'partial',
        version: '4',
        reason: 'Some quest or location data is unavailable. See the tools below.',
      });
      for (const value of [
        { arbitrary: true },
        { ...report, version: 'v'.repeat(81) },
        undefined,
      ]) {
        assert.isFalse(yield* integrations.receive(value));
      }
      assert.isTrue(yield* capabilities.enabled('tool:find_npc_locations'));
      assert.deepStrictEqual(
        Option.map(yield* integrations.report, ({ version }) => version),
        Option.some('0.2'),
      );
    }),
  );

  it.effect('stops counting a report after three minutes, and forgets it on reset', () =>
    Effect.gen(function* () {
      const { capabilities, integrations } = yield* services;
      yield* integrations.receive(report);
      yield* TestClock.adjust('179999 millis');
      yield* integrations.refresh;
      assert.isTrue(yield* capabilities.enabled('tool:query_character'));
      yield* TestClock.adjust('1 millis');
      yield* integrations.refresh;
      assert.isFalse(yield* capabilities.enabled('tool:query_character'));
      assert.isTrue(Option.isSome(yield* integrations.report), 'the report is kept');

      yield* integrations.receive(report);
      assert.isTrue(yield* capabilities.enabled('tool:query_character'));
      yield* integrations.reset;
      assert.isFalse(yield* capabilities.enabled('tool:query_character'));
      assert.isTrue(Option.isNone(yield* integrations.report));
    }),
  );

  describe('health checks', () => {
    it.effect('every 30 seconds, publish and emit when a report stopped counting', () =>
      Effect.gen(function* () {
        const { capabilities, integrations, published } = yield* services;
        yield* integrations.receive(report);
        yield* capabilities.publish;
        const checks = yield* Queue.unbounded<number>();
        yield* integrations.healthChecks.pipe(
          Stream.runForEach(() =>
            Effect.flatMap(Clock.currentTimeMillis, (now) => Queue.offer(checks, now)),
          ),
          Effect.forkScoped,
        );
        // The report counts at 30 s to 150 s and has stopped at 180 s.
        yield* TestClock.adjust('179 seconds');
        assert.strictEqual(yield* Queue.size(checks), 0);
        assert.isTrue(yield* capabilities.enabled('tool:query_character'));
        yield* TestClock.adjust('1 second');
        assert.strictEqual(yield* Queue.take(checks), 180_000);
        assert.isFalse(yield* capabilities.enabled('tool:query_character'));
        const writes = yield* Ref.get(published);
        assert.strictEqual(writes.length, 2);
        assert.include(writes[1] ?? '', '"core:wow": false');

        // Nothing changes after that, so nothing more is published.
        yield* TestClock.adjust('5 minutes');
        assert.strictEqual(yield* Queue.size(checks), 0);
        assert.strictEqual((yield* Ref.get(published)).length, 2);
      }),
    );

    it.effect('run first 30 seconds after they start', () =>
      Effect.gen(function* () {
        const { capabilities, integrations } = yield* services;
        yield* integrations.receive(report);
        // The report stopped counting, but nothing has refreshed since.
        yield* TestClock.adjust('10 minutes');
        assert.isTrue(yield* capabilities.enabled('tool:query_character'));
        const checks = yield* Queue.unbounded<number>();
        const fiber = yield* integrations.healthChecks.pipe(
          Stream.runForEach(() =>
            Effect.flatMap(Clock.currentTimeMillis, (now) => Queue.offer(checks, now)),
          ),
          Effect.forkScoped,
        );
        yield* TestClock.adjust('29 seconds');
        assert.isTrue(yield* capabilities.enabled('tool:query_character'));
        yield* TestClock.adjust('1 second');
        assert.strictEqual(yield* Queue.take(checks), 630_000);
        assert.isFalse(yield* capabilities.enabled('tool:query_character'));
        yield* Fiber.interrupt(fiber);
      }),
    );

    it.effect('log a failed publish and keep checking', () =>
      Effect.gen(function* () {
        const { integrations, published, failNext } = yield* services;
        yield* integrations.receive(report);
        const checks = yield* Queue.unbounded<void>();
        yield* integrations.healthChecks.pipe(
          Stream.runForEach(() => Queue.offer(checks, undefined)),
          Effect.forkScoped,
        );
        yield* Ref.set(failNext, true);
        yield* TestClock.adjust('180 seconds');
        yield* Queue.take(checks);
        assert.deepStrictEqual(yield* Ref.get(published), []);
        yield* integrations.receive(report);
        yield* TestClock.adjust('180 seconds');
        yield* Queue.take(checks);
        assert.strictEqual((yield* Ref.get(published)).length, 1);
      }),
    );
  });
});
