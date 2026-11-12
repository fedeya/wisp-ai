import { z } from 'zod';
import { panelContent } from './panels.ts';

export const TEMPLATE_BYTES = 28000;
const key = z.string().regex(/^n[1-9][0-9]?$/);
// Plain text only: no native markup, reference tokens, URLs or control bytes.
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (s) =>
        // oxlint-disable-next-line no-control-regex -- Untrusted native UI text must be inert.
        !/[|<>\x00-\x1f]|\[\[|\]\(|```|(?:https?:|www\.|data:|javascript:|file:|ftp:|:\/\/)|^\s*\/(?:run|script|cast|use|click|macro)\b/i.test(
          s,
        ),
      'Only plain text is supported (no links or markup)',
    );
const base = { id: key, parent: key.optional() };
const node = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('column'), title: text(120).optional() }),
  z.strictObject({ ...base, kind: z.literal('row'), title: text(120).optional() }),
  z.strictObject({ ...base, kind: z.literal('card'), title: text(120).optional() }),
  z.strictObject({ ...base, kind: z.literal('text'), text: text(3000) }),
  z.strictObject({ ...base, kind: z.literal('stat'), label: text(100) }),
  z.strictObject({ ...base, kind: z.literal('progress'), label: text(100) }),
]);
export const passiveTemplate = z
  .strictObject({
    format: z.literal('wisp-passive-tracker'),
    version: z.literal(1),
    game: z.literal('wow-forever'),
    title: text(100).min(1),
    ui: z.array(node).min(1).max(48),
    bindings: z
      .array(
        z.strictObject({
          nodeId: key,
          source: z.literal('item_count'),
          itemId: z.number().int().positive(),
          target: z.number().int().positive().finite(),
        }),
      )
      .min(1)
      .max(3),
  })
  .superRefine((t, ctx) => {
    const panel = content(t, 'preview');
    const checked = panelContent.safeParse(panel);
    if (!checked.success) ctx.addIssue({ code: 'custom', message: checked.error.message });
    if (
      t.ui.some(
        (n) => ['stat', 'progress'].includes(n.kind) && !t.bindings.some((b) => b.nodeId === n.id),
      )
    ) {
      ctx.addIssue({ code: 'custom', message: 'Every stat/progress must have an item binding' });
    }
    if (new TextEncoder().encode(JSON.stringify(t)).length > TEMPLATE_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'Template is too large' });
    }
  });
export type PassiveTemplate = z.infer<typeof passiveTemplate>;
function content(
  t: { title: string; ui: z.infer<typeof node>[]; bindings: unknown[] },
  id: string,
) {
  return {
    id,
    title: t.title,
    requireItemData: true,
    initiallyHidden: true,
    references: {},
    bindings: t.bindings,
    ui: t.ui.map((n) =>
      n.kind === 'stat'
        ? { ...n, value: 'Loading' }
        : n.kind === 'progress'
          ? { ...n, value: 0 }
          : n,
    ),
  };
}
export function parseTemplate(raw: string): PassiveTemplate {
  if (raw.length > TEMPLATE_BYTES || new TextEncoder().encode(raw).length > TEMPLATE_BYTES) {
    throw Error('Template is too large');
  }
  const value: unknown = JSON.parse(raw, (key, value) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw Error('Forbidden template key');
    }
    return value;
  });
  return passiveTemplate.parse(value);
}
export function instantiateTemplate(template: PassiveTemplate, id: string) {
  return panelContent.parse(content(passiveTemplate.parse(template), id));
}
export function exportTemplate(raw: unknown): PassiveTemplate {
  const panel = panelContent.parse(raw);
  if (Object.keys(panel.references).length) {
    throw Error('Templates with reference catalogs are not supported yet');
  }
  const ids = new Map(panel.ui.map((n, i) => [n.id, `n${i + 1}`]));
  return passiveTemplate.parse({
    format: 'wisp-passive-tracker',
    version: 1,
    game: 'wow-forever',
    title: panel.title,
    ui: panel.ui.map((n) => {
      const base = { id: ids.get(n.id), ...(n.parent ? { parent: ids.get(n.parent) } : {}) };
      if (n.kind === 'stat' || n.kind === 'progress') {
        return { ...base, kind: n.kind, label: n.label };
      }
      if (n.kind === 'text') return { ...base, kind: n.kind, text: n.text };
      if (n.kind === 'card' || n.kind === 'row' || n.kind === 'column') {
        return { ...base, kind: n.kind, ...(n.title !== undefined ? { title: n.title } : {}) };
      }
      throw Error(`Not eligible: unsupported ${n.kind} component`);
    }),
    bindings: panel.bindings.map((b) => ({ ...b, nodeId: ids.get(b.nodeId) })),
  });
}
