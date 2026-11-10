import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export function developmentLayout(root: string, common: string, shared?: string) {
  root = path.resolve(root);
  const identity = process.platform === 'win32' ? root.toLowerCase() : root;
  const id = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  const data = path.join(root, 'runtime', 'dev-instance');
  return {
    id,
    root,
    data,
    shared: path.resolve(shared || path.join(common, 'wisp-dev', 'shared')),
    wow: path.join(data, 'wow'),
    native: path.join(data, 'native-target'),
  };
}
async function optionalCopy(source: string, destination: string, recursive = false) {
  try {
    await cp(source, destination, { recursive, force: false, errorOnExist: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

// Seeding only reads the source; unlike desktop import it never stops its bridge.
export async function seedDevelopmentProfile(source: string, shared: string) {
  const { ApplicationDatabase } = await import('@wisp/bridge/db/application-database');
  const { copyDatabaseSnapshot, findApplicationDatabase } =
    await import('@wisp/bridge/db/application-file');
  const { ChatStore } = await import('@wisp/bridge/chat-store');
  source = path.resolve(source);
  shared = path.resolve(shared);
  if (source === shared || shared.startsWith(source + path.sep)) {
    throw Error('Choose a separate shared development directory.');
  }
  const config = JSON.parse(await readFile(path.join(source, 'config.local.json'), 'utf8'));
  await mkdir(path.dirname(shared), { recursive: true });
  await mkdir(shared); // Never overwrite an existing profile.
  const incomplete = path.join(shared, '.seed-incomplete');
  await writeFile(incomplete, source, { flag: 'wx', mode: 0o600 });
  const runtime = path.join(shared, 'runtime');
  await mkdir(runtime);
  const sourceDatabase = await findApplicationDatabase(path.join(source, 'runtime'));
  if (sourceDatabase) {
    await copyDatabaseSnapshot(sourceDatabase, path.join(runtime, 'wisp.sqlite'));
  }
  for (const name of ['chats.json', 'memory', 'panels.json', 'routines.json', 'connections.json']) {
    await optionalCopy(
      path.join(source, 'runtime', name),
      path.join(runtime, name),
      name === 'memory',
    );
  }
  const database = new ApplicationDatabase(path.join(runtime, 'wisp.sqlite'));
  try {
    await database.initializeProducts();
    const chats = new ChatStore(database, () => {});
    try {
      await chats.load();
    } finally {
      await chats.close();
    }
    database.connection.exec(
      'DELETE FROM chat_instance_state; DELETE FROM workspace_drafts; DELETE FROM routine_instance_state;',
    );
    database.connection.exec(
      "UPDATE chats SET status='interrupted' WHERE status='working'; DELETE FROM metadata WHERE key LIKE 'dev-lock:%';",
    );
  } finally {
    await database.close();
  }
  const connections = (await readFile(path.join(runtime, 'connections.json'), 'utf8')
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    })) as { id: string }[];
  if (process.platform === 'win32') {
    await mkdir(path.join(shared, 'secrets'));
    // API keys are reusable. A copied rotating OAuth refresh token would race
    // with the source app; sign into the shared dev profile once instead.
    for (const key of connections.map((c) => 'ai-connection:' + c.id)) {
      const name = createHash('sha256').update(key).digest('hex') + '.bin';
      await optionalCopy(path.join(source, 'secrets', name), path.join(shared, 'secrets', name));
    }
  }
  await writeFile(
    path.join(shared, 'defaults.json'),
    JSON.stringify({ model: config.model || '' }),
    { mode: 0o600 },
  );
  await unlink(incomplete);
}
export async function assertProfileReady(shared: string) {
  try {
    await access(path.join(shared, '.seed-incomplete'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw Error(
    'The shared development profile has an incomplete seed. Preserve it and choose another WISP_SHARED_DATA_DIR.',
  );
}
export async function claimDevelopmentTarget(folder: string, id: string) {
  folder = path.resolve(folder);
  await access(path.join(folder, 'Wow.exe'));
  const marker = path.join(folder, '.wisp-dev-owner');
  try {
    if ((await readFile(marker, 'utf8')) !== id) {
      throw Error('This WoW client belongs to another development instance.');
    }
    return folder;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  try {
    await access(path.join(folder, 'Interface', 'AddOns', 'WispAI'));
    throw Error(
      'This client already has a production addon. Use a dedicated WoW client directory.',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  await writeFile(marker, id, { flag: 'wx' });
  return folder;
}
