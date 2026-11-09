import { z } from 'zod';
const key = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
  .refine((k) => !['constructor', 'prototype', '__proto__'].includes(k));
export const uiAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ask'), prompt: z.string().min(1).max(1000) }),
  z.object({ kind: z.literal('apply_settings'), transactionId: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('undo_settings'), transactionId: z.string().min(1).max(100) }),
]);
const base = { id: key, parent: key.optional() };
const title = z.string().max(120).optional();
export const uiNode = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('column'), title }),
  z.object({ ...base, kind: z.literal('row'), title }),
  z.object({ ...base, kind: z.literal('card'), title }),
  z.object({
    ...base,
    kind: z.literal('comparison'),
    title,
    unit: z.string().max(24).optional(),
    precision: z.number().int().min(0).max(4).optional(),
    items: z
      .array(
        z.object({
          id: key,
          label: z.string().min(1).max(200),
          value: z.number().finite().nonnegative(),
          detail: z.string().max(300).optional(),
        }),
      )
      .min(2)
      .max(8),
    winner: key.optional(),
    winnerLabel: z.string().min(1).max(60).optional(),
    baseline: key.optional(),
  }),
  z.object({ ...base, kind: z.literal('text'), text: z.string().max(3000) }),
  z.object({
    ...base,
    kind: z.literal('stat'),
    label: z.string().max(100),
    value: z.string().max(200),
    detail: z.string().max(300).optional(),
  }),
  z.object({ ...base, kind: z.literal('reference'), reference: key }),
  z.object({
    ...base,
    kind: z.literal('button'),
    label: z.string().min(1).max(80),
    action: uiAction,
  }),
  z.object({ ...base, kind: z.literal('toggle'), label: z.string().max(100), value: z.boolean() }),
  z.object({
    ...base,
    kind: z.literal('select'),
    label: z.string().max(100),
    value: z.string().max(100),
    options: z
      .array(z.object({ value: z.string().max(100), label: z.string().max(100) }))
      .min(1)
      .max(12),
  }),
  z.object({
    ...base,
    kind: z.literal('slider'),
    label: z.string().max(100),
    value: z.number().finite(),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().positive().finite(),
  }),
  z.object({
    ...base,
    kind: z.literal('progress'),
    label: z.string().max(100),
    value: z.number().min(0).max(1),
  }),
  z.object({ ...base, kind: z.literal('divider') }),
]);
export type UINode = z.infer<typeof uiNode>;
export function validateNode(node: UINode, nodes: UINode[]) {
  if (node.kind === 'comparison') {
    const ids = new Set(node.items.map((item) => item.id));
    if (
      ids.size !== node.items.length ||
      (node.winner !== undefined && !ids.has(node.winner)) ||
      (node.baseline !== undefined && !ids.has(node.baseline))
    ) {
      throw new Error('Invalid comparison item reference');
    }
  }
  if (node.parent === node.id) {
    throw new Error('UI cycle');
  }
  if (
    node.kind === 'slider' &&
    (node.min >= node.max ||
      node.value < node.min ||
      node.value > node.max ||
      node.step > node.max - node.min)
  ) {
    throw new Error('Invalid slider');
  }
  if (
    node.kind === 'select' &&
    (!node.options.some((o) => o.value === node.value) ||
      new Set(node.options.map((o) => o.value)).size !== node.options.length)
  ) {
    throw new Error('Invalid selection');
  }
  const map = new Map(nodes.map((n) => [n.id, n]));
  map.set(node.id, node);
  for (const item of map.values()) {
    const seen = new Set([item.id]);
    let parent = item.parent,
      depth = 0;
    while (parent) {
      if (seen.has(parent) || ++depth > 5) {
        throw new Error('UI nesting limit');
      }
      seen.add(parent);
      const p = map.get(parent);
      if (p && !['column', 'row', 'card'].includes(p.kind)) {
        throw new Error('Invalid UI parent');
      }
      parent = p?.parent;
    }
  }
}
export function selectionValues(nodes: UINode[], input: unknown) {
  const result: Record<string, string | number | boolean> = Object.create(null);
  const supplied = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  for (const node of nodes) {
    if (!['toggle', 'select', 'slider'].includes(node.kind)) {
      continue;
    }
    const value = Object.hasOwn(supplied, node.id)
      ? supplied[node.id]
      : 'value' in node
        ? node.value
        : undefined;
    if (node.kind === 'toggle' && typeof value === 'boolean') {
      result[node.id] = value;
    } else if (
      node.kind === 'select' &&
      typeof value === 'string' &&
      node.options.some((o) => o.value === value)
    ) {
      result[node.id] = value;
    } else if (
      node.kind === 'slider' &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= node.min &&
      value <= node.max
    ) {
      result[node.id] = value;
    } else {
      throw new Error('Invalid panel input');
    }
  }
  return result;
}
