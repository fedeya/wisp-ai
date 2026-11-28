import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { Effect, Schema } from 'effect';
import {
  desktopRoutes as routes,
  type DesktopRoute,
  type DesktopRoutes,
  type DesktopRouteReply,
} from '@wisp/protocol/desktop-routes';
import type { Status } from '@wisp/protocol/desktop';
import type { McpManager } from '@wisp/agent/mcp-manager';
import type { ModelConnections } from '../models/model-connections.ts';
import type { WebSearch } from '#/integrations/search';
import type { PromiseChatGPTAuth } from '../auth/index.ts';
import type { CapabilitySettings } from '../integrations/capabilities.ts';
import type { PanelStore } from '../panels/panel-store.ts';
import type { RoutineStore } from '../routines/routine-store.ts';
import type { Chat } from '../chat/events.ts';
import { openChat, isWorking } from '../chat/chat-lifecycle.ts';
import { errorMessage } from '../errors.ts';
import type { PanelCommand } from '../session-state.ts';
// Called by the Rust host around addon installs; not part of the webview contract.
export const wowTransportInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal('pause') }),
  Schema.Struct({
    action: Schema.Literal('resume'),
    wow: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  }),
]);
interface DesktopDependencies {
  auth: PromiseChatGPTAuth;
  connections: ModelConnections;
  webSearch: WebSearch['Service'];
  capabilitySettings: CapabilitySettings;
  mcpManager: McpManager;
  panelStore: PanelStore;
  routineStore: RoutineStore;
  accountOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  updateModel: (model: string) => Promise<void>;
  getStatus: Effect.Effect<Status>;
  getChats: () => Chat[];
  currentCharacterKey: () => string | undefined;
  sendPanelCommand: (command: PanelCommand) => void;
  openRoutine: (id: string) => void;
  readSimulationCharacter: () => Promise<unknown>;
  setCapability: (id: string, enabled: boolean) => Effect.Effect<void, unknown>;
  setWowTransport: (input: typeof wowTransportInput.Type) => Effect.Effect<void, unknown>;
  setAppUpdate: (version: string | null) => void;
  setFeature: (id: string, enabled: boolean | null) => Promise<void>;
  refreshMcpCatalog: () => void;
  requestStop: () => void;
  changed: () => void;
}
// Decodes the JSON body. A failure throws, so onError answers 400 with its
// message like any other failure.
const json = <S extends Schema.Codec<unknown, unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownSync(schema);
  return validator('json', (body): S['Type'] => decode(body));
};
const ok = { ok: true } as const;
export const createDesktopApp = Effect.fnUntraced(function* (deps: DesktopDependencies) {
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const {
    auth,
    connections,
    webSearch,
    capabilitySettings,
    mcpManager,
    panelStore,
    routineStore,
    accountOperation,
  } = deps;
  const chatFor = (id: string) => deps.getChats().find((chat) => chat.id === id);
  return new Hono()
    .onError((error, c) => c.json({ error: errorMessage(error) }, 400))
    .notFound((c) => c.json({ error: 'Unknown desktop request' }, 404))
    .use(async (c, next) => {
      await next();
      c.header('cache-control', 'no-store');
    })
    .get('/status', async (c) => c.json(await runPromise(deps.getStatus)))
    .get('/auth/models', async (c) =>
      c.json(await accountOperation(async () => ({ models: await connections.models() }))),
    )
    .post('/auth/start', json(routes['/auth/start'].input), async (c) => {
      const { profileId, newAccount } = c.req.valid('json');
      return c.json(await accountOperation(() => auth.beginSignIn(profileId, newAccount)));
    })
    .post('/auth/cancel', async (c) => {
      await auth.cancel();
      return c.json(auth.state());
    })
    .post('/auth/disconnect', async (c) => c.json(await accountOperation(() => auth.disconnect())))
    .post('/auth/select', json(routes['/auth/select'].input), async (c) =>
      c.json(await accountOperation(() => auth.select(c.req.valid('json').profileId))),
    )
    .post('/auth/model', json(routes['/auth/model'].input), async (c) => {
      const { model } = c.req.valid('json');
      await accountOperation(async () => {
        if (!(await connections.models()).some((m) => m.slug === model)) {
          throw Error('Choose an available model.');
        }
        await deps.updateModel(model);
      });
      return c.json({ ok: true as const, model });
    })
    .post('/connections/save', json(routes['/connections/save'].input), async (c) =>
      c.json(await accountOperation(() => connections.save(c.req.valid('json')))),
    )
    .post('/connections/test', json(routes['/connections/test'].input), async (c) => {
      await accountOperation(() => connections.test(c.req.valid('json')));
      return c.json(ok);
    })
    .post('/connections/discover', json(routes['/connections/discover'].input), async (c) =>
      c.json(await accountOperation(() => connections.discover(c.req.valid('json')))),
    )
    .post('/connections/remove', json(routes['/connections/remove'].input), async (c) => {
      await accountOperation(() => connections.remove(c.req.valid('json').id));
      return c.json(ok);
    })
    .post('/search/save', json(routes['/search/save'].input), async (c) =>
      c.json(await accountOperation(() => runPromise(webSearch.save(c.req.valid('json'))))),
    )
    .post('/search/test', json(routes['/search/test'].input), async (c) => {
      await accountOperation(() => runPromise(webSearch.test(c.req.valid('json'))));
      return c.json(ok);
    })
    .post('/search/remove-exa', json(routes['/search/remove-exa'].input), async (c) =>
      c.json(await accountOperation(() => runPromise(webSearch.removeExa))),
    )
    .post('/integrations/set', json(routes['/integrations/set'].input), async (c) => {
      const { id, enabled } = c.req.valid('json');
      await runPromise(deps.setCapability(id, enabled));
      deps.changed();
      return c.json(ok);
    })
    .post('/mcps/test', json(routes['/mcps/test'].input), async (c) =>
      c.json(await runPromise(mcpManager.test(c.req.valid('json')))),
    )
    .post('/mcps/save', json(routes['/mcps/save'].input), async (c) => {
      const setup = c.req.valid('json');
      const result = await runPromise(
        Effect.gen(function* () {
          const tested = yield* mcpManager.save(setup);
          deps.refreshMcpCatalog();
          yield* Effect.tryPromise({
            try: () => capabilitySettings.set('mcp:' + setup.server.name, setup.server.enabled),
            catch: (error) => error,
          });
          deps.changed();
          return tested;
        }),
      );
      return c.json(result);
    })
    .post('/mcps/remove', json(routes['/mcps/remove'].input), async (c) => {
      const { name } = c.req.valid('json');
      await runPromise(
        Effect.gen(function* () {
          yield* mcpManager.remove(name);
          deps.refreshMcpCatalog();
          yield* Effect.tryPromise({
            try: () => capabilitySettings.publish(),
            catch: (error) => error,
          });
          deps.changed();
        }),
      );
      return c.json(ok);
    })
    .post('/panels/action', json(routes['/panels/action'].input), async (c) => {
      const { characterKey, id, action } = c.req.valid('json');
      if (!panelStore.list(characterKey).some((p) => p.id === id)) {
        throw Error('Panel not found');
      }
      if (action === 'remove') {
        await panelStore.mutate(characterKey, { operation: 'remove', id });
      } else {
        if (characterKey !== deps.currentCharacterKey()) {
          throw Error('Log into this character first');
        }
        deps.sendPanelCommand({ seq: Date.now(), id, characterKey, action });
      }
      deps.changed();
      return c.json(ok);
    })
    .post('/routines/action', json(routes['/routines/action'].input), async (c) => {
      const { characterKey, operation, id } = c.req.valid('json');
      await routineStore.mutate(characterKey, { operation, id });
      deps.changed();
      return c.json(ok);
    })
    .post('/routines/open', json(routes['/routines/open'].input), async (c) => {
      const key = deps.currentCharacterKey();
      const run = key ? routineStore.getRun(c.req.valid('json').id, key) : undefined;
      const chat = run && chatFor(run.id);
      if (!run || !chat) {
        throw Error('Log into the character first; the conversation must still exist');
      }
      if (isWorking(chat)) {
        throw Error('Wait for the routine to finish');
      }
      openChat(chat);
      deps.openRoutine(run.id);
      deps.changed();
      return c.json(ok);
    })
    .post('/simulator/character', async (c) => c.json(await deps.readSimulationCharacter()))
    .post('/app-update', json(routes['/app-update'].input), (c) => {
      deps.setAppUpdate(c.req.valid('json').version);
      deps.changed();
      return c.json(ok);
    })
    .post('/features/set', json(routes['/features/set'].input), async (c) => {
      const { id, enabled } = c.req.valid('json');
      await deps.setFeature(id, enabled);
      return c.json(ok);
    })
    .post('/addon/transport', json(wowTransportInput), async (c) => {
      await runPromise(deps.setWowTransport(c.req.valid('json')));
      return c.json(ok);
    })
    .post('/stop', (c) => {
      if (deps.getChats().some(isWorking)) {
        throw Error('Wait for the active turn before stopping Wisp');
      }
      deps.requestStop();
      return c.json(ok);
    });
});
export type DesktopApp = Effect.Success<ReturnType<typeof createDesktopApp>>;
// Compile-time proof that every contract route is served with a reply its
// output schema accepts. A drifting route surfaces here by name.
type Served = DesktopApp extends Hono<infer _E, infer S> ? S : never;
type ServedReply<P extends DesktopRoute> =
  Served extends Record<P, Record<`$${DesktopRoutes[P]['method']}`, { output: infer O }>>
    ? O
    : { missing: P };
type Drift = {
  [P in DesktopRoute]: ServedReply<P> extends DesktopRouteReply<P> ? never : P;
}[DesktopRoute];
const contractHolds: [Drift] extends [never] ? true : Drift = true;
void contractHolds;
