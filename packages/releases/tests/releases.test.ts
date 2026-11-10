import { expect, test } from 'vitest';

import { renderReleaseNotes, newerNightly } from '@wisp/releases';

test('shared Markdown supports rich notes without executing HTML or unsafe URLs', () => {
  const html = renderReleaseNotes(
    '# Hello\n\n- **Improved** updates\n\n![Preview](https://example.com/image.png)\n\n<script>alert(1)</script>\n\n[x](javascript:alert%281%29)\n\n![x](data:text/html,evil)',
  );
  expect(html).toContain('<strong>Improved</strong>');
  expect(html).toContain('<img src="https://example.com/image.png"');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('src="data:');
});
test('nightly comparisons order runs before attempts', () => {
  expect(newerNightly('0.1.1-nightly.10.1', '0.1.1-nightly.9.1')).toBe(true);
  expect(newerNightly('0.1.1-nightly.9.2', '0.1.1-nightly.10.1')).toBe(false);
});
