// @effect-migrated
import { Schema } from 'effect';
import { nodeError, UIKey, uiNode } from './ui-schema.ts';
import { referenceSchema } from './rich-reference.ts';
import { KeyedRecord, withDefault } from './tool-inputs.ts';

export const PRESENT_UI_TOOL = 'wisp__present_ui';
export const SKIP_TIP_TOOL = 'wisp__skip_tip';

/** Why a presentation is invalid, or `undefined` when it is valid. */
function presentationError(value: typeof presentationFields.Type): string | undefined {
  if (!value.nodes.length && !Object.keys(value.references).length) {
    return 'Supply a panel or verified references.';
  }
  if (Object.keys(value.references).length > 64 || JSON.stringify(value).length > 24000) {
    return 'Presentation is too large.';
  }
  const seen = new Set<string>();
  for (const node of value.nodes) {
    if (seen.has(node.id)) {
      return 'Duplicate component ID.';
    }
    if (node.parent && !seen.has(node.parent)) {
      return 'Declare parents before children.';
    }
    const error = nodeError(node, value.nodes);
    if (error) {
      return error;
    }
    if (node.kind === 'reference' && !value.references[node.reference]) {
      return 'Declare the component reference in references.';
    }
    seen.add(node.id);
  }
  return undefined;
}

// Objects here drop unknown keys, as zod's `z.object` did.
const presentationFields = Schema.Struct({
  nodes: withDefault(
    Schema.Array(uiNode).check(Schema.isMaxLength(48)).annotate({
      description:
        'Complete native panel. Parent nodes precede their children. Omit for references only.',
    }),
    () => [],
  ),
  references: withDefault(
    KeyedRecord(UIKey, referenceSchema).annotate({
      description: 'Verified entity references used by this panel or subsequent [[ref:key]] prose.',
    }),
    () => ({}),
  ),
});

// The same contract validates the agent tool and its projection/replayed output.
export const replyPresentation = presentationFields.check(
  Schema.makeFilter((value) => presentationError(value) ?? true),
);
export type ReplyPresentation = typeof replyPresentation.Type;
