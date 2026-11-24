import { SessionNotActiveError, type Client } from 'eve/client';
import { MASTRA_SESSION_PREFIX, type createMastraEngine } from './mastra-engine.ts';

type MastraEngine = ReturnType<typeof createMastraEngine>;
type Sessions = Pick<Client, 'sessions'>;

/**
 * Spike: routes chat sessions to Eve or the Mastra engine. New sessions follow
 * the `mastra_engine` flag; an existing session on the other engine reports
 * itself inactive, so `sendChatTurn` starts a new one from the visible history.
 */
export function createEngineClient(
  eve: Sessions,
  mastra: () => MastraEngine,
  useMastra: () => boolean,
): Sessions {
  const isMastra = (id: string) => id.startsWith(MASTRA_SESSION_PREFIX);
  function mastraSession(id: string) {
    return {
      id,
      async send(input: string, options?: { signal?: AbortSignal }) {
        if (!useMastra()) {
          throw new SessionNotActiveError();
        }
        const turn = mastra().send(id, input, options?.signal ?? new AbortController().signal);
        return {
          stream: () => turn.events,
          result: () => turn.result,
        };
      },
      async cancel() {
        // The turn runner aborts the running stream itself.
      },
      async end() {
        await mastra().end(id);
      },
    };
  }
  const sessions = {
    async create(options?: { signal?: AbortSignal }) {
      if (useMastra()) {
        return { session: mastraSession(mastra().newSessionId()) };
      }
      return eve.sessions.create(options);
    },
    attach(id: string) {
      if (isMastra(id)) {
        return mastraSession(id);
      }
      const session = eve.sessions.attach(id);
      if (!useMastra()) {
        return session;
      }
      // Leave the Eve session for a new Mastra one built from the visible history.
      return new Proxy(session, {
        get(target, key, receiver) {
          if (key === 'send') {
            return async () => {
              throw new SessionNotActiveError();
            };
          }
          return Reflect.get(target, key, receiver);
        },
      });
    },
  };
  return { sessions } as unknown as Sessions;
}
