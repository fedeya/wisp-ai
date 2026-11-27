// A stand-in for the desktop executable's credential helper:
//   node secret-helper-fixture.ts <store> --secret read|write <key>
// Secrets are files in <store>. Some keys act out failures instead.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [store, , operation, key] = process.argv.slice(2);
const file = path.join(store, key);

if (key === 'fails') process.exit(1);
if (key === 'hangs') setInterval(() => {}, 1000);
else if (key === 'too-large') process.stdout.write('x'.repeat(1024 * 1024 + 1));
// Exits before reading its input, so a large write hits a closed pipe.
else if (key === 'exits-early') process.exit(2);
else if (operation === 'write') writeFileSync(file, readFileSync(0));
else {
  try {
    process.stdout.write(readFileSync(file));
  } catch {
    // A key with no value reads as empty.
  }
}
