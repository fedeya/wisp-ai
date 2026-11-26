import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Effect, Exit, FileSystem, Layer, Scope } from 'effect';
import { DiskConnection } from '../src/connection.ts';

export async function openTransport(
  args: Parameters<typeof DiskConnection.make>,
  overrideFs?: (fs: FileSystem.FileSystem) => FileSystem.FileSystem,
) {
  const scope = Scope.makeUnsafe();
  const fs = overrideFs
    ? Layer.effect(FileSystem.FileSystem, Effect.map(FileSystem.FileSystem, overrideFs)).pipe(
        Layer.provide(NodeFileSystem.layer),
      )
    : NodeFileSystem.layer;
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  try {
    const bridge = await Effect.runPromise(
      DiskConnection.make(...args).pipe(
        Scope.provide(scope),
        Effect.provide(Layer.merge(fs, NodePath.layer)),
      ),
    );
    return { bridge, close };
  } catch (error) {
    await close();
    throw error;
  }
}
