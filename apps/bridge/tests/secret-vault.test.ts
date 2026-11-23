import { expect, test } from 'vitest';
import { NativeVault } from '../src/auth/secret-vault.ts';

// Node rejects `--secret` and exits before reading what the vault writes to it,
// so the write hits a closed pipe. That must fail the call, not the bridge.
test('a helper that exits without reading its input fails the call', async () => {
  const vault = new NativeVault(process.execPath);
  await expect(vault.write('key', 'x'.repeat(4 * 1024 * 1024))).rejects.toThrow(
    'Native credential storage failed',
  );
});

test('a helper that cannot start fails the call', async () => {
  const vault = new NativeVault('wisp-missing-helper.exe');
  await expect(vault.read('key')).rejects.toThrow();
});
