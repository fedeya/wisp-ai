import { Schema } from 'effect';

/**
 * Wisp's session log format (`wisp-1`), as `agent_entries.data` stores it.
 *
 * It belongs to Wisp, not to the AI SDK: plain JSON, unions tagged by `type`,
 * so any runtime can read and write it. The engine converts it to the model
 * library's messages only when it replays a session (`replay.ts`). Its shape
 * follows opencode's session messages (`packages/schema/src/session-message.ts`).
 *
 * New kinds of entries or parts can be added later; the existing ones change
 * only with a new format version.
 */
export const FORMAT = 'wisp-1';

/**
 * Provider-owned replay data, keyed by provider (`anthropic`, `openai`, ...):
 * reasoning signatures, encrypted reasoning, item IDs. Stored and sent back
 * as is, and only to the model that produced it.
 */
export const Native = Schema.Record(Schema.String, Schema.Unknown);
export type Native = typeof Native.Type;

const native = Schema.optionalKey(Native);

/** What the player sent: the bridge's turn input, game context included. */
export const User = Schema.Struct({
  type: Schema.tag('user'),
  content: Schema.Array(Schema.Struct({ type: Schema.tag('text'), text: Schema.String })),
});
export type User = typeof User.Type;

/** Text the engine adds for the model, which the player did not write. */
export const Synthetic = Schema.Struct({
  type: Schema.tag('synthetic'),
  /** `memory`: the player's saved memory, sent again whenever it changes. */
  kind: Schema.Literals(['memory']),
  text: Schema.String,
});
export type Synthetic = typeof Synthetic.Type;

/** What the model sees of a tool's result. */
export const ToolOutput = Schema.Union([
  Schema.Struct({ type: Schema.tag('text'), text: Schema.String }),
  Schema.Struct({ type: Schema.tag('json'), value: Schema.Unknown }),
]);
export type ToolOutput = typeof ToolOutput.Type;

/** A call the turn stopped before it finished; replayed as interrupted. */
export const ToolRunning = Schema.Struct({
  status: Schema.tag('running'),
  input: Schema.Unknown,
});
export const ToolCompleted = Schema.Struct({
  status: Schema.tag('completed'),
  input: Schema.Unknown,
  output: ToolOutput,
  native,
});
export const ToolFailed = Schema.Struct({
  status: Schema.tag('error'),
  input: Schema.Unknown,
  error: Schema.String,
  native,
});
export const ToolState = Schema.Union([ToolRunning, ToolCompleted, ToolFailed]);
export type ToolState = typeof ToolState.Type;

export const Text = Schema.Struct({ type: Schema.tag('text'), text: Schema.String, native });
export const Reasoning = Schema.Struct({
  type: Schema.tag('reasoning'),
  text: Schema.String,
  native,
});
export const Tool = Schema.Struct({
  type: Schema.tag('tool'),
  /** The call ID as the model that made it wrote it. */
  id: Schema.String,
  name: Schema.String,
  state: ToolState,
  /** The provider ran the tool itself (such as its web search), not Wisp. */
  providerExecuted: Schema.optionalKey(Schema.Boolean),
  /** Wisp's own data about the call, such as a subagent's session. */
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  native,
});
export type Tool = typeof Tool.Type;

export const AssistantPart = Schema.Union([Text, Reasoning, Tool]);
export type AssistantPart = typeof AssistantPart.Type;

/** Why a step ended: the provider's reason, or `interrupted` when the turn stopped it. */
export const Finish = Schema.Literals([
  'stop',
  'length',
  'content-filter',
  'tool-calls',
  'error',
  'other',
  'interrupted',
]);

export const Tokens = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.optionalKey(Schema.Number),
  cacheRead: Schema.optionalKey(Schema.Number),
  cacheWrite: Schema.optionalKey(Schema.Number),
});

/** One model step: its text, reasoning and tool calls with their results. */
export const Assistant = Schema.Struct({
  type: Schema.tag('assistant'),
  content: Schema.Array(AssistantPart),
  finish: Schema.optionalKey(Finish),
  tokens: Schema.optionalKey(Tokens),
  /** Why the step failed, when it did. */
  error: Schema.optionalKey(Schema.String),
  native,
  /** Milliseconds since the epoch. */
  time: Schema.Struct({ created: Schema.Number, completed: Schema.optionalKey(Schema.Number) }),
});
export type Assistant = typeof Assistant.Type;

/**
 * Messages before `keptFrom` (a `seq`) are summarized; the model reads the
 * summary instead. No summary when summarizing failed.
 */
export const Compaction = Schema.Struct({
  type: Schema.tag('compaction'),
  keptFrom: Schema.Number,
  summary: Schema.optionalKey(Schema.String),
});
export type Compaction = typeof Compaction.Type;

/** A message the model reads. */
export const Message = Schema.Union([User, Synthetic, Assistant]);
export type Message = typeof Message.Type;

/** One entry of a session's log. */
export const Entry = Schema.Union([User, Synthetic, Assistant, Compaction]);
export type Entry = typeof Entry.Type;
