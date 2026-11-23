import { randomUUID } from 'node:crypto';

export interface GameRequest {
  chat: string;
  session: string;
  sections?: string[];
  inspection?: unknown;
  action?: unknown;
  /** Agent tool calls fail fast while WoW is unresponsive and get errors written for the agent. */
  agent?: boolean;
}
interface PendingRequest extends GameRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  dispose: () => void;
}

/** How long new agent game requests fail at once after one timed out, unless WoW answers first. */
export const UNRESPONSIVE_MS = 60_000;
const TIMEOUT_MESSAGE = 'WoW did not respond in time. Open Wisp and try again.';
// The agent reads these: they tell it to stop calling game tools for the rest of the turn.
const AGENT_TIMEOUT_MESSAGE =
  'WoW did not respond in time. Do not call game tools again in this turn: answer with what you already know, and tell the player to type /reload in WoW if Wisp keeps not responding.';
const UNRESPONSIVE_MESSAGE =
  'WoW did not respond to the previous game request, so this one was not sent. Do not call game tools again in this turn: answer with what you already know, and tell the player to type /reload in WoW if Wisp keeps not responding.';

export interface GameTimeout {
  kind: 'state' | 'inspection' | 'action';
  /** True when the addon sent nothing at all while the request waited. */
  addonSilent: boolean;
  waitedMs: number;
}
interface GameRequestOptions {
  now?: () => number;
  onTimeout?: (timeout: GameTimeout) => void;
}

export class GameRequests {
  private pending = new Map<string, PendingRequest>();
  private recoveryIds = new Map<string, string>();
  private changed: () => void;
  private now: () => number;
  private onTimeout: (timeout: GameTimeout) => void;
  private lastHeardAt = 0;
  private unresponsiveSince?: number;
  /** IDs of recently timed-out requests, kept only to recognize a late answer. */
  private timedOut = new Map<string, { session: string; chat: string }>();
  constructor(changed: () => void, options: GameRequestOptions = {}) {
    this.changed = changed;
    this.now = options.now ?? Date.now;
    this.onTimeout = options.onTimeout ?? (() => {});
  }

  /** Records any packet from the active game window, to tell a silent addon from a busy one. */
  heard() {
    this.lastHeardAt = this.now();
  }

  request(input: GameRequest, signal?: AbortSignal, timeout = 30_000): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(new Error('Game request cancelled'));
    }
    // One timeout means the whole game channel is stuck: every game tool waits on it.
    // Fail the agent's next ones at once instead of making the player wait 30 seconds each.
    // Requests the player starts (a settings button, a simulation) are always sent.
    if (
      input.agent &&
      this.unresponsiveSince !== undefined &&
      this.now() - this.unresponsiveSince < UNRESPONSIVE_MS
    ) {
      return Promise.reject(new Error(UNRESPONSIVE_MESSAGE));
    }
    const startedAt = this.now();
    let id = randomUUID();
    const previousIds: string[] = [];
    return new Promise((resolve, reject) => {
      const finish = (operation: () => void) => {
        for (const previous of previousIds) {
          this.recoveryIds.delete(previous);
        }
        this.pending.get(id)?.dispose();
        this.pending.delete(id);
        this.changed();
        operation();
      };
      const abort = () => finish(() => reject(new Error('Game request cancelled')));
      // A lost read can be repeated safely. A fresh ID lets the addon's
      // deduplication distinguish recovery from a retransmitted action.
      let retries = 0;
      const retry =
        !input.action && (input.sections || input.inspection)
          ? setInterval(() => {
              const request = this.pending.get(id);
              if (!request || retries >= 2) {
                return;
              }
              this.pending.delete(id);
              previousIds.push(id);
              id = randomUUID();
              for (const previous of previousIds) {
                this.recoveryIds.set(previous, id);
              }
              retries++;
              this.pending.set(id, request);
              this.changed();
            }, timeout / 3)
          : undefined;
      const timer = setTimeout(() => {
        const timedOutAt = this.now();
        this.unresponsiveSince = timedOutAt;
        this.onTimeout({
          kind: input.action ? 'action' : input.inspection ? 'inspection' : 'state',
          addonSilent: this.lastHeardAt <= startedAt,
          waitedMs: timedOutAt - startedAt,
        });
        // Remember every ID this request used, so a late answer proves WoW recovered.
        for (const timedOutId of [id, ...previousIds]) {
          this.timedOut.set(timedOutId, { session: input.session, chat: input.chat });
        }
        for (const oldest of this.timedOut.keys()) {
          if (this.timedOut.size <= 64) break;
          this.timedOut.delete(oldest);
        }
        finish(() => reject(new Error(input.agent ? AGENT_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE)));
      }, timeout);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        ...input,
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
        dispose: () => {
          clearTimeout(timer);
          clearInterval(retry);
          signal?.removeEventListener('abort', abort);
        },
      });
      this.changed();
    });
  }
  receive(requestId: string, session: string, chat: string | undefined, value: unknown) {
    const request = this.pending.get(this.recoveryIds.get(requestId) || requestId);
    if (request?.session === session && request.chat === chat) {
      this.unresponsiveSince = undefined;
      request.resolve(value);
      return true;
    }
    // A valid answer to a request that already timed out: its promise stays
    // rejected, but WoW is answering again, so stop failing new requests.
    const late = this.timedOut.get(requestId);
    if (late?.session === session && late.chat === chat) {
      this.timedOut.delete(requestId);
      this.unresponsiveSince = undefined;
    }
    return false;
  }
  cancelAll(reason: string) {
    // A new window or reconnection starts with a fresh channel.
    this.unresponsiveSince = undefined;
    for (const request of this.pending.values()) {
      request.reject(new Error(reason));
    }
  }
  cancelChat(chat: string) {
    for (const request of this.pending.values()) {
      if (request.chat === chat) {
        request.reject(new Error('Conversation deleted'));
      }
    }
  }
  snapshot() {
    return [...this.pending.entries()].map(([id, { chat, sections, inspection, action }]) => ({
      id,
      chat,
      sections,
      inspection,
      action,
    }));
  }
}
