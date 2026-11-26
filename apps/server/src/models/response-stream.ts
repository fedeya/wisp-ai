const MAX_RESPONSE_LENGTH = 32 * 1024 * 1024;
const FAILED_EVENTS = new Set(['response.failed', 'response.incomplete', 'error']);

// Non-streaming SDK calls still use a streamed request upstream. Only a completed
// event is a usable response; partial output must never look like success.
export async function readCompletedResponse(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new Error('ChatGPT returned no response.');
  }

  const decoder = new TextDecoder();
  let pending = '';
  let totalLength = 0;
  let completed: unknown;
  const outputItems = new Map<number, unknown>();

  for await (const bytes of response.body) {
    const chunk = decoder.decode(bytes, { stream: true });
    totalLength += chunk.length;
    if (totalLength > MAX_RESPONSE_LENGTH) {
      throw new Error('Model response is too large');
    }
    pending += chunk;

    let boundary: number;
    while ((boundary = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, boundary).trim();
      pending = pending.slice(boundary + 1);
      if (!line.startsWith('data:')) {
        continue;
      }

      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        continue;
      }

      const event = JSON.parse(data) as {
        type: string;
        response?: unknown;
        output_index?: number;
        item?: unknown;
      };
      if (
        event.type === 'response.output_item.done' &&
        Number.isInteger(event.output_index) &&
        event.output_index! >= 0 &&
        event.output_index! < 1000 &&
        event.item
      ) {
        outputItems.set(event.output_index!, event.item);
      }
      if (FAILED_EVENTS.has(event.type)) {
        throw new Error('ChatGPT did not complete this response.');
      }
      if (event.type === 'response.completed') {
        completed = event.response;
      }
    }
  }

  if (!completed) {
    throw new Error('ChatGPT response was interrupted.');
  }
  // Some subscription streams finalize items separately and leave output empty
  // in response.completed. Preserve those finished items for non-streaming callers.
  if (typeof completed === 'object' && !Array.isArray(completed) && outputItems.size) {
    const response = completed as Record<string, unknown>;
    if (!Array.isArray(response.output) || response.output.length === 0) {
      return {
        ...response,
        output: [...outputItems].sort(([left], [right]) => left - right).map(([, item]) => item),
      };
    }
  }
  return completed;
}
