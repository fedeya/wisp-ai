import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, layer } from '@effect/vitest';
import { Clock, Effect, Fiber, Layer, Ref } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import { TestClock } from 'effect/testing';
import { installerVersion, updateStages, waitUntilReady } from '../verify-installer.ts';
import { temporaryDirectory, writeFiles } from './fixtures.ts';

const version = '0.3.3-nightly.217.1';
const name = `WispAI-${version}-windows-x64-setup.exe`;

/** A bridge whose /status answers `ready` once it has been asked `after` times. */
const bridge = (after: number) =>
  Effect.gen(function* () {
    const asked = yield* Ref.make<HttpClientRequest.HttpClientRequest[]>([]);
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const requests = yield* Ref.updateAndGet(asked, (previous) => [...previous, request]);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ ready: requests.length >= after }),
        );
      }),
    );
    return { asked, layer: Layer.succeed(HttpClient.HttpClient, client) };
  });

const identity = JSON.stringify({ pid: 42, port: 4567, token: 'secret' });

/**
 * Moves the test clock 400 ms at a time until `fiber` ends. The fiber reads
 * real files between its sleeps, so the clock moves only while it waits.
 */
const advanceUntilDone = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust('400 millis');
      yield* TestClock.withLive(Effect.sleep('1 millis'));
    }
    return yield* Fiber.join(fiber);
  });

layer(NodeServices.layer)((it) => {
  it.effect('the installer version comes from the update manifest signed for it', () =>
    Effect.gen(function* () {
      const folder = yield* temporaryDirectory('wisp-installer-version-');
      const url = `https://github.com/fedeya/wisp-ai/releases/download/v${version}/${name}`;
      yield* writeFiles(folder, {
        'latest.json': JSON.stringify({
          version,
          platforms: { 'windows-x86_64': { signature: 'signed', url } },
        }),
      });
      expect(yield* installerVersion(`${folder}/${name}`)).toBe(version);
      const other = yield* Effect.flip(
        installerVersion(`${folder}/WispAI-0.0.6-windows-x64-setup.exe`),
      );
      expect(other.message).toContain('same signed build');
      yield* writeFiles(folder, { 'latest.json': '{"version": 1}' });
      const malformed = yield* Effect.flip(installerVersion(`${folder}/${name}`));
      expect(malformed.message).toContain('same signed build');
    }),
  );

  it.effect('the update log lists each stage with its time', () =>
    Effect.sync(() => {
      expect(updateStages('12 installer-ready\r\n40 helper-extracted\n')).toEqual([
        { milliseconds: 12, stage: 'installer-ready' },
        { milliseconds: 40, stage: 'helper-extracted' },
      ]);
    }),
  );

  it.effect('the bridge is ready once its own status says so, retrying 400 ms apart', () =>
    Effect.gen(function* () {
      const data = yield* temporaryDirectory('wisp-installer-ready-');
      yield* writeFiles(data, { 'runtime/desktop.json': identity });
      const status = yield* bridge(3);
      const waiting = yield* waitUntilReady(
        data,
        42,
        Effect.succeed(false),
        Effect.succeed(''),
      ).pipe(Effect.provide(status.layer), Effect.forkChild);
      yield* advanceUntilDone(waiting);
      const asked = yield* Ref.get(status.asked);
      expect(asked).toHaveLength(3);
      expect(asked[0]?.url).toBe('http://127.0.0.1:4567/status');
      expect(asked[0]?.headers).toMatchObject({ authorization: 'Bearer secret' });
    }),
  );

  it.effect('another process in desktop.json is not the bridge being verified', () =>
    Effect.gen(function* () {
      const data = yield* temporaryDirectory('wisp-installer-other-');
      yield* writeFiles(data, { 'runtime/desktop.json': identity });
      const status = yield* bridge(1);
      const waiting = yield* waitUntilReady(
        data,
        7,
        Effect.succeed(false),
        Effect.succeed('log'),
      ).pipe(Effect.provide(status.layer), Effect.forkChild);
      const error = yield* advanceUntilDone(waiting).pipe(Effect.flip);
      expect(error.message).toBe('Installed agent did not become ready: log');
      // 150 tries, 400 ms apart.
      expect(yield* Clock.currentTimeMillis).toBeGreaterThanOrEqual(149 * 400);
      expect(yield* Ref.get(status.asked)).toHaveLength(0);
    }),
  );

  it.effect('a bridge that exits before it is ready fails with its output', () =>
    Effect.gen(function* () {
      const data = yield* temporaryDirectory('wisp-installer-exited-');
      const status = yield* bridge(1);
      const error = yield* waitUntilReady(
        data,
        42,
        Effect.succeed(true),
        Effect.succeed('port in use'),
      ).pipe(Effect.provide(status.layer), Effect.flip);
      expect(error.message).toBe('Installed bridge exited: port in use');
    }),
  );
});
