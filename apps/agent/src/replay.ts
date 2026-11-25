import { createHash } from 'node:crypto';
import type {
  AssistantContent,
  JSONValue,
  ModelMessage,
  ToolResultPart,
  UserModelMessage,
} from 'ai';
import type { Message, Native, Synthetic, Tool } from './session-message.ts';

/** A logged message and the model of the turn that wrote it. */
export interface StoredMessage {
  message: Message;
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
    case 'other':
      return id;
  }
}

type ProviderOptions = NonNullable<ToolResultPart['providerOptions']>;

/**
 * A named block as the model reads it: its data as JSON between tags. JSON
 * escapes the tag delimiters, so game strings and player text cannot close it.
 */
export function tagged(name: string, data: unknown) {
  const json = (JSON.stringify(data) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<${name}>\n${json}\n</${name}>`;
}

/** Wraps the player's saved memory as the model reads it. */
export const memoryBlock = (text: string) => `<saved_memory>\n${text}\n</saved_memory>`;

/** What Wisp added to a turn, as the model reads it. */
function syntheticText(message: Synthetic) {
  switch (message.kind) {
    case 'memory':
      return memoryBlock(message.text);
    case 'context':
      return message.blocks.map((block) => tagged(block.name, block.data)).join('\n\n');
    case 'history':
      return tagged('historical_conversation', message.messages);
  }
}

/** Sent for a call the turn stopped before it finished. */
export const INTERRUPTED_TOOL =
  'The turn stopped before this tool finished; its result is unknown.';

const nativeOptions = (native: Native | undefined, own: boolean) =>
  own && native ? { providerOptions: native as ProviderOptions } : {};

function toolOutput(state: Tool['state']): ToolResultPart['output'] {
  switch (state.status) {
    case 'running':
      return { type: 'error-text', value: INTERRUPTED_TOOL };
    case 'error':
      return { type: 'error-text', value: state.error };
    case 'completed':
      return state.output.type === 'text'
        ? { type: 'text', value: state.output.text }
        : { type: 'json', value: state.output.value as JSONValue };
  }
}

/**
 * A logged message as the model library's messages. Provider-native data
 * (reasoning signatures, encrypted reasoning, item IDs) only proves generation
 * to the model that produced it, so another model gets neither it nor the
 * reasoning, which it cannot verify.
 */
export function toModelMessages(message: Message, own: boolean, family: Family): ModelMessage[] {
  const id = (callId: string) => toolCallIdFor(callId, family);
  switch (message.type) {
    case 'user':
      return [
        userMessage(message.content.map((part) => tagged('user_message', part.text)).join('\n\n')),
      ];
    case 'synthetic': {
      const text = syntheticText(message);
      return text ? [userMessage(text)] : [];
    }
    case 'assistant': {
      const content: Exclude<AssistantContent, string> = [];
      const results: ToolResultPart[] = [];
      for (const part of message.content) {
        if (part.type === 'reasoning') {
          if (own) {
            content.push({
              type: 'reasoning',
              text: part.text,
              ...nativeOptions(part.native, own),
            });
          }
          continue;
        }
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text, ...nativeOptions(part.native, own) });
          continue;
        }
        content.push({
          type: 'tool-call',
          toolCallId: id(part.id),
          toolName: part.name,
          input: part.state.input,
          ...(part.providerExecuted ? { providerExecuted: true } : {}),
          ...nativeOptions(part.native, own),
        });
        const result: ToolResultPart = {
          type: 'tool-result',
          toolCallId: id(part.id),
          toolName: part.name,
          output: toolOutput(part.state),
          ...(part.state.status === 'running' ? {} : nativeOptions(part.state.native, own)),
        };
        // A provider's own tools answer inside its message; Wisp's in a tool message.
        if (part.providerExecuted) content.push(result);
        else results.push(result);
      }
      const messages: ModelMessage[] = [];
      if (content.length) {
        messages.push({ role: 'assistant', content, ...nativeOptions(message.native, own) });
      }
      if (results.length) messages.push({ role: 'tool', content: results });
      return messages;
    }
  }
}

/**
 * The logged messages as the target model reads them. Messages from other
 * models lose their provider-native data and reasoning, tool call IDs follow
 * the target's rules, consecutive user messages (what Wisp added and
 * the player's message) merge into one text, as the bridge used to send it, and for Mistral, which rejects a user
 * message right after tool results, an assistant message bridges the two (as
 * opencode does).
 */
export function replayMessages(
  stored: readonly StoredMessage[],
  target: ReplayTarget,
): ModelMessage[] {
  const family = modelFamily(target);
  const messages: ModelMessage[] = [];
  for (const { message, model } of stored) {
    for (const next of toModelMessages(message, model === target.model, family)) {
      const last = messages.at(-1);
      if (next.role === 'user' && last?.role === 'user') {
        messages[messages.length - 1] = userMessage(
          userText(last.content) + '\n\n' + userText(next.content),
        );
        continue;
      }
      if (family === 'mistral' && next.role === 'user' && last?.role === 'tool') {
        messages.push({ role: 'assistant', content: 'Done.' });
      }
      messages.push(next);
    }
  }
  return messages;
}

const userMessage = (text: string): UserModelMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

/** A replayed user message's text; replay writes only text parts. */
const userText = (content: UserModelMessage['content']) =>
  typeof content === 'string'
    ? content
    : content.map((part) => (part.type === 'text' ? part.text : '')).join('\n\n');
