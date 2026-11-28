// @effect-migrated
import { Schema } from 'effect';
import { nodeError, UIKey, uiNode } from './ui-schema.ts';
import { referenceSchema } from './rich-reference.ts';
import {
  Const,
  DiscriminatedUnion,
  KeyedRecord,
  LimitedString,
  PositiveInt,
  withDefault,
} from './tool-inputs.ts';

// Objects here drop unknown keys, as zod's `z.object` did.

const bindingFields = Schema.Struct({
  nodeId: UIKey,
  source: Schema.Literals(['item_count', 'money', 'level', 'quest_completed']),
  itemId: Schema.optionalKey(PositiveInt),
  questId: Schema.optionalKey(PositiveInt),
  target: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
});
export const panelBinding = bindingFields.check(
  Schema.makeFilter((binding) =>
    binding.source === 'item_count' && !binding.itemId
      ? 'itemId is required'
      : binding.source === 'quest_completed' && !binding.questId
        ? 'questId is required'
        : true,
  ),
);

const boundKinds: readonly string[] = ['stat', 'progress'];
const panelFields = {
  id: UIKey,
  title: LimitedString(1, 100),
  ui: Schema.Array(uiNode).check(Schema.isMinLength(1), Schema.isMaxLength(48)),
  references: withDefault(KeyedRecord(UIKey, referenceSchema), () => ({})),
  bindings: withDefault(Schema.Array(panelBinding).check(Schema.isMaxLength(24)), () => []),
};
type PanelFields = Schema.Struct.Type<typeof panelFields>;

/** Why a panel is invalid, or `undefined` when it is valid. */
function panelError(panel: PanelFields): string | undefined {
  if (new Set(panel.ui.map((n) => n.id)).size !== panel.ui.length) {
    return 'Duplicate component ID';
  }
  for (const n of panel.ui) {
    const error = nodeError(n, panel.ui);
    if (error) {
      return error;
    }
    if (n.parent && !panel.ui.some((parent) => parent.id === n.parent)) {
      return 'Missing parent';
    }
    if (n.kind === 'button' && n.action.kind !== 'ask') {
      return 'Persistent panel buttons must send follow-up questions';
    }
  }
  if (Object.keys(panel.references).length > 64 || JSON.stringify(panel).length > 28000) {
    return 'Panel is too large';
  }
  if (new Set(panel.bindings.map((b) => b.nodeId)).size !== panel.bindings.length) {
    return 'Duplicate data binding';
  }
  for (const b of panel.bindings) {
    if (!panel.ui.some((n) => n.id === b.nodeId && boundKinds.includes(n.kind))) {
      return 'Bind data only to stat/progress nodes';
    }
  }
  return undefined;
}
export const panelContent = Schema.Struct(panelFields).check(
  Schema.makeFilter((panel) => panelError(panel) ?? true),
);
export const panelInput = DiscriminatedUnion([
  Schema.Struct({ operation: Const('list') }),
  Schema.Struct({ operation: Const('get'), id: UIKey }),
  Schema.Struct({ operation: Const('save'), panel: panelContent }),
  Schema.Struct({ operation: Const('remove'), id: UIKey }),
]);
export type PanelInput = typeof panelInput.Type;
export type Panel = typeof panelContent.Type & {
  characterKey: string;
  updatedAt: number;
  /** The pre-GUID key this panel moved from, so the addon can keep its saved layout. */
  formerKey?: string;
};
