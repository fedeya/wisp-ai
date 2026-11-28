// @effect-migrated
import { Config, ConfigProvider, Effect, Option, Redacted } from 'effect';

/**
 * The key path under which `provider` holds a value spelled like `parts`
 * regardless of case, preferring the exact spelling at each step.
 */
const spelling = Effect.fnUntraced(function* (
  provider: ConfigProvider.ConfigProvider,
  resolved: readonly string[],
  parts: readonly string[],
): Effect.fn.Return<readonly string[] | undefined, ConfigProvider.SourceError> {
  const node = yield* provider.load(resolved);
  const [part, ...rest] = parts;
  if (part === undefined) return node?.value !== undefined ? resolved : undefined;
  const folded = part.toLowerCase();
  const keys = node?._tag === 'Record' ? [...node.keys] : [];
  for (const key of [part, ...keys.filter((key) => key !== part && key.toLowerCase() === folded)]) {
    const found = yield* spelling(provider, [...resolved, key], rest);
    if (found) return found;
  }
  return undefined;
});

/**
 * The name the current `ConfigProvider` keeps a variable under. Windows looks
 * environment variables up regardless of case (`PATH` finds `Path`), but the
 * environment provider matches names exactly as they were set, so on Windows
 * each `_`-separated part of the name is matched against the provider's keys
 * without regard to case.
 */
const providedName = Effect.fnUntraced(function* (name: string) {
  if (process.platform !== 'win32') return name;
  const provider = yield* ConfigProvider.ConfigProvider;
  const found = yield* spelling(provider, [], name.split('_'));
  return found ? found.join('_') : name;
});

/** An environment variable's value; an unset or empty variable is none. */
export const variable = Effect.fnUntraced(function* (name: string) {
  const value = yield* Config.option(Config.String(yield* providedName(name)));
  return Option.filter(value, (text) => text !== '');
});

/** A secret environment variable, kept `Redacted`; an unset or empty variable is none. */
export const secret = Effect.fnUntraced(function* (name: string) {
  const value = yield* Config.option(Config.Redacted(yield* providedName(name)));
  return Option.filter(value, (text) => Redacted.value(text) !== '');
});
