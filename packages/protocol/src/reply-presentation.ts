import { z } from 'zod';
import { uiNode, validateNode } from './ui-schema.js';
import { referenceSchema } from './rich-reference.js';

export const PRESENT_UI_TOOL = 'wisp__present_ui';
export const SKIP_TIP_TOOL = 'wisp__skip_tip';
const key = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
  .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value));

// The same contract validates the Eve tool and its projection/replayed output.
export const replyPresentation = z
  .object({
    nodes: z
      .array(uiNode)
      .max(48)
      .default([])
      .describe(
        'Complete native panel. Parent nodes precede their children. Omit for references only.',
      ),
    references: z
      .record(key, referenceSchema)
      .default({})
      .describe('Verified entity references used by this panel or subsequent [[ref:key]] prose.'),
  })
  .superRefine((value, ctx) => {
    try {
      if (!value.nodes.length && !Object.keys(value.references).length) {
        throw Error('Supply a panel or verified references.');
      }
      if (Object.keys(value.references).length > 64 || JSON.stringify(value).length > 24000) {
        throw Error('Presentation is too large.');
      }
      const seen = new Set<string>();
      for (const node of value.nodes) {
        if (seen.has(node.id)) {
          throw Error('Duplicate component ID.');
        }
        if (node.parent && !seen.has(node.parent)) {
          throw Error('Declare parents before children.');
        }
        validateNode(node, value.nodes);
        if (node.kind === 'reference' && !value.references[node.reference]) {
          throw Error('Declare the component reference in references.');
        }
        seen.add(node.id);
      }
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message });
    }
  });
export type ReplyPresentation = z.infer<typeof replyPresentation>;
