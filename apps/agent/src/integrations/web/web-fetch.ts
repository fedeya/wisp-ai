import { impitClient } from './impit-client.ts';
import TurndownService from 'turndown';
import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { WebFetchPages } from './web-fetch-pages.ts';
import { publicWebTunnel, publicWebUrl } from './public-web-tunnel.ts';

const maxBytes = 5 * 1024 * 1024;
const pages = new WebFetchPages();
export const webFetchInput = z.object({
  url: z
    .string()
    .url()
    .describe('Public HTTPS URL. For continuation, reuse the original or returned URL.'),
  format: z.enum(['markdown', 'text', 'html']).optional(),
  timeout: z
    .number()
    .positive()
    .optional()
    .describe('Timeout in seconds; default 30, maximum 120.'),
  cursor: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Copy nextCursor from the previous result to continue the same snapshot. Omit to fetch a fresh page.',
    ),
});
export const webFetchOutput = z.object({
  content: z.string(),
  contentType: z.string(),
  url: z.string(),
  truncated: z.boolean(),
  startOffset: z.number(),
  endOffset: z.number(),
  totalCharacters: z.number(),
  nextCursor: z.string().optional(),
});
export type WebFetchInput = z.infer<typeof webFetchInput>;
export const navigationHeaders = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

function convertHtml(html: string, url: URL, format: string) {
  if (format === 'html') {
    return html;
  }
  const { document } = parseHTML(html);
  document
    .querySelectorAll('script, style, noscript, template, meta, link')
    .forEach((el) => el.remove());
  for (const el of document.querySelectorAll('[href], [src]')) {
    for (const name of ['href', 'src']) {
      const value = el.getAttribute(name);
      if (value) {
        try {
          el.setAttribute(name, new URL(value, url).href);
        } catch {
          el.removeAttribute(name);
        }
      }
    }
  }
  if (format === 'text') {
    document
      .querySelectorAll('p, div, h1, h2, h3, li, tr, br')
      .forEach((el) => el.appendChild(document.createTextNode('\n')));
    return (document.documentElement.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
  }
  return new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  }).turndown(document.toString());
}

export async function fetchWebPage(
  input: WebFetchInput,
  abortSignal?: AbortSignal,
  owner = 'standalone',
): Promise<z.infer<typeof webFetchOutput>> {
  abortSignal?.throwIfAborted();
  let url = publicWebUrl(input.url);
  if (input.cursor !== undefined) {
    return pages.next(input.cursor, url.href, owner, input.format);
  }
  const timeout = input.timeout ?? 30;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('Timeout must be greater than zero.');
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(Math.min(timeout * 1000, 120000)),
    ...(abortSignal ? [abortSignal] : []),
  ]);
  const tunnel = await publicWebTunnel(signal);
  try {
    const client = impitClient({
      browser: 'chrome',
      headers: navigationHeaders,
      proxyUrl: tunnel.proxyUrl,
      timeout: Math.min(timeout * 1000, 120000),
    });
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      tunnel.allow(url);
      const response = await client.fetch(url, { redirect: 'manual', signal });
      const location = response.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        await response.body?.cancel();
        if (redirects >= 10) {
          throw new Error('Too many web redirects.');
        }
        url = publicWebUrl(new URL(location, url).href);
        continue;
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw new Error('Response too large (exceeds 5 MB).');
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            size += value.byteLength;
            if (size > maxBytes) {
              throw new Error('Response too large (exceeds 5 MB).');
            }
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      signal.throwIfAborted();
      const contentType = response.headers.get('content-type') ?? '';
      const raw = Buffer.concat(chunks).toString('utf8');
      const html =
        /text\/html|application\/xhtml\+xml/i.test(contentType) ||
        (!contentType && /^\s*<(?:!doctype\s+html|html)[\s>]/i.test(raw));
      let content = html ? convertHtml(raw, url, input.format ?? 'markdown') : raw;
      if (!response.ok) {
        content = `Request failed with status code: ${response.status}\n\n${content}`;
      }
      return pages.first({
        content,
        contentType,
        url: url.href,
        requestedUrl: new URL(input.url).href,
        format: input.format ?? 'markdown',
        owner,
      });
    }
  } catch (error) {
    throw tunnel.failure() ?? error;
  } finally {
    tunnel.close();
  }
}
