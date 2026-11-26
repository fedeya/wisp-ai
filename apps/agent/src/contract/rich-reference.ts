import { z } from 'zod';
const label = z
  .string()
  .min(1)
  .max(160)
  // oxlint-disable-next-line no-control-regex -- Strip or reject control bytes in game/UI text.
  .refine((value) => !/[|\x00-\x1f]/.test(value) && !value.includes('[[ref:'));
const id = z.number().int().positive();
const common = { label, source: z.string().max(500).optional() };
const entity = (kind: 'spell' | 'item' | 'quest') =>
  z
    .object({
      ...common,
      kind: z.literal(kind),
      id,
      payload: z
        .string()
        .max(1000)
        .regex(/^(spell|item|quest):[\d:+.-]+$/)
        .optional(),
    })
    .refine(
      (value) =>
        !value.payload ||
        value.payload.startsWith(value.kind + ':' + value.id + ':') ||
        value.payload === value.kind + ':' + value.id,
    );
export const referenceSchema = z.union([
  z.object({
    ...common,
    kind: z.literal('unit'),
    guid: z
      .string()
      .min(3)
      .max(150)
      .regex(/^[A-Za-z]+-[A-Za-z0-9-]+$/),
  }),
  entity('spell'),
  entity('item'),
  entity('quest'),
  z
    .object({
      ...common,
      kind: z.literal('map'),
      mapId: id,
      x: z.number().min(0).max(100).optional(),
      y: z.number().min(0).max(100).optional(),
    })
    .refine((value) => (value.x === undefined) === (value.y === undefined)),
  z.object({
    ...common,
    kind: z.literal('macro'),
    name: z
      .string()
      .min(1)
      .max(16)
      // oxlint-disable-next-line no-control-regex -- Strip or reject control bytes in game/UI text.
      .refine((value) => Buffer.byteLength(value, 'utf8') <= 16 && !/[|\x00-\x1f]/.test(value)),
  }),
]);
export type RichReference = z.infer<typeof referenceSchema>;
export type ReferenceCatalog = Record<string, RichReference>;
