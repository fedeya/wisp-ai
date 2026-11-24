import { and, asc, eq, gte, isNotNull, notInArray } from 'drizzle-orm';
import type { ModelMessage } from '@wisp/agent/engine';
import type { ApplicationDatabase } from '../db/application-database.ts';
import { agentMessages, chatInstanceState } from '../db/schema.ts';

/**
 * The model-facing history of each agent session, in the application
 * database next to the visible conversation. The agent sends it in full on
 * every turn, so a provider sees a stable prefix and can reuse its cache.
 */
export class AgentHistory {
  readonly database: ApplicationDatabase;
  constructor(database: ApplicationDatabase) {
    this.database = database;
  }

  async load(session: string): Promise<ModelMessage[]> {
    await this.database.initialize();
    return this.database.orm
      .select({ message: agentMessages.message })
      .from(agentMessages)
      .where(eq(agentMessages.session, session))
      .orderBy(asc(agentMessages.position))
      .all()
      .map((row) => JSON.parse(row.message) as ModelMessage);
  }

  /** Appends a turn's messages after the `from` messages already stored. */
  async append(session: string, from: number, messages: ModelMessage[]) {
    await this.database.transaction((db) => {
      db.delete(agentMessages)
        .where(and(eq(agentMessages.session, session), gte(agentMessages.position, from)))
        .run();
      if (messages.length) {
        db.insert(agentMessages)
          .values(
            messages.map((message, index) => ({
              session,
              position: from + index,
              message: JSON.stringify(message),
            })),
          )
          .run();
      }
    });
  }

  /** Replaces the whole history, for example with a compacted one. */
  async replace(session: string, messages: ModelMessage[]) {
    await this.append(session, 0, messages);
  }

  async delete(session: string) {
    await this.database.transaction((db) => {
      db.delete(agentMessages).where(eq(agentMessages.session, session)).run();
    });
  }

  /**
   * Removes the history of every session no saved conversation refers to.
   * Run it before turns start: a new session is saved with its chat later.
   */
  async prune() {
    await this.database.transaction((db) => {
      db.delete(agentMessages)
        .where(
          notInArray(
            agentMessages.session,
            db
              .select({ session: chatInstanceState.agentSession })
              .from(chatInstanceState)
              .where(isNotNull(chatInstanceState.agentSession)),
          ),
        )
        .run();
    });
  }
}
