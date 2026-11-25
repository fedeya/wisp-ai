import path from 'node:path';

/** Stock Node binary staged beside a packaged engine. Windows keeps the .exe name. */
export function runtimeNodeName() {
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

export function packagedRuntimeNode(root) {
  return path.join(root, 'runtime', runtimeNodeName());
}
