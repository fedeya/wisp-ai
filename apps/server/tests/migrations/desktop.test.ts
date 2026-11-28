import { assert, describe, layer } from '@effect/vitest';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeServices from '@effect/platform-node/NodeServices';
import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Ref,
} from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import * as Reactivity from 'effect/reactivity/Reactivity';
import { TestClock } from 'effect/testing';
import { ChatStore } from '../../src/chat/chat-store.ts';
import { newChat } from '../../src/chat/chat-lifecycle.ts';
import { migrateDesktop } from '../../src/migrations/desktop.ts';

/** A fresh folder for one test, removed when it ends. */
const folder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-desktop-import-' });
});

/** A previous installation with a WoW folder and the given runtime files. */
const previousInstallation = Effect.fnUntraced(function* (
  root: string,
  runtime: Record<string, string> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = path.join(root, 'old');
  yield* fs.makeDirectory(path.join(source, 'runtime'), { recursive: true });
  yield* fs.writeFileString(path.join(source, 'config.local.json'), '{"wow":"test-wow"}');
  for (const [name, text] of Object.entries(runtime)) {
    yield* fs.writeFileString(path.join(source, 'runtime', name), text);
  }
  return source;
});

/** A chat store the test opens and closes, like the desktop does, with the chats it loaded. */
const openStore = (file: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const store = new ChatStore(file, () => {});
      const chats = yield* Effect.tryPromise(() => store.load());
      return { store, chats };
    }),
    ({ store }) => Effect.tryPromise(() => store.close()).pipe(Effect.orDie),
  );

/** The message of the error an import failed with, if it failed with one. */
const failure = <A, E extends { readonly message: string }>(exit: Exit.Exit<A, E>) =>
  Option.getOrUndefined(Option.map(Exit.findErrorOption(exit), (error) => error.message));

/** One request the previous bridge received: its method and path. */
type Received = `${string} /${string}`;

/**
 * The previous bridge as the HTTP client sees it: `respond` answers each
 * request with a status, or as if nothing listened on the port, and
 * `received` reports each request in order.
 */
const bridgeClient = (
  received: Queue.Queue<Received>,
  respond: (request: Received) => Effect.Effect<number | 'unreachable'>,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const line: Received = `${request.method} /${url.pathname.slice(1)}`;
        assert.strictEqual(request.headers.authorization, 'Bearer secret');
        yield* Queue.offer(received, line);
        const status = yield* respond(line);
        if (status === 'unreachable') {
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new TypeError('fetch failed'),
            }),
          });
        }
        return HttpClientResponse.fromWeb(request, new Response('{}', { status }));
      }),
    ),
  );

/** For imports whose previous installation has no bridge to stop. */
const noBridge = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die('The import reached for a bridge')),
);

/** Imports a previous installation whose bridge listens on port 4567. */
const importWithBridge = Effect.fnUntraced(function* (root: string) {
  const path = yield* Path.Path;
  const source = yield* previousInstallation(root, {
    'desktop.json': JSON.stringify({ port: 4567, token: 'secret', pid: 1 }),
  });
  return yield* migrateDesktop({ source, destination: path.join(root, 'new') }).pipe(Effect.exit);
});

/** The settings the import wrote, or none when it wrote none. */
const readConfig = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(root, 'new', 'config.local.json');
  return (yield* fs.exists(file)) ? yield* fs.readFileString(file) : undefined;
});

layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layerDigest))((it) => {
  describe('previous bridge', () => {
    it.effect('imports when nothing listens on its port', () =>
      Effect.gen(function* () {
        const root = yield* folder;
        const received = yield* Queue.unbounded<Received>();
        const exit = yield* importWithBridge(root).pipe(
          Effect.provide(bridgeClient(received, () => Effect.succeed('unreachable'))),
        );
        assert.isTrue(Exit.isSuccess(exit));
        assert.deepStrictEqual(yield* Queue.takeAll(received), ['POST /stop']);
        assert.strictEqual(yield* readConfig(root), '{\n  "wow": "test-wow",\n  "model": ""\n}');
      }),
    );

    it.effect('stops the import when the bridge refuses to stop', () =>
      Effect.gen(function* () {
        const root = yield* folder;
        const received = yield* Queue.unbounded<Received>();
        const exit = yield* importWithBridge(root).pipe(
          Effect.provide(bridgeClient(received, () => Effect.succeed(409))),
        );
        assert.strictEqual(
          failure(exit),
          'Close the previous Wisp application after its active reply finishes, then import again.',
        );
        assert.strictEqual(yield* readConfig(root), undefined);
      }),
    );

    it.effect('checks every 200 ms until the bridge stops answering', () =>
      Effect.gen(function* () {
        const root = yield* folder;
        const received = yield* Queue.unbounded<Received>();
        const stopped = yield* Deferred.make<void>();
        const checks = yield* Ref.make(0);
        const times = yield* Queue.unbounded<number>();
        const fiber = yield* importWithBridge(root).pipe(
          Effect.provide(
            bridgeClient(received, (request) =>
              Effect.gen(function* () {
                if (request === 'POST /stop') {
                  yield* Deferred.succeed(stopped, undefined);
                  return 200;
                }
                yield* Queue.offer(times, yield* Clock.currentTimeMillis);
                return (yield* Ref.updateAndGet(checks, (n) => n + 1)) < 3 ? 200 : 'unreachable';
              }),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(stopped);
        const start = yield* Clock.currentTimeMillis;
        yield* TestClock.adjust('1 second');
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(fiber)));
        assert.deepStrictEqual(
          (yield* Queue.takeAll(times)).map((time) => time - start),
          [200, 400, 600],
        );
        assert.isDefined(yield* readConfig(root));
      }),
    );

    it.effect('gives up after 50 checks while the bridge keeps answering', () =>
      Effect.gen(function* () {
        const root = yield* folder;
        const received = yield* Queue.unbounded<Received>();
        const stopped = yield* Deferred.make<void>();
        const fiber = yield* importWithBridge(root).pipe(
          Effect.provide(
            bridgeClient(received, (request) =>
              request === 'POST /stop'
                ? Effect.as(Deferred.succeed(stopped, undefined), 200)
                : Effect.succeed(200),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(stopped);
        yield* TestClock.adjust('10 seconds');
        assert.strictEqual(
          failure(yield* Fiber.join(fiber)),
          'The previous Wisp bridge is still stopping. Try again in a moment.',
        );
        const requests = yield* Queue.takeAll(received);
        assert.strictEqual(requests.filter((request) => request === 'GET /status').length, 50);
        assert.strictEqual(yield* readConfig(root), undefined);
      }),
    );
  });

  it.effect('detaches legacy conversations from their model history', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* folder;
      const chats = JSON.stringify([
        { id: 'a', eveId: 'eve', agentSession: 's', status: 'working', messages: [] },
        { status: 'idle', id: 'b' },
        'kept as is',
        ['kept', 'as', 'is'],
      ]);
      const source = yield* previousInstallation(root, { 'chats.json': chats });
      yield* migrateDesktop({ source, destination: path.join(root, 'new') }).pipe(
        Effect.provide(noBridge),
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(root, 'new', 'runtime', 'chats.json')),
        JSON.stringify(
          [
            { id: 'a', status: 'interrupted', messages: [] },
            { status: 'idle', id: 'b' },
            'kept as is',
            ['kept', 'as', 'is'],
          ],
          null,
          2,
        ),
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(source, 'runtime', 'chats.json')),
        chats,
      );
    }),
  );

  it.effect('replaces an empty workspace and snapshots WAL data without modifying the source', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* folder;
      const source = path.join(root, 'old');
      const destination = path.join(root, 'new');
      // The source database stays open, with its last commit in the WAL.
      const { store: sourceStore } = yield* openStore(path.join(source, 'runtime', 'wisp.sqlite'));
      const original = {
        ...newChat('chat', 'game'),
        agentSession: 'source-session',
        status: 'working' as const,
        messages: [{ role: 'user' as const, text: 'Hello' }],
      };
      yield* Effect.tryPromise(() => sourceStore.flush([original]));
      yield* fs.writeFileString(
        path.join(source, 'runtime', 'chats.json'),
        '{stale JSON must not override SQLite',
      );
      yield* fs.writeFileString(path.join(source, 'config.local.json'), '{"wow":"test"}');
      yield* fs.writeFileString(path.join(source, 'runtime', 'chatgpt-host.json'), 'old host');
      yield* Effect.scoped(openStore(path.join(destination, 'runtime', 'wisp.sqlite')));
      yield* fs.writeFileString(path.join(destination, 'runtime', 'chatgpt-host.json'), 'new host');

      yield* migrateDesktop({ source, destination }).pipe(Effect.provide(noBridge));

      assert.strictEqual(
        yield* fs.readFileString(path.join(destination, 'runtime', 'chatgpt-host.json')),
        'old host',
      );
      const [chat] = yield* Effect.scoped(
        Effect.map(
          openStore(path.join(destination, 'runtime', 'wisp.sqlite')),
          ({ chats }) => chats,
        ),
      );
      assert.isDefined(chat);
      assert.isUndefined(chat.agentSession);
      assert.strictEqual(chat.status, 'interrupted');
      assert.deepStrictEqual(chat.messages, original.messages);
      const sql = yield* SqliteClient.make({
        filename: path.join(source, 'runtime', 'wisp.sqlite'),
        readonly: true,
      }).pipe(Effect.provideService(Reactivity.Reactivity, yield* Reactivity.make));
      assert.deepStrictEqual(yield* sql`SELECT agent_session FROM chat_instance_state`, [
        { agent_session: 'source-session' },
      ]);
    }),
  );

  it.effect('refuses a workspace that already has conversations', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* folder;
      const source = yield* previousInstallation(root);
      const destination = path.join(root, 'new');
      const database = path.join(destination, 'runtime', 'wisp.sqlite');
      yield* Effect.scoped(
        Effect.flatMap(openStore(database), ({ store }) =>
          Effect.tryPromise(() =>
            store.flush([
              { ...newChat('keep', 'game'), messages: [{ role: 'user', text: 'Keep' }] },
            ]),
          ),
        ),
      );
      const exit = yield* migrateDesktop({ source, destination }).pipe(
        Effect.provide(noBridge),
        Effect.exit,
      );
      assert.strictEqual(
        failure(exit),
        'This installation already has saved data; no data was overwritten.',
      );
      assert.isTrue(yield* fs.exists(database));
      assert.strictEqual(yield* readConfig(root), undefined);
    }),
  );
});
