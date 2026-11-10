import { z } from 'zod';
import { uiNode } from '@wisp/protocol/ui-schema';
import { referenceSchema } from '@wisp/protocol/rich-reference';
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
      // Exact final-answer source, independent of parser/display limits. Never reasoning.
      rawReply: z.string().optional(),
      tool: activity.optional(),
      phase: z.string().optional(),
      references: z.record(z.string(), referenceSchema).optional(),
      ui: z.array(uiNode).optional(),
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
  eveId: z.string().optional(),
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
