// @effect-migrated
// Reads the whole environment through the active ConfigProvider, for the
// scripts that list variables or match their names as Node's process.env does.
import { ConfigProvider, Effect } from 'effect';

type Variable = readonly [name: string, value: string];

/**
 * Every variable at or below `path`, as name and value. The environment
 * provider splits names at `_` and lists a variable set to '' among its
 * parent's keys, but loads it as missing: a listed key that loads nothing is
 * ''. Under names that are all numbers the provider gives only a length, so
 * an index that loads nothing there is no variable.
 */
const variablesAt = (
  provider: ConfigProvider.ConfigProvider,
  path: ConfigProvider.Path,
  listed: boolean,
): Effect.Effect<readonly Variable[], ConfigProvider.SourceError> =>
  Effect.gen(function* () {
    const node = yield* provider.load(path);
    const name = path.join('_');
    if (node === undefined) {
      return listed ? [[name, '']] : [];
    }
    const own: readonly Variable[] = node.value === undefined ? [] : [[name, node.value]];
    const children =
      node._tag === 'Record'
        ? yield* Effect.forEach(node.keys, (key) => variablesAt(provider, [...path, key], true))
        : node._tag === 'Array'
          ? yield* Effect.forEach(Array.from({ length: node.length }), (_, index) =>
              variablesAt(provider, [...path, index], false),
            )
          : [];
    return [...own, ...children.flat()];
  });

/** Every environment variable, as name and value, including those set to ''. */
export const environmentVariables = Effect.flatMap(ConfigProvider.ConfigProvider, (provider) =>
  variablesAt(provider, [], false),
);

/**
 * The value of the variable `name`, or '' when it is unset. On Windows the
 * name matches without regard to case, as `process.env` reads it there.
 */
export const environmentVariable = Effect.fnUntraced(function* (name: string) {
  const same =
    process.platform === 'win32'
      ? (other: string) => other.toUpperCase() === name.toUpperCase()
      : (other: string) => other === name;
  const found = (yield* environmentVariables).find(([other]) => same(other));
  return found?.[1] ?? '';
});
