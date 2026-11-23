import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  desktopRoutes as routes,
  type DesktopRoute,
  type DesktopRoutes,
  type DesktopRouteReply,
} from '@wisp/protocol/desktop-routes';
import type { Status } from '@wisp/protocol/desktop';
import type { McpManager } from '../integrations/mcp/mcp-manager.ts';
import type { ModelConnections } from '../models/model-connections.ts';
import type { WebSearch } from '../integrations/search/web-search.ts';
import type { ChatGPTAuth } from '../auth/chatgpt-auth.ts';
import type { CapabilitySettings } from '../integrations/capabilities.ts';
import type { PanelStore } from '../addon/panels.ts';
import type { RoutineStore } from '../routines/routine-store.ts';
import type { Chat } from '../chat/events.ts';
import { openChat, isWorking } from '../chat/chat-lifecycle.ts';
import { errorMessage } from '../errors.ts';
export interface PanelCommand {
  seq: number;
  id: string;
  characterKey: string;
  action: 'show' | 'hide';
}
// Called by the Rust host around addon installs; not part of the webview contract.
export const wowTransportInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume'), wow: z.string().min(1).optional() }),
]);
interface DesktopDependencies {
  auth: ChatGPTAuth;
  connections: ModelConnections;
  webSearch: WebSearch;
  capabilitySettings: CapabilitySettings;
  mcpManager: McpManager;
  panelStore: PanelStore;
  routineStore: RoutineStore;
  accountOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  updateModel: (model: string) => Promise<void>;
  getStatus: () => Status;
  getChats: () => Chat[];
  currentCharacterKey: () => string | undefined;
  sendPanelCommand: (command: PanelCommand) => void;
  openRoutine: (id: string) => void;
  readSimulationCharacter: () => Promise<unknown>;
  setCapability: (id: string, enabled: boolean) => Promise<void>;
  setWowTransport: (input: z.infer<typeof wowTransportInput>) => Promise<void>;
  setAppUpdate: (version: string | null) => void;
  setFeature: (id: string, enabled: boolean | null) => Promise<void>;
  refreshMcpCatalog: () => void;
  requestStop: () => void;
  changed: () => void;
}
// Validation failures throw so onError reports them like any other failure.
const json = <T extends z.ZodType>(schema: T) =>
  zValidator('json', schema, (result) => {
    if (!result.success) {
      throw result.error;
    }
  });
const ok = { ok: true } as const;
export function createDesktopApp(deps: DesktopDependencies) {
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
    .get('/status', (c) => c.json(deps.getStatus()))
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
      c.json(await accountOperation(() => webSearch.save(c.req.valid('json')))),
    )
    .post('/search/test', json(routes['/search/test'].input), async (c) => {
      await accountOperation(() => webSearch.test(c.req.valid('json')));
      return c.json(ok);
    })
    .post('/search/remove-exa', json(routes['/search/remove-exa'].input), async (c) =>
      c.json(await accountOperation(() => webSearch.removeExa())),
    )
    .post('/integrations/set', json(routes['/integrations/set'].input), async (c) => {
      const { id, enabled } = c.req.valid('json');
      await deps.setCapability(id, enabled);
      deps.changed();
      return c.json(ok);
    })
    .post('/mcps/test', json(routes['/mcps/test'].input), async (c) =>
      c.json(await mcpManager.test(c.req.valid('json'))),
    )
    .post('/mcps/save', json(routes['/mcps/save'].input), async (c) => {
      const setup = c.req.valid('json');
      const result = await mcpManager.save(setup);
      deps.refreshMcpCatalog();
      await capabilitySettings.set('mcp:' + setup.server.name, setup.server.enabled);
      deps.changed();
      return c.json(result);
    })
    .post('/mcps/remove', json(routes['/mcps/remove'].input), async (c) => {
      await mcpManager.remove(c.req.valid('json').name);
      deps.refreshMcpCatalog();
      await capabilitySettings.publish();
      deps.changed();
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
      await deps.setWowTransport(c.req.valid('json'));
      return c.json(ok);
    })
    .post('/stop', (c) => {
      if (deps.getChats().some(isWorking)) {
        throw Error('Wait for the active turn before stopping Wisp');
      }
      deps.requestStop();
      return c.json(ok);
    });
}
export type DesktopApp = ReturnType<typeof createDesktopApp>;
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
