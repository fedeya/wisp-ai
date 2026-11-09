import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

process.env.WISP_ENGINE_EXECUTABLE = process.execPath;
process.env.WISP_RESOURCE_ROOT ||= path.dirname(process.execPath);
const mode = process.argv[2] || 'src/main.ts';
if (mode === '--version') {
  console.log(`Wisp engine (Node ${process.versions.node})`);
} else if (mode === '--self-test') {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE wisp_sqlite_probe(value TEXT) STRICT');
  db.prepare('INSERT INTO wisp_sqlite_probe VALUES (?)').run('ok');
  if (db.prepare('SELECT value FROM wisp_sqlite_probe').get().value !== 'ok') {
    throw Error('SQLite is unavailable in the packaged engine.');
  }
  db.close();
  const metadata = JSON.parse(
    readFileSync(fileURLToPath(new URL('./eve/package.json', import.meta.url)), 'utf8'),
  );
  console.log(
    JSON.stringify({ engine: true, sqlite: true, node: process.versions.node, eve: metadata.name }),
  );
} else if (mode === '--eve') {
  process.env.NITRO_HOST = '127.0.0.1';
  process.env.NITRO_PORT = process.argv[3] || '43186';
  process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${process.env.NITRO_PORT}`;
  delete process.env.EVE_DEV;
  await import('./eve/index.mjs');
} else if (mode === '--npx') {
  process.argv.splice(1, 2, fileURLToPath(new URL('./npm/bin/npx-cli.js', import.meta.url)));
  process.execPath = path.join(process.env.WISP_RESOURCE_ROOT, 'runtime/node.exe');
  await import('./npm/bin/npx-cli.js');
} else {
  const commands = {
    'src/main.ts': './bridge.mjs',
    'scripts/install.ts': './install.mjs',
    'scripts/migrate-desktop.ts': './migrate-desktop.mjs',
  };
  if (Object.hasOwn(commands, mode)) {
    process.argv.splice(1, 2, fileURLToPath(new URL(commands[mode], import.meta.url)));
    await import(commands[mode]);
  } else {
    // npm lifecycle commands may re-enter this executable through pkg's Node
    // compatibility shim. External MCP programs run in the bundled stock runtime.
    const child = spawn(
      path.join(process.env.WISP_RESOURCE_ROOT, 'runtime/node.exe'),
      process.argv.slice(2),
      {
        stdio: 'inherit',
        windowsHide: true,
      },
    );
    child.on('error', (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
  }
}
