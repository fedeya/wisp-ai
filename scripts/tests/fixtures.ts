import { Effect, FileSystem, Path } from 'effect';
import { output } from '../child-process.ts';

/** A temporary directory removed when the test's scope closes. */
export const temporaryDirectory = (prefix: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix }));

/** Writes each file under `root`, creating its folders. */
export const writeFiles = Effect.fnUntraced(function* (
  root: string,
  files: Readonly<Record<string, string>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [file, content] of Object.entries(files)) {
    yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
    yield* fs.writeFileString(path.join(root, file), content);
  }
});

/** Runs git in `root` as a fixture author, without the repository's hooks; returns its trimmed output. */
export const gitIn =
  (root: string) =>
  (...args: string[]) =>
    output(
      'git',
      [
        '-c',
        `core.hooksPath=${root}/.no-hooks`,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: root },
    ).pipe(Effect.map((text) => text.trim()));
