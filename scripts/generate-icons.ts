// Generate small antialiased native TGA icons; no font glyph dependency.
// Icons are white line drawings so the addon can tint them with SetVertexColor.
import { mkdirSync, writeFileSync } from 'node:fs';

// Icons are drawn on a 64-unit design grid and written at 32 px, close to the
// 15-30 px they appear at in game; corner pieces are 16 px and drawn 1:1. The
// client makes no mipmaps, so shrinking a texture a lot leaves jagged edges.
const DESIGN_SIZE = 64;
const ICON_SIZE = 32;
const samples = 4;

type Point = [number, number];
type Shape =
  | { kind: 'line'; from: Point; to: Point; width: number }
  | { kind: 'ring'; center: Point; radius: number; width: number }
  | { kind: 'rect'; from: Point; to: Point }
  | { kind: 'disc'; center: Point; radius: number };

function distanceToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function coveredBy([x, y]: Point, shape: Shape) {
  switch (shape.kind) {
    case 'line':
      return distanceToSegment([x, y], shape.from, shape.to) <= shape.width / 2;
    case 'ring':
      return (
        Math.abs(Math.hypot(x - shape.center[0], y - shape.center[1]) - shape.radius) <=
        shape.width / 2
      );
    case 'disc':
      return Math.hypot(x - shape.center[0], y - shape.center[1]) <= shape.radius;
    case 'rect':
      return x >= shape.from[0] && x <= shape.to[0] && y >= shape.from[1] && y <= shape.to[1];
  }
}

function covered(point: Point, shapes: Shape[]) {
  return shapes.some((shape) => coveredBy(point, shape));
}

function render(shapes: Shape[], size = ICON_SIZE, design = DESIGN_SIZE) {
  const scale = design / size;
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
          const point: Point = [
            (x + (sx + 0.5) / samples) * scale,
            (y + (sy + 0.5) / samples) * scale,
          ];
          if (covered(point, shapes)) {
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

// Send: an arrow pointing up.
const send: Shape[] = [
  { kind: 'line', from: [32, 52], to: [32, 13], width: 6 },
  { kind: 'line', from: [16, 29], to: [32, 13], width: 6 },
  { kind: 'line', from: [48, 29], to: [32, 13], width: 6 },
];

// Stop: a solid square.
const stop: Shape[] = [{ kind: 'rect', from: [19, 19], to: [45, 45] }];

// New chat: a plus.
const plus: Shape[] = [
  { kind: 'line', from: [32, 14], to: [32, 50], width: 5 },
  { kind: 'line', from: [14, 32], to: [50, 32], width: 5 },
];

// Routines: a clock.
const clock: Shape[] = [
  { kind: 'ring', center: [32, 32], radius: 21, width: 4.5 },
  { kind: 'line', from: [32, 32], to: [32, 19], width: 4.5 },
  { kind: 'line', from: [32, 32], to: [41, 38], width: 4.5 },
];

// Menus: a downward chevron.
const chevronDown: Shape[] = [
  { kind: 'line', from: [20, 26], to: [32, 38], width: 5 },
  { kind: 'line', from: [32, 38], to: [44, 26], width: 5 },
];

// Round controls: a filled circle.
const circle: Shape[] = [{ kind: 'disc', center: [32, 32], radius: 31.5 }];

// Rounded boxes: a top-left corner of radius CORNER_RADIUS, filled and as a
// one-pixel outline, drawn 1:1 in pixels in the texture's bottom-right. The
// addon crops the texture to that quarter and mirrors it for the other corners.
const CORNER = 16;
const CORNER_RADIUS = 10;
const cornerFill: Shape[] = [{ kind: 'disc', center: [CORNER, CORNER], radius: CORNER_RADIUS }];
const cornerEdge: Shape[] = [
  { kind: 'ring', center: [CORNER, CORNER], radius: CORNER_RADIUS - 0.5, width: 1 },
];

// Sidebar toggle: a window outline with its left panel marked off.
const sidebar: Shape[] = [
  { kind: 'line', from: [10, 14], to: [54, 14], width: 4.5 },
  { kind: 'line', from: [10, 50], to: [54, 50], width: 4.5 },
  { kind: 'line', from: [10, 14], to: [10, 50], width: 4.5 },
  { kind: 'line', from: [54, 14], to: [54, 50], width: 4.5 },
  { kind: 'line', from: [26, 14], to: [26, 50], width: 4.5 },
];

// Close / delete: an X.
const close: Shape[] = [
  { kind: 'line', from: [18, 18], to: [46, 46], width: 5 },
  { kind: 'line', from: [46, 18], to: [18, 46], width: 5 },
];

mkdirSync('addon/WispAI/Textures', { recursive: true });
writeFileSync('addon/WispAI/Textures/Settings.tga', render(settings));
writeFileSync('addon/WispAI/Textures/Back.tga', render(back));
writeFileSync('addon/WispAI/Textures/Send.tga', render(send));
writeFileSync('addon/WispAI/Textures/Stop.tga', render(stop));
writeFileSync('addon/WispAI/Textures/Plus.tga', render(plus));
writeFileSync('addon/WispAI/Textures/Close.tga', render(close));
writeFileSync('addon/WispAI/Textures/Sidebar.tga', render(sidebar));
writeFileSync('addon/WispAI/Textures/Clock.tga', render(clock));
writeFileSync('addon/WispAI/Textures/ChevronDown.tga', render(chevronDown));
writeFileSync('addon/WispAI/Textures/Circle.tga', render(circle));
writeFileSync('addon/WispAI/Textures/CornerFill.tga', render(cornerFill, CORNER, CORNER));
writeFileSync('addon/WispAI/Textures/CornerEdge.tga', render(cornerEdge, CORNER, CORNER));
