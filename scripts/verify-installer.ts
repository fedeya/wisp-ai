import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, access, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'eve/client';
import { installerBuildVersion } from './installer-version.ts';
const exec = promisify(execFile);
if (!process.env.CI || !process.env.APPDATA) {
  throw Error('Run installer verification in a disposable Windows CI profile.');
}
const sourceVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const installer = path.resolve(
  process.argv[2] || `dist/WispAI-${sourceVersion}-windows-x64-setup.exe`,
);
const version = installerBuildVersion(
  installer,
  JSON.parse(await readFile(path.join(path.dirname(installer), 'latest.json'), 'utf8')),
);
const temporary = await mkdtemp(path.join(tmpdir(), 'wisp-installer-'));
if (!temporary.startsWith(path.resolve(tmpdir()) + path.sep)) {
  throw Error('Unsafe test directory.');
}
const target = path.join(temporary, 'Installed'),
  data = path.join(process.env.APPDATA, 'com.wisp.ai');
let child: ReturnType<typeof spawn> | undefined;
try {
  const installStarted = performance.now();
  await exec(installer, ['/S', '/D=' + target], { windowsHide: true, timeout: 180000 });
  const installMilliseconds = performance.now() - installStarted;
  const executable = path.join(target, 'wisp.exe'),
    payload = path.join(target, 'payload');
  await access(executable);
  for (const name of [
    'config.local.json',
    '.eve',
    'runtime/chats.json',
    'runtime/chatgpt-host.json',
    'secrets',
    'tests',
    'apps/desktop',
    'src-tauri',
    'node_modules/@wisp/desktop',
  ]) {
    try {
      await access(path.join(payload, name));
      throw Error('Personal data included: ' + name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  await mkdir(data, { recursive: true });
  try {
    await access(path.join(data, 'config.local.json'));
    throw Error('Installer verification requires a fresh user profile.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const env = {
    ...process.env,
    WISP_DATA_DIR: data,
    WISP_RESOURCE_ROOT: payload,
    WISP_DESKTOP_EXE: executable,
  };
  await exec(executable, ['--self-test'], { env, windowsHide: true, timeout: 30000 });
  let log = '';
  const node = path.join(payload, 'runtime/node.exe');
  const engine = path.join(payload, 'wisp-engine.exe');
  await access(engine);
  const wow = path.join(temporary, 'fake WoW client');
  await mkdir(wow);
  await writeFile(path.join(wow, 'Wow.exe'), '');
  await exec(engine, ['scripts/install.ts', wow], {
    cwd: payload,
    env,
    windowsHide: true,
    timeout: 60000,
  });
  for (const relative of [
    'WispAI/WispAI.toc',
    'WispAI_B001/WispAI_B001.toc',
    'WispAI_S0001/WispAI_S0001.toc',
  ]) {
    const toc = await readFile(path.join(wow, 'Interface/AddOns', relative), 'utf8');
    if (toc.match(/^## Version: ([^\r\n]+)/m)?.[1] !== version) {
      throw Error('Installed addon version does not match the release: ' + relative);
    }
  }
  const payloadFiles = (await readdir(payload, { recursive: true, withFileTypes: true })).filter(
    (entry) => entry.isFile(),
  ).length;
  for (const name of ['node_modules', 'runtime/npm']) {
    try {
      await access(path.join(payload, name));
      throw Error('Installer extracted loose dependencies: ' + name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  child = spawn(engine, ['src/main.ts'], {
    cwd: payload,
    env: {
      ...env,
      PATH: path.dirname(node) + ';' + path.join(process.env.WINDIR || 'C:\\Windows', 'System32'),
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (bytes) => {
    log = (log + bytes).slice(-8000);
  });
  child.stderr?.on('data', (bytes) => {
    log = (log + bytes).slice(-8000);
  });
  const client = new Client({ baseUrl: 'http://127.0.0.1:43186' });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      await client.health();
      ready = true;
      break;
    } catch {}
    if (child.exitCode !== null) {
      throw Error('Installed bridge exited: ' + log);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!ready) {
    throw Error('Installed agent did not become ready: ' + log);
  }
  if (!JSON.stringify(await client.health()).includes('ready')) {
    throw Error('Installed agent did not discover its tools.');
  }
  const identity = JSON.parse(await readFile(path.join(data, 'runtime/desktop.json'), 'utf8'));
  if (identity.pid !== child.pid) {
    throw Error('Installer test reached a different bridge.');
  }
  const headers = { authorization: 'Bearer ' + identity.token, 'content-type': 'application/json' };
  const response = await fetch('http://127.0.0.1:' + identity.port + '/status', { headers });
  const status = (await response.json()) as { auth: { status: string } };
  if (status.auth.status !== 'signed_out') {
    throw Error('Fresh installation unexpectedly has an account.');
  }
  await exec(executable, ['--prepare-update'], { env, windowsHide: true, timeout: 60000 });
  await new Promise<void>((resolve, reject) => {
    if (child!.exitCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => reject(Error('Bridge shutdown timed out.')), 20000);
    child!.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  await writeFile(path.join(data, 'preserve-on-uninstall.txt'), 'keep user data');
  await mkdir(path.join(payload, 'tests'), { recursive: true });
  await writeFile(path.join(payload, 'tests/retired-file.txt'), 'obsolete application resource');
  const upgradeStarted = performance.now();
  await exec(installer, ['/S', '/UPDATE', '/D=' + target], {
    env,
    windowsHide: true,
    timeout: 180000,
  });
  const upgradeMilliseconds = performance.now() - upgradeStarted;
  const updateStages = (await readFile(path.join(data, 'runtime/update.log'), 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [milliseconds, stage] = line.split(' ');
      return { milliseconds: Number(milliseconds), stage };
    });
  if (
    ![
      'installer-ready',
      'helper-extracted',
      'bridge-stopped',
      'copying-files',
      'files-installed',
    ].every((stage) => updateStages.some((entry) => entry.stage === stage))
  ) {
    throw Error('Upgrade did not record all installer stages.');
  }
  try {
    await access(path.join(payload, 'tests/retired-file.txt'));
    throw Error('Upgrade retained a retired application resource.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  await exec(executable, ['--self-test'], { env, windowsHide: true, timeout: 30000 });
  await access(path.join(data, 'config.local.json'));
  await access(path.join(data, 'runtime/chats.json'));
  await exec(path.join(target, 'uninstall.exe'), ['/S', '_?=' + target], {
    windowsHide: true,
    timeout: 120000,
  });
  await access(path.join(data, 'preserve-on-uninstall.txt'));
  const report = {
    version,
    installer: true,
    protectedCredentials: true,
    bundledNode: true,
    packagedEngine: true,
    noLooseNodeModules: true,
    payloadFiles,
    installMilliseconds,
    upgradeMilliseconds,
    updateStages,
    agentReady: true,
    independentSignIn: true,
    noPersonalData: true,
    userDataPreserved: true,
    upgradePreservesHistory: true,
    retiredResourcesRemoved: true,
  };
  await writeFile('dist/installer-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (child && child.exitCode === null && child.pid) {
    await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
    }).catch(() => {});
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
