import { expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigProvider, Effect, FileSystem, Layer, PlatformError } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as AgentConfig from '../src/host/agent-config.ts';
import { readSkills } from '../src/wisp/content.ts';
import * as Wisp from '../src/wisp/wisp-agent.ts';

/** A source checkout's settings: none of the agent's variables are set. */
const sourceConfig = AgentConfig.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
);

test('skills are the folders with a SKILL.md; other entries are skipped', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-skills-'));
  try {
    await mkdir(path.join(root, 'skills/combat'), { recursive: true });
    await writeFile(
      path.join(root, 'skills/combat/SKILL.md'),
      '---\r\nname: combat\r\ndescription: Read the combat log.\r\n---\r\nUse wow__read_combat.\r\n',
    );
    await mkdir(path.join(root, 'skills/empty'));
    await writeFile(path.join(root, 'skills/README.md'), 'Not a skill.');
    expect(
      await Effect.runPromise(readSkills(root).pipe(Effect.provide(NodeFileSystem.layer))),
    ).toEqual([
      {
        name: 'combat',
        description: 'Read the combat log.',
        instructions: 'Use wow__read_combat.',
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Wisp's own skills all load", async () => {
  const skills = await Effect.runPromise(
    Effect.flatMap(AgentConfig.AgentConfig, ({ contentRoot }) => readSkills(contentRoot)).pipe(
      Effect.provide([NodeFileSystem.layer, sourceConfig]),
    ),
  );
  expect(skills.length).toBeGreaterThan(0);
});

test('content retries a failed read and shares the successful load across turns', async () => {
  let reads = 0;
  const fs = FileSystem.layerNoop({
    readDirectory: () => Effect.succeed([]),
    readFileString: (file) =>
      Effect.suspend(() => {
        reads++;
        return reads === 1
          ? Effect.fail(
              PlatformError.systemError({
                _tag: 'NotFound',
                module: 'FileSystem',
                method: 'readFileString',
                pathOrDescriptor: file,
              }),
            )
          : Effect.yieldNow.pipe(Effect.as('Instructions'));
      }),
  });
  const program = Effect.gen(function* () {
    const { content } = yield* Wisp.WispAgent;
    expect(yield* Effect.flip(content)).toMatchObject({ _tag: 'HostError' });
    const loaded = yield* Effect.all([content, content], { concurrency: 2 });
    expect(loaded[0]).toEqual({ system: 'Instructions', skills: [] });
    expect(loaded[1]).toBe(loaded[0]);
    expect(yield* content).toBe(loaded[0]);
  });
  await Effect.runPromise(
    program.pipe(Effect.provide(Wisp.layer), Effect.provide([fs, sourceConfig])),
  );
  expect(reads).toBe(2);
});
