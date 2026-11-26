import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { z } from 'zod';

export async function readJson<T>(
  file: string,
  schema: z.ZodType<T>,
  fallback: () => T,
): Promise<T> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback();
    }
    throw error;
  }
  try {
    return schema.parse(JSON.parse(text));
  } catch (cause) {
    throw new Error(`Cannot load ${path.basename(file)}; the original file was preserved.`, {
      cause,
    });
  }
}

export async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, file);
        break;
      } catch (error) {
        if (
          attempt >= 5 ||
          !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code || '')
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
