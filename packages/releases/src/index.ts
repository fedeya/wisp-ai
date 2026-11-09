import { Marked } from 'marked';

export type ReleaseChannel = 'stable' | 'nightly';
export const stableVersion = /^\d+\.\d+\.\d+$/;
export const nightlyVersion = /^\d+\.\d+\.\d+-nightly\.\d+\.\d+$/;
export function releaseChannel(version: string): ReleaseChannel {
  if (stableVersion.test(version)) {
    return 'stable';
  }
  if (nightlyVersion.test(version)) {
    return 'nightly';
  }
  throw Error(`Unsupported release version: ${version}`);
}
export function newerNightly(candidate: string, previous: string): boolean {
  if (releaseChannel(candidate) !== 'nightly' || releaseChannel(previous) !== 'nightly') {
    throw Error('Expected nightly versions.');
  }
  const parts = (version: string) => version.replace('-nightly.', '.').split('.').map(Number);
  const next = parts(candidate),
    last = parts(previous);
  for (let index = 0; index < next.length; index++) {
    if (next[index] !== last[index]) {
      return next[index] > last[index];
    }
  }
  return false;
}

function escape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? escape(url.href) : null;
  } catch {
    return null;
  }
}
// Both consumers render the same restricted Markdown. Raw HTML and executable URLs
// never reach the DOM; media should use absolute HTTPS URLs in release notes.
const markdown = new Marked({
  renderer: {
    html({ text }) {
      return escape(text);
    },
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      const url = safeUrl(href);
      return url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    },
    image({ href, text }) {
      const url = safeUrl(href);
      return url ? `<img src="${url}" alt="${escape(text)}" loading="lazy" />` : escape(text);
    },
  },
});
export function renderReleaseNotes(notes: string): string {
  return markdown.parse(notes, { async: false });
}
