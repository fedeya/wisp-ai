import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cache = path.join(root, 'node_modules/.cache/wisp-demo');
const sandbox = path.join(cache, 'browser-sandbox');
const output = path.join(root, 'apps/web/public/demo');
const frames = path.join(cache, 'frames');
const sandboxCommit = '55431c10e99148fe5f9c00e2de358550bcf1c449';
const port = Number(process.env.WISP_DEMO_PORT || 3011);
const serveOnly = process.argv.includes('--serve');
const exists = async (file) =>
  access(file).then(
    () => true,
    () => false,
  );
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${executable} failed: ${result.stderr || result.stdout || result.error}`);
  }
  return result.stdout?.trim();
}

await Promise.all([
  mkdir(cache, { recursive: true }),
  mkdir(output, { recursive: true }),
  mkdir(frames, { recursive: true }),
]);
if (!(await exists(path.join(sandbox, '.git')))) {
  command('git', [
    'clone',
    '--no-checkout',
    'https://github.com/srrmke/wow-addons-sandbox.git',
    sandbox,
  ]);
}
const currentCommit = command('git', ['rev-parse', 'HEAD'], { cwd: sandbox });
if (currentCommit !== sandboxCommit) {
  command('git', ['fetch', '--depth', '1', 'origin', sandboxCommit], { cwd: sandbox });
  command('git', ['checkout', '--detach', sandboxCommit], { cwd: sandbox });
}
if (!(await exists(path.join(sandbox, 'node_modules/vite/bin/vite.js')))) {
  command(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['install', '--ignore-workspace', '--ignore-scripts'],
    { cwd: sandbox, shell: process.platform === 'win32' },
  );
}

const publicDir = path.join(sandbox, 'public');
await mkdir(publicDir, { recursive: true });
const files = [
  'Core.lua',
  'ChatHistory.lua',
  'RichUI.lua',
  'Widgets.lua',
  'EmojiData.lua',
  'Emoji.lua',
  'MessageFormat.lua',
  'ModelControls.lua',
  'MessageRows.lua',
  'UI.lua',
  'Panels.lua',
  'fixture.lua',
];
const sources = {};
const hashes = {};
for (const file of files) {
  const relative = file === 'fixture.lua' ? 'scripts/demo/fixture.lua' : `addon/WispAI/${file}`;
  const source = await readFile(path.join(root, relative), 'utf8');
  sources[file.toLowerCase()] = source;
  hashes[relative] = sha256(source);
}
sources['wispai.toc'] =
  `## Interface: 16001\n## Title: Wisp AI Offline Demo\n${files.join('\n')}\n`;
await writeFile(path.join(publicDir, 'wisp-addon.json'), JSON.stringify({ sources }));
await Promise.all([
  copyFile(path.join(root, 'scripts/demo/browser-entry.ts.txt'), path.join(sandbox, 'wisp.ts')),
  copyFile(path.join(root, 'scripts/demo/browser.html'), path.join(sandbox, 'wisp.html')),
  copyFile(path.join(root, 'assets/wisp.png'), path.join(publicDir, 'wisp.png')),
  copyFile(path.join(root, 'addon/WispAI/Textures/Gear.tga'), path.join(publicDir, 'gear.tga')),
]);

// The package contains the encoder itself; no package lifecycle scripts run.
let ffmpeg = process.env.WISP_DEMO_FFMPEG;
if (!ffmpeg && !serveOnly) {
  if (process.platform !== 'win32') {
    throw new Error('Set WISP_DEMO_FFMPEG to a local ffmpeg executable on this platform.');
  }
  ffmpeg = path.join(cache, 'ffmpeg/package/ffmpeg.exe');
  if (!(await exists(ffmpeg))) {
    const metadata = await (
      await fetch('https://registry.npmjs.org/@ffmpeg-installer/win32-x64/4.1.0')
    ).json();
    const bytes = Buffer.from(await (await fetch(metadata.dist.tarball)).arrayBuffer());
    assert.equal(
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      metadata.dist.integrity,
    );
    const archive = path.join(cache, 'ffmpeg.tgz');
    await writeFile(archive, bytes);
    await mkdir(path.join(cache, 'ffmpeg'), { recursive: true });
    command('tar', ['-xzf', archive, '-C', path.join(cache, 'ffmpeg')]);
  }
}

