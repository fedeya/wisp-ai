export function conversationTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return;
  }
  const title = [
    ...value
      // oxlint-disable-next-line no-control-regex -- Strip or reject control bytes in game/UI text.
      .replace(/[|`\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, 60)
    .join('');
  return title || undefined;
}
