import { integrationContext, type CapabilityView } from '@wisp/protocol/capabilities';
import type { Chat, Message } from './events.ts';
import { linkedReferences } from '@wisp/protocol/references';
import { z } from 'zod';

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
    realm: z.string().min(1),
    level: z.number().optional(),
    class: z.string().optional(),
    race: z.string().optional(),
    faction: z.string().optional(),
    game: z.string().optional(),
    version: z.string().optional(),
    build: z.string().optional(),
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
  return {
    capturedAt: typeof input.capturedAt === 'number' ? input.capturedAt : undefined,
    source: 'WoW addon live API',
    sections: output,
  };
}
export function characterIdentity(value: unknown): string | undefined {
  const sections = record(record(value).sections),
    section = record(sections.character),
    data = record(section.data);
  if (
    section.status !== 'available' ||
    typeof data.name !== 'string' ||
    !data.name ||
    typeof data.realm !== 'string' ||
    !data.realm
  ) {
    return;
  }
  return JSON.stringify([data.game || 'WoW Forever', data.realm, data.name]);
}
// JSON escapes the tag delimiters so user text and game strings cannot close a block.
function tagged(name: string, data: unknown) {
  const json = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<${name}>\n${json}\n</${name}>`;
}
export function turnInput(
  text: string,
  context: unknown,
  chat: Pick<Chat, 'id' | 'title' | 'titleGenerated' | 'lastUIResult' | 'proactive' | 'routineId'>,
  capabilities?: CapabilityView[],
  needsTitle = false,
) {
  const references = linkedReferences(text);
  return [
    tagged('game_context', basicGameContext(context)),
    ...(capabilities ? [tagged('integrations_context', integrationContext(capabilities))] : []),
    tagged('conversation_context', {
      id: chat.id,
      title: chat.title,
      ...(needsTitle ? { needsTitle: true } : {}),
      automatic: chat.proactive === true,
      routineId: chat.routineId,
    }),
    ...(references.length ? [tagged('linked_references', references)] : []),
    ...(chat.lastUIResult ? [tagged('last_ui_result', chat.lastUIResult)] : []),
    tagged('user_message', text),
  ].join('\n\n');
}
export function withConversationHistory(input: string, messages: Message[]): string {
  const currentUser = messages.findLastIndex((message) => message.role === 'user');
  const history = messages
    .slice(0, currentUser < 0 ? messages.length : currentUser)
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        !message.streaming &&
        message.text.trim(),
    )
    .slice(-12)
    .map((message) => ({ role: message.role, text: message.text.slice(0, 2000) }));
  if (!history.length) {
    return input;
  }
  const block = tagged('historical_conversation', history);
  return input.replace('<user_message>', block + '\n\n<user_message>');
}
export function visibleUserText(input: string) {
  const match =
    /^<game_context>\n[^\n]*\n<\/game_context>\n\n(?:<integrations_context>\n[^\n]*\n<\/integrations_context>\n\n)?<conversation_context>\n[^\n]*\n<\/conversation_context>\n\n(?:<linked_references>\n[^\n]*\n<\/linked_references>\n\n)?(?:<last_ui_result>\n[^\n]*\n<\/last_ui_result>\n\n)?(?:<historical_conversation>\n[^\n]*\n<\/historical_conversation>\n\n)?<user_message>\n([^\n]*)\n<\/user_message>$/.exec(
      input,
    );
  if (match) {
    try {
      const value = JSON.parse(match[1]);
      if (typeof value === 'string') {
        return value;
      }
    } catch {}
  }
  return input;
}
export function conversationTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return;
  }
  const title = [
    ...value
      // oxlint-disable-next-line no-control-regex -- Strip or reject control bytes in game/UI text.
      .replace(/[|`\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, 60)
    .join('');
  return title || undefined;
}