const server = spawn(
  process.execPath,
  [
    path.join(sandbox, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  { cwd: sandbox, stdio: 'pipe', windowsHide: true },
);
let serverLog = '';
server.stdout.on('data', (chunk) => {
  serverLog += chunk;
});
server.stderr.on('data', (chunk) => {
  serverLog += chunk;
});
let browser;
try {
  const deadline = Date.now() + 20000;
  while (true) {
    if (server.exitCode !== null) {
      throw new Error(`Preview exited: ${serverLog}`);
    }
    try {
      if ((await fetch(`http://127.0.0.1:${port}/wisp.html`)).ok) {
        break;
      }
    } catch {
      /* startup */
    }
    if (Date.now() > deadline) {
      throw new Error(`Preview did not start: ${serverLog}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (serveOnly) {
    console.log(`Original addon demo: http://127.0.0.1:${port}/wisp.html?controls`);
    console.log('Offline fixtures only. Press Ctrl+C to stop.');
    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } else {
    browser = await chromium.launch({
      channel: process.env.WISP_DEMO_BROWSER || 'chrome',
      headless: true,
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 840 },
      deviceScaleFactor: 1,
    });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/wisp.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.wispDemo?.ready);
    const settle = () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    const run = (code) => page.evaluate((value) => window.wispDemo.run(value), code);
    const stage = async (index, title) => {
      await page.evaluate(
        ({ index, title }) => {
          window.wispDemo.stage(index);
          window.wispDemo.caption(title);
        },
        { index, title },
      );
      await settle();
    };
    const segments = [];
    async function capture(duration) {
      await settle();
      const filename = path.join(frames, `frame-${String(segments.length).padStart(3, '0')}.png`);
      await page.screenshot({ path: filename });
      segments.push({ filename, duration });
    }
    const gearTitle = 'A question about your gear.';
    await stage(0, gearTitle);
    await capture(1.5);
    const question = 'Is this staff an upgrade for my mage?';
    for (let index = 3; index < question.length + 3; index += 3) {
      await run(`WispAI.draft:SetText(${JSON.stringify(question.slice(0, index))})`);
      await capture(0.09);
    }
    await capture(0.5);
    await stage(1, gearTitle);
    await capture(1.2);
    await stage(2, 'Your character gives the question context.');
    await capture(1.8);
    await stage(3, 'See the tradeoff. Decide for yourself.');
    await capture(5);
    await page.screenshot({ path: path.join(output, 'addon-preview.png') });
    const gearEnd = segments.length;
    await stage(4, 'Plan your next stop without leaving the conversation.');
    await capture(4);
    const trackerStart = segments.length;
    await stage(5, 'Turn a little goal into a saved tracker.');
    await capture(3);
    await page.screenshot({ path: path.join(output, 'tracker-preview.png') });
    await stage(6, 'Bag counts update locally.');
    await capture(2);
    await stage(7, 'A little progress. A little less to remember.');
    await capture(4);
    const snapshot = await page.evaluate(() => window.wispDemo.snapshot());
    assert(
      snapshot.items.some((item) => item.txt?.includes('20 / 20')),
      'Tracker must render the updated bag count',
    );
    assert(
      snapshot.items.some((item) => item.txt?.includes('100%')),
      'Tracker must render completed progress',
    );
    const errors = await page.evaluate(() => window.wispDemo.errors);
    assert.deepEqual(errors, [], 'No Lua errors are allowed in the recorded scenes');
    assert.deepEqual(pageErrors, [], 'No browser errors are allowed in the recorded scenes');
    async function encode(name, selected) {
      const list = path.join(frames, `${name}.txt`);
      const quotePath = (filename) => filename.replaceAll('\\', '/').replaceAll("'", "'\\''");
      const last = selected.at(-1);
      await writeFile(
        list,
        selected
          .map(({ filename, duration }) => `file '${quotePath(filename)}'\nduration ${duration}\n`)
          .join('') + `file '${quotePath(last.filename)}'\n`,
      );
      command(ffmpeg, [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        list,
        '-vf',
        'fps=24',
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-an',
        path.join(output, `${name}.mp4`),
      ]);
    }
    await encode('wisp-demo', segments);
    await encode('gear', segments.slice(0, gearEnd));
    await encode('tracker', segments.slice(trackerStart));
    const manifest = {
      renderer: {
        repository: 'https://github.com/srrmke/wow-addons-sandbox',
        commit: sandboxCommit,
      },
      sources: hashes,
      simulated: [
        'Character data',
        'Tool results and assistant responses',
        'Timing',
        'Game textures and font substitutions',
      ],
      real: [
        'Original Wisp addon Lua',
        'Chat submission',
        'Message and tool rendering',
        'Saved panel renderer and local bag-count bindings',
      ],
      width: 1280,
      height: 840,
      fps: 24,
      duration: Number(segments.reduce((sum, item) => sum + item.duration, 0).toFixed(2)),
      validation: { luaErrors: errors, browserErrors: pageErrors, trackerReachedTarget: true },
    };
    await writeFile(path.join(output, 'provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(
      `Rendered original addon UI. Exported wisp-demo.mp4, gear.mp4, tracker.mp4 and two posters to ${output}`,
    );
    console.log(
      `Validated: no Lua/browser errors; local tracker reached 20/20. Duration: ${manifest.duration}s.`,
    );
  }
} finally {
  await browser?.close();
  server.kill();
}
