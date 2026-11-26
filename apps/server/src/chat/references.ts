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
  for (const match of text.matchAll(/\|Hunit:([A-Za-z]+-[A-Za-z0-9-]+)\|h([\s\S]*?)\|h/g)) {
    add({
      kind: 'unit',
      guid: match[1],
      name: cleanLabel(match[2]),
      nativeLink: match[0],
      source: 'user_link',
    });
  }
  for (const match of text.matchAll(/\[([^\]]+)\]\(macro:([\da-f]+)\)/gi)) {
    const name = Buffer.from(match[2], 'hex').toString('utf8');
    // oxlint-disable-next-line no-control-regex -- Strip or reject control bytes in game/UI text.
    if (name && Buffer.byteLength(name) <= 16 && !/[|\x00-\x1f]/.test(name)) {
      add({ kind: 'macro', name, source: 'user_link' });
    }
  }
  for (const match of text.matchAll(/\|H(item|spell|quest):(\d+)[^|]*\|h([\s\S]*?)\|h/g)) {
    const id = Number(match[2]),
      name = cleanLabel(match[3]);
    if (Number.isSafeInteger(id) && id > 0) {
      add({
        kind: match[1] as 'item' | 'spell' | 'quest',
        id,
        name,
        nativeLink: match[0],
        source: 'user_link',
      });
    }
  }
  for (const match of text.matchAll(/\[([^\]]+)\]\((item|spell|quest):(\d+)\)/g)) {
    const id = Number(match[3]),
      name = cleanLabel(match[1]);
    if (Number.isSafeInteger(id) && id > 0) {
      add({ kind: match[2] as 'item' | 'spell' | 'quest', id, name, source: 'user_link' });
    }
  }
  for (const match of text.matchAll(/\|Hworldmap:(\d+):(\d+):(\d+)[^|]*\|h([\s\S]*?)\|h/g)) {
    const mapId = Number(match[1]),
      x = Number(match[2]) / 100,
      y = Number(match[3]) / 100,
      name = cleanLabel(match[4]) || 'Map location';
    if (Number.isSafeInteger(mapId) && mapId > 0 && x <= 100 && y <= 100) {
      add({ kind: 'map', mapId, x, y, name, nativeLink: match[0], source: 'user_link' });
    }
  }
  for (const match of text.matchAll(/\[([^\]]+)\]\(map:(\d+):([\d.]+):([\d.]+)\)/g)) {
    const mapId = Number(match[2]),
      x = Number(match[3]),
      y = Number(match[4]),
      name = cleanLabel(match[1]);
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
  for (const match of text.matchAll(/\[([^\]]+)\]\(map:(\d+)\)/g)) {
    const mapId = Number(match[2]),
      name = cleanLabel(match[1]);
    if (Number.isSafeInteger(mapId) && mapId > 0) {
      add({ kind: 'map', mapId, name, source: 'user_link' });
    }
  }
  return references;
}
