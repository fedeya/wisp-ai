// A stand-in for the eval bridge: node model-bridge-fixture.ts <mode> <pid file> serve
//   serves   prints where it serves, then keeps printing logs until it is stopped
//   fails    reports a failure on stderr and exits with 3
//   garbles  prints a first line that is not the serving line
import { writeFileSync } from 'node:fs';

const [mode, pidFile] = process.argv.slice(2);
writeFileSync(pidFile ?? '', String(process.pid));
if (mode === 'fails') {
  process.stderr.write('Evals are not signed in to ChatGPT.\n');
  process.exit(3);
} else if (mode === 'garbles') {
  process.stdout.write('starting\n');
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(
    JSON.stringify({ url: 'http://127.0.0.1:4567', token: 'secret', model: 'gpt-eval' }) + '\n',
  );
  // More than a pipe holds, so a reader that stopped would leave this blocked.
  setInterval(() => process.stdout.write('log line '.repeat(1000) + '\n'), 1);
}
