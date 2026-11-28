// @effect-migrated
import { Predicate, Schema } from 'effect';
import {
  Const,
  DiscriminatedUnion,
  IntBetween,
  LimitedString,
  NumberBetween,
  refine,
} from './tool-inputs.ts';

// Objects here drop unknown keys, as zod's `z.object` did.

const reservedKeys: readonly string[] = ['constructor', 'prototype', '__proto__'];
/** A component, reference or panel key; the `u` flag lets the pattern reach the model. */
export const UIKey = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u),
  refine((key) => !reservedKeys.includes(key), 'Invalid input'),
);
const MaxString = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));
const Finite = Schema.Finite;

const transactionId = LimitedString(1, 100);
export const uiAction = DiscriminatedUnion([
  Schema.Struct({ kind: Const('ask'), prompt: LimitedString(1, 1000) }),
  Schema.Struct({ kind: Const('apply_settings'), transactionId }),
  Schema.Struct({ kind: Const('undo_settings'), transactionId }),
]);
const base = { id: UIKey, parent: Schema.optionalKey(UIKey) };
const title = Schema.optionalKey(MaxString(120));
const container = (kind: 'column' | 'row' | 'card') =>
  Schema.Struct({ ...base, kind: Const(kind), title });
export const uiNode = DiscriminatedUnion([
  container('column'),
  container('row'),
  container('card'),
  Schema.Struct({
    ...base,
    kind: Const('table'),
    title,
    columns: Schema.Array(
      Schema.Struct({
        label: LimitedString(1, 100),
        align: Schema.optionalKey(Schema.Literals(['left', 'center', 'right'])),
      }),
    ).check(Schema.isMinLength(2), Schema.isMaxLength(6)),
    rows: Schema.Array(
      Schema.Array(MaxString(300)).check(Schema.isMinLength(2), Schema.isMaxLength(6)),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  }).check(
    refine(
      (node) => node.rows.every((row) => row.length === node.columns.length),
      'Table rows must match the columns',
    ),
  ),
  Schema.Struct({
    ...base,
    kind: Const('comparison'),
    title,
    unit: Schema.optionalKey(MaxString(24)),
    precision: Schema.optionalKey(IntBetween(0, 4)),
    items: Schema.Array(
      Schema.Struct({
        id: UIKey,
        label: LimitedString(1, 200),
        value: Finite.check(Schema.isGreaterThanOrEqualTo(0)),
        detail: Schema.optionalKey(MaxString(300)),
      }),
    ).check(Schema.isMinLength(2), Schema.isMaxLength(8)),
    winner: Schema.optionalKey(UIKey),
    winnerLabel: Schema.optionalKey(LimitedString(1, 60)),
    baseline: Schema.optionalKey(UIKey),
  }),
  Schema.Struct({ ...base, kind: Const('text'), text: MaxString(3000) }),
  Schema.Struct({
    ...base,
    kind: Const('stat'),
    label: MaxString(100),
    value: MaxString(200),
    detail: Schema.optionalKey(MaxString(300)),
  }),
  Schema.Struct({ ...base, kind: Const('reference'), reference: UIKey }),
  Schema.Struct({ ...base, kind: Const('button'), label: LimitedString(1, 80), action: uiAction }),
  Schema.Struct({ ...base, kind: Const('toggle'), label: MaxString(100), value: Schema.Boolean }),
  Schema.Struct({
    ...base,
    kind: Const('select'),
    label: MaxString(100),
    value: MaxString(100),
    options: Schema.Array(Schema.Struct({ value: MaxString(100), label: MaxString(100) })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(12),
    ),
  }),
  Schema.Struct({
    ...base,
    kind: Const('slider'),
    label: MaxString(100),
    value: Finite,
    min: Finite,
    max: Finite,
    step: Finite.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({
    ...base,
    kind: Const('progress'),
    label: MaxString(100),
    value: NumberBetween(0, 1),
  }),
  Schema.Struct({ ...base, kind: Const('divider') }),
]);
export type UINode = typeof uiNode.Type;

const containerKinds: readonly string[] = ['column', 'row', 'card'];

/**
 * Why `node` cannot join `nodes`, or `undefined` when it can: its references
 * resolve, its control is consistent, and its parents are containers at most
 * five deep without a cycle.
 */
export function nodeError(node: UINode, nodes: readonly UINode[]): string | undefined {
  if (node.kind === 'comparison') {
    const ids = new Set(node.items.map((item) => item.id));
    if (
      ids.size !== node.items.length ||
      (node.winner !== undefined && !ids.has(node.winner)) ||
      (node.baseline !== undefined && !ids.has(node.baseline))
    ) {
      return 'Invalid comparison item reference';
    }
  }
  if (node.parent === node.id) {
    return 'UI cycle';
  }
  if (
    node.kind === 'slider' &&
    (node.min >= node.max ||
      node.value < node.min ||
      node.value > node.max ||
      node.step > node.max - node.min)
  ) {
    return 'Invalid slider';
  }
  if (
    node.kind === 'select' &&
    (!node.options.some((o) => o.value === node.value) ||
      new Set(node.options.map((o) => o.value)).size !== node.options.length)
  ) {
    return 'Invalid selection';
  }
  const map = new Map(nodes.map((n) => [n.id, n]));
  map.set(node.id, node);
  for (const item of map.values()) {
    const seen = new Set([item.id]);
    let parent = item.parent,
      depth = 0;
    while (parent) {
      if (seen.has(parent) || ++depth > 5) {
        return 'UI nesting limit';
      }
      seen.add(parent);
      const p = map.get(parent);
      if (p && !containerKinds.includes(p.kind)) {
        return 'Invalid UI parent';
      }
      parent = p?.parent;
    }
  }
  return undefined;
}

/** The value of each control in `nodes`: from `input` where it names one, else the control's own. */
export type SelectionValues = Record<string, string | number | boolean>;

/** The controls' values, or `undefined` when `input` gives one a value it cannot take. */
export function selectionValues(
  nodes: readonly UINode[],
  input: unknown,
): SelectionValues | undefined {
  const values: [string, string | number | boolean][] = [];
  for (const node of nodes) {
    if (node.kind !== 'toggle' && node.kind !== 'select' && node.kind !== 'slider') {
      continue;
    }
    const value =
      Predicate.isObjectOrArray(input) &&
      Object.hasOwn(input, node.id) &&
      Predicate.hasProperty(input, node.id)
        ? input[node.id]
        : node.value;
    if (node.kind === 'toggle' && Predicate.isBoolean(value)) {
      values.push([node.id, value]);
    } else if (
      node.kind === 'select' &&
      Predicate.isString(value) &&
      node.options.some((o) => o.value === value)
    ) {
      values.push([node.id, value]);
    } else if (
      node.kind === 'slider' &&
      Predicate.isNumber(value) &&
      Number.isFinite(value) &&
      value >= node.min &&
      value <= node.max
    ) {
      values.push([node.id, value]);
    } else {
      return undefined;
    }
  }
  return Object.fromEntries(values);
}
