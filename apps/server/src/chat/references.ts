export interface LinkedReference {
  kind: 'item' | 'spell' | 'quest' | 'map' | 'unit' | 'macro';
  name: string;
  id?: number;
  mapId?: number;
  x?: number;
  y?: number;
  guid?: string;
  source: 'user_link';
  nativeLink?: string;
}
function cleanLabel(text: string) {
  return (
    text
      .replace(/\|[AT][\s\S]*?\|[at]/g, '')
      .replace(/\|c[\da-f]{8}|\|r/gi, '')
      // oxlint-disable-next-line no-control-regex -- Strip or reject control bytes in game/UI text.
      .replace(/[[\]|\x00-\x1f]/g, '')
      .trim()
      .slice(0, 160)
  );
}
export function linkedReferences(text: string): LinkedReference[] {
  text = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
  const references: LinkedReference[] = [],
    seen = new Set<string>();
  const add = (reference: LinkedReference) => {
    if (
      !reference.name ||
      seen.has(
        JSON.stringify([
          reference.kind,
          reference.id,
          reference.mapId,
          reference.x,
          reference.y,
          reference.guid,
          reference.nativeLink,
          reference.name,
        ]),
      ) ||
      references.length >= 30
    ) {
      return;
    }
    seen.add(
      JSON.stringify([
        reference.kind,
        reference.id,
        reference.mapId,
        reference.x,
        reference.y,
        reference.guid,
        reference.nativeLink,
        reference.name,
      ]),
    );
    references.push(reference);
  };
  // Every capture group in the patterns below is mandatory, so it takes part in
  // each match; the `undefined` checks only narrow the types.
  for (const [nativeLink, guid, label] of text.matchAll(
    /\|Hunit:([A-Za-z]+-[A-Za-z0-9-]+)\|h([\s\S]*?)\|h/g,
  )) {
    if (guid === undefined || label === undefined) {
      continue;
    }
    add({ kind: 'unit', guid, name: cleanLabel(label), nativeLink, source: 'user_link' });
  }
  for (const [, , hex] of text.matchAll(/\[([^\]]+)\]\(macro:([\da-f]+)\)/gi)) {
    if (hex === undefined) {
      continue;
    }
    const name = Buffer.from(hex, 'hex').toString('utf8');
    // oxlint-disable-next-line no-control-regex -- Strip or reject control bytes in game/UI text.
    if (name && Buffer.byteLength(name) <= 16 && !/[|\x00-\x1f]/.test(name)) {
      add({ kind: 'macro', name, source: 'user_link' });
    }
  }
  for (const [nativeLink, kind, rawId, label] of text.matchAll(
    /\|H(item|spell|quest):(\d+)[^|]*\|h([\s\S]*?)\|h/g,
  )) {
    if (kind === undefined || rawId === undefined || label === undefined) {
      continue;
    }
    const id = Number(rawId),
      name = cleanLabel(label);
    if (Number.isSafeInteger(id) && id > 0) {
      add({
        kind: kind as 'item' | 'spell' | 'quest',
        id,
        name,
        nativeLink,
        source: 'user_link',
      });
    }
  }
  for (const [, label, kind, rawId] of text.matchAll(/\[([^\]]+)\]\((item|spell|quest):(\d+)\)/g)) {
    if (label === undefined || kind === undefined || rawId === undefined) {
      continue;
    }
    const id = Number(rawId),
      name = cleanLabel(label);
    if (Number.isSafeInteger(id) && id > 0) {
      add({ kind: kind as 'item' | 'spell' | 'quest', id, name, source: 'user_link' });
    }
  }
  for (const [nativeLink, rawMapId, rawX, rawY, label] of text.matchAll(
    /\|Hworldmap:(\d+):(\d+):(\d+)[^|]*\|h([\s\S]*?)\|h/g,
  )) {
    if (rawMapId === undefined || rawX === undefined || rawY === undefined || label === undefined) {
      continue;
    }
    const mapId = Number(rawMapId),
      x = Number(rawX) / 100,
      y = Number(rawY) / 100,
      name = cleanLabel(label) || 'Map location';
    if (Number.isSafeInteger(mapId) && mapId > 0 && x <= 100 && y <= 100) {
      add({ kind: 'map', mapId, x, y, name, nativeLink, source: 'user_link' });
    }
  }
  for (const [, label, rawMapId, rawX, rawY] of text.matchAll(
    /\[([^\]]+)\]\(map:(\d+):([\d.]+):([\d.]+)\)/g,
  )) {
    if (label === undefined || rawMapId === undefined || rawX === undefined || rawY === undefined) {
      continue;
    }
    const mapId = Number(rawMapId),
      x = Number(rawX),
      y = Number(rawY),
      name = cleanLabel(label);
    if (
      Number.isSafeInteger(mapId) &&
      mapId > 0 &&
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      x >= 0 &&
      x <= 100 &&
      y >= 0 &&
      y <= 100
    ) {
      add({ kind: 'map', mapId, x, y, name, source: 'user_link' });
    }
  }
  for (const [, label, rawMapId] of text.matchAll(/\[([^\]]+)\]\(map:(\d+)\)/g)) {
    if (label === undefined || rawMapId === undefined) {
      continue;
    }
    const mapId = Number(rawMapId),
      name = cleanLabel(label);
    if (Number.isSafeInteger(mapId) && mapId > 0) {
      add({ kind: 'map', mapId, name, source: 'user_link' });
    }
  }
  return references;
}
