import { inflateRawSync } from 'node:zlib';

// The files of a .zip archive by path, read from its central directory.
// Handles stored and deflated entries, which is what addon archives use.
export function unzip(archive: Buffer): Map<string, Buffer> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) {
    throw new Error('Not a zip archive: no end of central directory');
  }
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Malformed zip central directory');
    }
    const method = archive.readUInt16LE(offset + 10);
    const compressed = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42);
    // Archives made on Windows may separate folders with backslashes.
    const name = archive
      .toString('utf8', offset + 46, offset + 46 + nameLength)
      .replaceAll('\\', '/');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) {
      continue;
    }
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(start, start + compressed);
    if (method === 0) {
      files.set(name, Buffer.from(data));
    } else if (method === 8) {
      files.set(name, inflateRawSync(data));
    } else {
      throw new Error(`Unsupported zip compression ${method} for ${name}`);
    }
  }
  return files;
}
