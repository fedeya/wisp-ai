export function safeErrorMessage(message: string): string {
  return message
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

// Subscription errors can use {detail} instead of the SDK's {error: {message}}.
export async function normalizeModelError(response: Response): Promise<Response> {
  if (response.ok) {
    return response;
  }
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    detail?: unknown;
    error?: { message?: unknown };
  } | null;
  const message = body?.error?.message ?? body?.detail;
  if (typeof message !== 'string') {
    return response;
  }
  return Response.json(
    { error: { message: safeErrorMessage(message) } },
    {
      status: response.status,
      headers: response.headers.has('retry-after')
        ? { 'retry-after': response.headers.get('retry-after')! }
        : undefined,
    },
  );
}
