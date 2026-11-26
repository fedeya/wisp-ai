import { Logger, References } from 'effect';

export function captureLogs() {
  const entries: { name: string; fields: Record<string, unknown> }[] = [];
  const layer = Logger.layer([
    Logger.make(({ fiber }) => {
      const { event: name, ...fields } = fiber.getRef(References.CurrentLogAnnotations);
      if (typeof name === 'string') entries.push({ name, fields });
    }),
  ]);
  return {
    layer,
    entries: (event: string) =>
      entries.filter(({ name }) => name.startsWith(event)).map(({ fields }) => fields),
  };
}
