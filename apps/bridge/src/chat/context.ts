import { integrationContext, type CapabilityView } from '@wisp/protocol/capabilities';
import type { Chat, Message } from './events.ts';
import { linkedReferences } from './references.ts';
import { z } from 'zod';
import type { TurnInput } from '@wisp/agent/engine';
import { replyContent } from '../reply/reply-content.ts';
export { conversationTitle } from './conversation-title.ts';

const questSummary = z.object({
  status: z.literal('available'),
  data: z.object({
    quests: z
      .array(
        z.object({
          id: z.number().int().positive(),
          title: z.string().max(500),
          level: z.number().finite().optional(),
          rewardXP: z.number().finite().nonnegative().optional(),
          complete: z.boolean().optional(),
          objectives: z
            .array(
              z.object({
                text: z.string().max(2000).optional(),
                finished: z.boolean().optional(),
                numFulfilled: z.number().nonnegative().optional(),
                numRequired: z.number().nonnegative().optional(),
              }),
            )
            .max(40),
        }),
      )
      .max(40),
    count: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
});
const characterSummary = z.object({
  status: z.literal('available'),
  data: z.object({
    name: z.string().min(1),
    // WoW Forever has no realms, so the client reports an empty one.
    realm: z.string(),
    level: z.number().optional(),
    class: z.string().optional(),
    race: z.string().optional(),
    faction: z.string().optional(),
    game: z.string().optional(),
    version: z.string().optional(),
    build: z.string().optional(),
    guid: z.string().optional(),
  }),
});

const groupSummary = z.object({
  status: z.literal('available'),
  data: z.object({
    inGroup: z.boolean(),
    raid: z.boolean(),
    size: z.number().int().min(1).max(40),
  }),
});

// A revision is meaningful only within this addon session and character.
// Missing/mismatched revisions fall back to tools, never the last known log.
export class TurnContextCache {
  private character?: { revision: number; section: z.infer<typeof characterSummary> };
  get characterRevision() {
    return this.character?.revision || 0;
  }
  private cached?: { revision: number; identity: string; quests: z.infer<typeof questSummary> };
  get revision() {
    return this.cached?.revision || 0;
  }
  resolve(value: unknown): unknown {
    let input = record(value);
    const characterRevision = input.characterRevision;
    if (Number.isSafeInteger(characterRevision) && Number(characterRevision) > 0) {
      const sections = record(input.sections),
        current = characterSummary.safeParse(sections.character);
      if (current.success) {
        if (!this.character || Number(characterRevision) >= this.character.revision) {
          this.character = { revision: Number(characterRevision), section: current.data };
        }
      } else if (
        !Object.hasOwn(sections, 'character') &&
        this.character &&
        this.character.revision === characterRevision
      ) {
        input = { ...input, sections: { ...sections, character: this.character.section } };
        value = input;
      }
    }
    const identity = characterIdentity(input);
    const revision = input.questRevision;
    if (!identity || !Number.isSafeInteger(revision) || Number(revision) <= 0) {
      return value;
    }
    const summary = questSummary.safeParse(record(input.sections).quests);
    if (summary.success) {
      if (
        !this.cached ||
        this.cached.identity !== identity ||
        Number(revision) >= this.cached.revision
      ) {
        this.cached = { revision: Number(revision), identity, quests: summary.data };
      }
      return { ...input, sections: { ...record(input.sections), quests: summary.data } };
    }
    if (this.cached?.identity === identity && this.cached.revision === revision) {
      return { ...input, sections: { ...record(input.sections), quests: this.cached.quests } };
    }
    return value;
  }
}

type QuestOwner = Pick<Chat, 'owner' | 'characterKey'>;
const turnQuests = new WeakMap<
  QuestOwner,
  {
    owner: string;
    identity: string;
    capturedAt: number;
    quests: z.infer<typeof questSummary>;
  }
>();

// Readings stay in bridge memory, separate from prompts and persisted chats.
// A new turn always replaces its reading, even when the snapshot is missing.
export function rememberTurnQuests(chat: QuestOwner, context: unknown) {
  turnQuests.delete(chat);
  const input = record(context),
    identity = characterIdentity(input);
  const summary = questSummary.safeParse(record(input.sections).quests);
  if (
    identity &&
    identity === chat.characterKey &&
    typeof input.capturedAt === 'number' &&
    summary.success &&
    !summary.data.data.truncated
  ) {
    turnQuests.set(chat, {
      owner: chat.owner,
      identity,
      capturedAt: input.capturedAt,
      quests: summary.data,
    });
  }
}

export async function queryCharacterSections(
  chat: QuestOwner,
  sections: string[],
  query: (sections: string[]) => Promise<Record<string, unknown>>,
  refresh = false,
): Promise<Record<string, unknown>> {
  const cached = turnQuests.get(chat);
  const requested = [...new Set(sections)];
  if (
    refresh ||
    !requested.includes('quests') ||
    !cached ||
    cached.identity !== chat.characterKey ||
    cached.owner !== chat.owner
  ) {
    return query(requested);
  }
  const remaining = requested.filter((section) => section !== 'quests');
  const result = remaining.length
    ? await query(remaining)
    : {
        capturedAt: cached.capturedAt,
        source: 'WoW addon live API',
        cache: 'verified at turn submission',
      };
  return {
    ...result,
    sections: {
      ...record(result.sections),
      quests: { ...cached.quests, capturedAt: cached.capturedAt },
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const fields = {
  character: ['name', 'realm', 'level', 'class', 'race', 'faction', 'game', 'version', 'build'],
  location: ['zone', 'subzone', 'mapId', 'x', 'y'],
} as const;
export function basicGameContext(value: unknown) {
  const input = record(value),
    sections = record(input.sections);
  const output: Record<string, unknown> = {};
  for (const name of ['character', 'location'] as const) {
    const section = record(sections[name]),
      data = record(section.data);
    output[name] =
      section.status === 'available'
        ? {
            status: 'available',
            data: Object.fromEntries(
              fields[name]
                .filter((key) => ['string', 'number'].includes(typeof data[key]))
                .map((key) => [key, data[key]]),
            ),
          }
        : {
            status: 'unavailable',
            error:
              'No fresh addon reading was supplied for this message. Query this section if needed.',
          };
  }
  // Only whether there is a group and its size, so the agent knows to read the
  // members; older addons send no group reading and the key is left out.
  const group = groupSummary.safeParse(sections.group);
  if (group.success) {
    output.group = group.data;
  }
  return {
    capturedAt: typeof input.capturedAt === 'number' ? input.capturedAt : undefined,
    source: 'WoW addon live API',
    sections: output,
  };
}
export interface CharacterProfile {
  /** `[game, guid]`, or `[game, realm, name]` from an addon that sends no GUID. */
  key: string;
  game: string;
  realm: string;
  name: string;
  guid?: string;
}
export function characterProfile(value: unknown): CharacterProfile | undefined {
  const sections = record(record(value).sections),
    section = record(sections.character),
    data = record(section.data);
  if (
    section.status !== 'available' ||
    typeof data.name !== 'string' ||
    !data.name ||
    typeof data.realm !== 'string'
  ) {
    return;
  }
  const game = typeof data.game === 'string' && data.game ? data.game : 'WoW Forever';
  const guid = typeof data.guid === 'string' && data.guid ? data.guid : undefined;
  const key = JSON.stringify(guid ? [game, guid] : [game, data.realm, data.name]);
  return { key, game, realm: data.realm, name: data.name, ...(guid ? { guid } : {}) };
}
export function characterIdentity(value: unknown): string | undefined {
  return characterProfile(value)?.key;
}
/** A player's turn: their text and the game and chat context the model reads with it. */
export function turnInput(
  text: string,
  context: unknown,
  chat: Pick<Chat, 'id' | 'title' | 'titleGenerated' | 'lastUIResult' | 'proactive' | 'routineId'>,
  capabilities?: CapabilityView[],
): TurnInput {
  const references = linkedReferences(text);
  return {
    text,
    context: [
      { name: 'game_context', data: basicGameContext(context) },
      ...(capabilities
        ? [{ name: 'integrations_context', data: integrationContext(capabilities) }]
        : []),
      {
        name: 'conversation_context',
        data: {
          id: chat.id,
          title: chat.title,
          automatic: chat.proactive === true,
          routineId: chat.routineId,
        },
      },
      ...(references.length ? [{ name: 'linked_references', data: references }] : []),
      ...(chat.lastUIResult ? [{ name: 'last_ui_result', data: chat.lastUIResult }] : []),
    ],
  };
}
/** The turn with the chat's recent visible messages, for a session that starts mid-chat. */
export function withConversationHistory(input: TurnInput, messages: Message[]): TurnInput {
  const currentUser = messages.findLastIndex((message) => message.role === 'user');
  const history = messages
    .slice(0, currentUser < 0 ? messages.length : currentUser)
    .flatMap((message) => {
      if ((message.role !== 'user' && message.role !== 'assistant') || message.streaming) {
        return [];
      }
      const content = message.role === 'assistant' ? replyContent(message) : message;
      return content?.role === message.role && content.text.trim()
        ? [{ role: message.role, text: content.text }]
        : [];
    })
    .slice(-12)
    .map((message) => ({ role: message.role, text: message.text.slice(0, 2000) }));
  return history.length ? { ...input, history } : input;
}
