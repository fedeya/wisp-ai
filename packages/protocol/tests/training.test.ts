import { test, expect } from 'vitest';
import { trainingInput, inspectionSchema } from '@wisp/protocol/game-inspection';
test('training input validates ranges and supports inspection RPC', () => {
  expect(trainingInput.safeParse({ minLevel: 30, maxLevel: 10 }).success).toBe(false);
  expect(trainingInput.safeParse({ limit: 10000 }).success).toBe(false);
  expect(inspectionSchema.parse({ kind: 'training', args: { query: 'Invisibilidad' } }).kind).toBe(
    'training',
  );
});
