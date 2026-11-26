import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

process.env.WISP_ENGINE_EXECUTABLE = process.execPath;
process.env.WISP_RESOURCE_ROOT ||= path.dirname(process.execPath);
// The agent's instructions and skills are assets next to this entry point.
process.env.WISP_AGENT_CONTENT = fileURLToPath(new URL('./agent/', import.meta.url));
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
  const content = process.env.WISP_AGENT_CONTENT;
  const skills = readdirSync(path.join(content, 'skills'));
  if (!existsSync(path.join(content, 'instructions.md')) || !skills.length) {
    throw Error('The agent instructions or skills are missing from the packaged engine.');
  }
  console.log(
    JSON.stringify({
      engine: true,
      sqlite: true,
      node: process.versions.node,
      agent: true,
      skills: skills.length,
    }),
  );
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
