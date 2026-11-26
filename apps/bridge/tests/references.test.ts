import { test } from 'vitest';
import assert from 'node:assert/strict';
import { linkedReferences } from '../src/chat/references.ts';
import { turnInput } from '../src/chat/context.ts';
test('user-linked skills retain their verified identity and exact localized label in model context', () => {
  const text =
    'por ahora lo mejor a subir es |cff71d5ff|Hspell:11070:0|h[Descarga de Escarcha mejorada]|h|r?';
  const references = linkedReferences(text);
  assert.equal(references[0].id, 11070);
  assert.equal(references[0].name, 'Descarga de Escarcha mejorada');
  assert.ok(!('reference' in references[0]), 'context contains facts, not ready-made reply markup');
  assert.match(references[0].nativeLink!, /spell:11070:0/);
  const packed = turnInput(text, undefined, { id: 'chat', title: 'Talents', titleGenerated: true });
  const linked = packed.context?.find((block) => block.name === 'linked_references');
  assert.match(JSON.stringify(linked?.data), /"source":"user_link"/);
  assert.equal(packed.text, text, 'the context must not change the message as written');
  assert.equal(
    linkedReferences('Descarga de Escarcha mejorada')[0],
    undefined,
    'plain names do not prove IDs',
  );
  assert.deepEqual(
    linkedReferences('`[Example](spell:122)`'),
    [],
    'code examples must not become reference evidence',
  );
});
