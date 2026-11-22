// Minimal client for Everloot's public, stateless MCP endpoint, used where the
// bridge composes Everloot data with game reads in a single agent tool call.
const EVERLOOT_MCP = 'https://everloot.app/mcp/public';

export async function callEverloot(
  name: string,
  args: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  const response = await fetcher(EVERLOOT_MCP, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error('Everloot returned HTTP ' + response.status);
  }
  const text = await response.text();
  // Streamable HTTP servers may answer with one SSE event instead of JSON.
  const json = JSON.parse(text.trimStart().startsWith('{') ? text : text.split('data:')[1] || '');
  const result = json?.result;
  if (json?.error || result?.isError || !result?.structuredContent) {
    throw new Error('Everloot could not answer ' + name);
  }
  return result.structuredContent;
}
