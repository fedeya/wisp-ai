// @effect-migrated
import { Schema } from 'effect';

export const MemorySlot = Schema.Literals(['preferences', 'character']);
export type MemorySlot = typeof MemorySlot.Type;

export const MemoryEntry = Schema.Struct({
  key: Schema.String,
  text: Schema.String,
  updatedAt: Schema.String,
});

const memoryKeyPattern = /^[a-zA-Z0-9_-]{1,64}$/u;
export const memoryTextLimit = 1000;
export const MemoryKey = Schema.String.check(Schema.isPattern(memoryKeyPattern));
export const SaveMemoryInput = Schema.Struct({
  key: MemoryKey,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(memoryTextLimit)),
});
export const RemoveMemoryInput = Schema.Struct({ key: MemoryKey });
const save = { ...SaveMemoryInput.fields, operation: Schema.Literal('save') };
const remove = { ...RemoveMemoryInput.fields, operation: Schema.Literal('remove') };
export const MemoryEdit = Schema.Union([Schema.Struct(save), Schema.Struct(remove)]);
export type MemoryEdit = typeof MemoryEdit.Type;

export const MemoryEntries = Schema.Array(MemoryEntry);
