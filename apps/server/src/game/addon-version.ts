export function addonVersionFromToc(toc: string): string | undefined {
  return toc.match(/^##[\t ]*Version:[\t ]*([^\r\n]+)/m)?.[1].trim() || undefined;
}
