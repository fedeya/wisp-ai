import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface NativeBuildContext {
  platform: string;
  arch: string;
  rustc: string;
  cargo: string;
  image: string;
  flags: Record<string, string>;
}

export function nativeBuildContext(root = process.cwd()): NativeBuildContext {
  const flags = Object.fromEntries(
    Object.entries(process.env)
      .filter(
        ([name, value]) =>
          value !== undefined &&
          ([
            'RUSTC',
            'RUSTFLAGS',
            'SOURCE_DATE_EPOCH',
            'CARGO_ENCODED_RUSTFLAGS',
            'CARGO_BUILD_RUSTFLAGS',
            'CARGO_BUILD_TARGET',
            'CARGO_INCREMENTAL',
            'RUSTC_WRAPPER',
            'RUSTC_WORKSPACE_WRAPPER',
            'TAURI_CONFIG',
            'CC',
            'CXX',
            'CFLAGS',
            'CXXFLAGS',
            'LDFLAGS',
            'LIB',
            'INCLUDE',
            'LIBPATH',
          ].includes(name) ||
            name.startsWith('CARGO_PROFILE_RELEASE_') ||
            /^CARGO_TARGET_.*_(RUSTFLAGS|LINKER)$/.test(name)),
      )
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  ) as Record<string, string>;
  return {
    platform: process.platform,
    arch: process.arch,
    rustc: execFileSync(process.env.RUSTC || 'rustc', ['-vV'], {
      cwd: path.join(root, 'apps/desktop/src-tauri'),
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
    cargo: execFileSync('cargo', ['-V'], {
      cwd: path.join(root, 'apps/desktop/src-tauri'),
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
    image: [process.env.ImageOS || '', process.env.ImageVersion || ''].join('/'),
    flags,
  };
}

async function sourceFiles(root: string, relative: string): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (
      relative === 'apps/desktop/src-tauri' &&
      ['target', 'resources', 'gen'].includes(entry.name)
    ) {
      continue;
    }
    const child = relative + '/' + entry.name;
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(root, child)));
    } else if (entry.isFile()) {
      files.push(child);
    } else {
      throw Error('Unsupported native build input: ' + child);
    }
  }
  return files;
}

export async function nativeBuildKey(root: string, context: NativeBuildContext): Promise<string> {
  const optional: string[] = [];
  for (const file of [
    'Cargo.toml',
    'Cargo.lock',
    '.cargo/config',
    '.cargo/config.toml',
    'rust-toolchain',
    'rust-toolchain.toml',
  ]) {
    try {
      await readFile(path.join(root, file));
      optional.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  const inputs = [
    ...(await sourceFiles(root, 'apps/desktop/src-tauri')),
    ...(await sourceFiles(root, 'apps/desktop/dist')),
    'pnpm-lock.yaml',
    'package.json',
    'apps/desktop/package.json',
    'scripts/build-desktop.ts',
    'scripts/native-cache.ts',
    'scripts/native-cache-key.ts',
    ...optional,
  ].sort();
  const files = await Promise.all(
    inputs.map(async (file) => ({
      file,
      sha256: createHash('sha256')
        .update(await readFile(path.join(root, file)))
        .digest('hex'),
    })),
  );
  return createHash('sha256')
    .update(JSON.stringify({ schema: 1, context, files }))
    .digest('hex');
}

export async function restoreNativeBinary(
  cache: string,
  key: string,
  destination: string,
): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(path.join(cache, 'build.json'), 'utf8'));
    if (manifest.schema !== 1 || manifest.key !== key) {
      return false;
    }
    const binary = await readFile(path.join(cache, 'wisp.exe'));
    if (!binary.length || createHash('sha256').update(binary).digest('hex') !== manifest.sha256) {
      return false;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, binary);
    if (process.platform !== 'win32') {
      await chmod(destination, 0o755);
    }
    console.log('Native binary reused; SHA-256: ' + manifest.sha256);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return false;
    }
    throw error;
  }
}

export async function saveNativeBinary(
  cache: string,
  key: string,
  executable: string,
): Promise<void> {
  const sha256 = createHash('sha256')
    .update(await readFile(executable))
    .digest('hex');
  await mkdir(cache, { recursive: true });
  await copyFile(executable, path.join(cache, 'wisp.exe'));
  await writeFile(path.join(cache, 'build.json'), JSON.stringify({ schema: 1, key, sha256 }));
  console.log('Optimized native binary cached; SHA-256: ' + sha256);
}
