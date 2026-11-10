import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function checkDevelopmentTarget(wow: string) {
  const expected = process.env.WISP_DEV_WOW_DIR;
  if (!expected) {
    return;
  }
  const [actual, allowed] = await Promise.all([realpath(wow), realpath(expected)]);
  const normalize = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (
    normalize(actual) !== normalize(allowed) ||
    (await readFile(path.join(actual, '.wisp-dev-owner'), 'utf8')) !== process.env.WISP_DEV_INSTANCE
  ) {
    throw Error(
      'This development instance uses its own WoW target. Configure a dedicated client with pnpm dev:instance target <folder>.',
    );
  }
}
