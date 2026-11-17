// Generate small antialiased native TGA icons; no font glyph dependency.
// Icons are white line drawings so the addon can tint them with SetVertexColor.
import { mkdirSync, writeFileSync } from 'node:fs';

const size = 64;
const samples = 4;

type Point = [number, number];
type Shape =
  | { kind: 'line'; from: Point; to: Point; width: number }
  | { kind: 'ring'; center: Point; radius: number; width: number };

function distanceToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function covered(point: Point, shapes: Shape[]) {
  return shapes.some((shape) =>
    shape.kind === 'line'
      ? distanceToSegment(point, shape.from, shape.to) <= shape.width / 2
      : Math.abs(
          Math.hypot(point[0] - shape.center[0], point[1] - shape.center[1]) - shape.radius,
        ) <=
        shape.width / 2,
  );
}

function render(shapes: Shape[]) {
  const tga = Buffer.alloc(18 + size * size * 4);
  tga[2] = 2;
  tga.writeUInt16LE(size, 12);
  tga.writeUInt16LE(size, 14);
  tga[16] = 32;
  tga[17] = 0x28;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let coverage = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          if (covered([x + (sx + 0.5) / samples, y + (sy + 0.5) / samples], shapes)) {
            coverage++;
          }
        }
      }
      const offset = 18 + (y * size + x) * 4;
      tga[offset] = 255;
      tga[offset + 1] = 255;
      tga[offset + 2] = 255;
      tga[offset + 3] = Math.round((255 * coverage) / (samples * samples));
    }
  }
  return tga;
}

// Settings: three sliders, each broken around an open knob.
const knob = 6;
const settings: Shape[] = (
  [
    [16, 22],
    [32, 42],
    [48, 28],
  ] as const
).flatMap(([y, x]): Shape[] => [
  { kind: 'line', from: [10, y], to: [x - knob - 1, y], width: 4.5 },
  { kind: 'line', from: [x + knob + 1, y], to: [54, y], width: 4.5 },
  { kind: 'ring', center: [x, y], radius: knob, width: 4.5 },
]);

// Back: a left chevron.
const back: Shape[] = [
  { kind: 'line', from: [38, 14], to: [20, 32], width: 5 },
  { kind: 'line', from: [20, 32], to: [38, 50], width: 5 },
];

mkdirSync('addon/WispAI/Textures', { recursive: true });
writeFileSync('addon/WispAI/Textures/Settings.tga', render(settings));
writeFileSync('addon/WispAI/Textures/Back.tga', render(back));
