import { test } from 'vitest';
import assert from 'node:assert/strict';
import { linkedReferences } from '../src/references.ts';

test('native map pins, percentage links and zone-only links keep distinct coordinate semantics', () => {
  const native = linkedReferences(
    '|Hworldmap:1411:4500:6250|h[|A:Waypoint-MapPin-ChatIcon:13:13:0:0|a Lugar]|h',
  )[0];
  assert.equal(native.kind, 'map');
  assert.equal(native.x, 45);
  assert.equal(native.y, 62.5);
  assert.equal(native.mapId, 1411);
  const point = linkedReferences('[Lugar](map:1411:45:62.5)')[0];
  assert.equal(point.mapId, 1411);
  assert.equal(point.y, 62.5);
  const zone = linkedReferences('[Durotar](map:1411)')[0];
  assert.equal(zone.mapId, 1411);
  assert.equal(zone.x, undefined);
  assert.deepEqual(linkedReferences('[Invalid](map:1411:101:2)'), []);
  assert.deepEqual(linkedReferences('|Hspell:0|h[Invalid]|h'), []);
});
