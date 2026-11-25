import { createHash } from 'node:crypto';
import type { ModelMessage } from 'ai';

/** A stored history message and the model of the turn that wrote it. */
export interface StoredMessage {
  message: ModelMessage;
  model: string;
}

/** The model a turn runs on, as the bridge's session settings describe it. */
export interface ReplayTarget {
  /** Wisp's model slug (`connection:<id>:<model>` for connections). */
  model: string;
  /** The connection's provider; absent for the ChatGPT subscription. */
  provider?: string;
  /** The provider's own model ID, for connections. */
  modelId?: string;
}

type Family = 'anthropic' | 'mistral' | 'openai' | 'other';

const MISTRAL_MODELS = /mistral|devstral|codestral|pixtral|mixtral|magistral|ministral/;

/** Which tool-call rules a model's API enforces, by provider or by model name on gateways. */
export function modelFamily(target: ReplayTarget): Family {
  const name = (target.modelId ?? target.model).toLowerCase();
  if (target.provider === 'anthropic' || name.includes('claude')) return 'anthropic';
  if (target.provider === 'mistral' || MISTRAL_MODELS.test(name)) return 'mistral';
  if (!target.provider || target.provider === 'openai') return 'openai';
  return 'other';
}

const hash = (id: string) => createHash('sha256').update(id).digest('hex');

/**
 * A tool call ID the target accepts. The same ID always maps to the same
 * result, so a call and its result still match. Mistral takes exactly nine
 * alphanumerics and OpenAI at most 40 characters; those are hashed rather
 * than cut so different IDs stay different. Anthropic takes `[a-zA-Z0-9_-]`.
 */
export function toolCallIdFor(id: string, family: Family) {
  switch (family) {
    case 'mistral':
      return /^[a-zA-Z0-9]{9}$/.test(id) ? id : hash(id).slice(0, 9);
    case 'openai':
      return id.length <= 40 ? id : 'call_' + hash(id).slice(0, 35);
    case 'anthropic':
      return id.replace(/[^a-zA-Z0-9_-]/g, '_');
    default:
      return id;
  }
}

type Part = Record<string, unknown> & { type: string };

function withoutProviderOptions<T extends object>(value: T): T {
  if (!('providerOptions' in value)) return value;
  const { providerOptions: _dropped, ...rest } = value as T & { providerOptions?: unknown };
  return rest as T;
}

/**
 * A message written by another model, as the target may read it: provider
 * metadata (reasoning signatures, encrypted reasoning, item IDs) only proves
 * generation to the model that produced it, so it is dropped, and so is
 * reasoning, which another model cannot verify. Returns undefined when nothing
 * is left.
 */
function foreign(message: ModelMessage): ModelMessage | undefined {
  const bare = withoutProviderOptions(message);
  if (typeof bare.content === 'string') return bare;
  const content = (bare.content as Part[])
    .filter((part) => part.type !== 'reasoning')
    .map(withoutProviderOptions);
  return content.length ? ({ ...bare, content } as ModelMessage) : undefined;
}

function renameToolCalls(message: ModelMessage, family: Family): ModelMessage {
  if (family === 'other' || typeof message.content === 'string') return message;
  let changed = false;
  const content = (message.content as Part[]).map((part) => {
    if (typeof part.toolCallId !== 'string') return part;
    const toolCallId = toolCallIdFor(part.toolCallId, family);
    if (toolCallId === part.toolCallId) return part;
    changed = true;
    return { ...part, toolCallId };
  });
  return changed ? ({ ...message, content } as ModelMessage) : message;
}

/**
 * The stored history as the target model reads it. Messages from other models
 * lose their provider-native data, tool call IDs follow the target's rules,
 * and for Mistral, which rejects a user message right after tool results, an
 * assistant message bridges the two (as opencode does).
 */
export function replayMessages(stored: StoredMessage[], target: ReplayTarget): ModelMessage[] {
  const family = modelFamily(target);
  const messages: ModelMessage[] = [];
  for (const { message, model } of stored) {
    const readable = model === target.model ? message : foreign(message);
    if (!readable) continue;
    if (family === 'mistral' && readable.role === 'user' && messages.at(-1)?.role === 'tool') {
      messages.push({ role: 'assistant', content: 'Done.' });
    }
    messages.push(renameToolCalls(readable, family));
  }
  return messages;
}
