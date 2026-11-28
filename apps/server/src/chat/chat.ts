import { z } from 'zod';
import { Result, Schema } from 'effect';
import { uiNode } from '@wisp/agent/contract/ui-schema';
import { referenceSchema } from '@wisp/agent/contract/rich-reference';

/**
 * A contract schema inside this zod schema until chats move to Schema: it
 * decodes the value as the zod schema it replaced did, and reports its error.
 */
function fromSchema<A>(schema: Schema.Decoder<A>) {
  const decode = Schema.decodeUnknownResult(schema);
  return z.unknown().transform((value, ctx): A => {
    const result = decode(value);
    if (Result.isSuccess(result)) return result.success;
    ctx.addIssue({ code: 'custom', message: result.failure.message });
    return z.NEVER;
  });
}
export const chatStatus = z.enum([
  'idle',
  'working',
  'interrupted',
  'needs_input',
  'cancelled',
  'done',
  'error',
]);
const activity = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  status: z.string(),
  detail: z.string().optional(),
});
export const chatSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  owner: z.string(),
  status: chatStatus,
  messages: z.array(
    z.object({
      id: z.string().optional(),
      role: z.enum(['user', 'assistant', 'system', 'tool']),
      text: z.string(),
      // System notices the addon can show in the game's language; `text` stays the fallback.
      notice: z.enum(['noProvider']).optional(),
      // Exact final-answer source, independent of parser/display limits. Never reasoning.
      rawReply: z.string().optional(),
      replyFormat: z.literal('text').optional(),
      tool: activity
        .extend({ inputPreview: z.string().optional(), resultPreview: z.string().optional() })
        .optional(),
      phase: z.string().optional(),
      references: z.record(z.string(), fromSchema(referenceSchema)).optional(),
      ui: z.array(fromSchema(uiNode)).optional(),
      parts: z
        .array(
          z.discriminatedUnion('type', [
            z.object({ type: z.literal('text'), text: z.string() }),
            z.object({ type: z.literal('ui'), id: z.string() }),
          ]),
        )
        .optional(),
      streaming: z.boolean().optional(),
    }),
  ),
  activity: z.array(activity),
  modelSettings: z.object({ model: z.string(), effort: z.string() }).optional(),
  modelRequestId: z.string().optional(),
  modelError: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      cacheReadTokens: z.number().nonnegative(),
      contextTokens: z.number().nonnegative().optional(),
      compactions: z.number().nonnegative(),
      compacting: z.boolean(),
    })
    .optional(),
  titleGenerated: z.boolean().optional(),
  agentSession: z.string().optional(),
  characterKey: z.string().optional(),
  unread: z.boolean().optional(),
  historyVersion: z.number().optional(),
  lastUsedAt: z.number().optional(),
  lastActivityAt: z.number().optional(),
  inline: z.boolean().optional(),
  proactive: z.boolean().optional(),
  routineId: z.string().optional(),
  tipSkipped: z.boolean().optional(),
  dismissed: z.boolean().optional(),
  lastUIResult: z.unknown().optional(),
});

export type Chat = z.infer<typeof chatSchema>;
export type ChatStatus = z.infer<typeof chatStatus>;
export type Message = Chat['messages'][number];
export type ReplyPart = NonNullable<Message['parts']>[number];
export type Activity = Chat['activity'][number];
