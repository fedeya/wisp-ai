import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
test('every catalog entry points inside a shipped uncompressed RGBA atlas', () => {
  const data = readFileSync('addon/WispAI/EmojiData.lua', 'utf8');
  const indices = [...data.matchAll(/ = (\d+),/g)].map((match) => Number(match[1]));
  expect(indices).toHaveLength(4009);
  for (let page = 0; page < 4; page++) {
    const atlas = readFileSync(`addon/WispAI/Textures/Emoji/Emoji${page}.tga`);
    expect(atlas[2]).toBe(2);
    expect(atlas.readUInt16LE(12)).toBe(1024);
    expect(atlas.readUInt16LE(14)).toBe(1024);
    expect(atlas[16]).toBe(32);
    expect(atlas.length).toBe(18 + 1024 * 1024 * 4);
    for (const index of indices.filter((index) => Math.floor(index / 1024) === page)) {
      const cell = index % 1024;
      let visible = false;
      for (let dy = 1; dy <= 30 && !visible; dy++) {
        for (let dx = 1; dx <= 30; dx++) {
          const x = (cell % 32) * 32 + dx;
          const y = Math.floor(cell / 32) * 32 + dy;
          if (atlas[18 + ((1023 - y) * 1024 + x) * 4 + 3] > 0) {
            visible = true;
            break;
          }
        }
      }
      expect(visible, `empty emoji cell ${index}`).toBe(true);
    }
  }
});
