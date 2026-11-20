import { randomUUID } from 'node:crypto';

export interface GameRequest {
  chat: string;
  session: string;
  sections?: string[];
  inspection?: unknown;
  action?: unknown;
}
interface PendingRequest extends GameRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  dispose: () => void;
}

export class GameRequests {
  private pending = new Map<string, PendingRequest>();
  private recoveryIds = new Map<string, string>();
  private changed: () => void;
  constructor(changed: () => void) {
    this.changed = changed;
  }

  request(input: GameRequest, signal?: AbortSignal, timeout = 30_000): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(new Error('Game request cancelled'));
    }
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
      const timer = setTimeout(
        () =>
          finish(() => reject(new Error('WoW did not respond in time. Open Wisp and try again.'))),
        timeout,
      );
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
      request.resolve(value);
      return true;
    }
    return false;
  }
  cancelAll(reason: string) {
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
