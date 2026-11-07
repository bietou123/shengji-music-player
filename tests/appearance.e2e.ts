import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import sharp from 'sharp';

const root = path.resolve('.');
const artifacts = path.join(root, 'test-artifacts');
const screenshots = path.join(artifacts, 'screenshots');
await mkdir(screenshots, { recursive: true });
const profile = await mkdtemp(path.join(artifacts, 'appearance-profile-'));
const living = process.env.SHENGJI_LOCAL_TEST_FILE || path.join(os.homedir(), 'Desktop', 'Florian Bur - Living.mp3');
const executable = process.env.SHENGJI_E2E_EXECUTABLE;
const prefix = executable ? 'packaged-appearance' : 'appearance';
const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
const checks: { name: string; detail: unknown }[] = [];
const errors: string[] = [];
let app: ElectronApplication | undefined;
let page!: Page;

async function capture(name: string, target = page) {
  await target.waitForFunction(() => document.querySelector<HTMLCanvasElement>('.glass-optics')?.dataset.texture === 'cover');
  await target.waitForTimeout(550);
  const layout = await target.evaluate(() => {
    const dock = document.querySelector<HTMLElement>('.player-bar, .mini-player')!;
    const bounds = dock.getBoundingClientRect();
    const controls = [...dock.querySelectorAll<HTMLElement>('.now-playing, .transport, .player-tools, .mini-track, .mini-timeline')].map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    const covers = [...document.querySelectorAll<HTMLImageElement>('.cover img')].filter((image) => image.complete && image.naturalWidth > 50);
    const content = document.querySelector<HTMLElement>('.main-content');
    return {
      width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme,
      motion: document.documentElement.dataset.motion, glass: document.documentElement.dataset.glass,
      dock: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }, controls,
      actualCovers: covers.length, contentPadding: content ? parseFloat(getComputedStyle(content.firstElementChild!).paddingBottom) : null,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      renderer: document.querySelector<HTMLCanvasElement>('.glass-optics')?.dataset.renderer,
      texture: document.querySelector<HTMLCanvasElement>('.glass-optics')?.dataset.texture,
    };
  });
  assert.ok(layout.actualCovers > 0, 'Visual review must contain loaded real catalog artwork');
  assert.equal(layout.renderer, 'webgl2', 'Normal appearance review must include the actual GPU optical layer');
  assert.equal(layout.texture, 'cover', 'The optical layer must sample the real catalog artwork');
  assert.ok(layout.horizontalOverflow <= 1);
  assert.ok(layout.controls.every((control) => control.left >= layout.dock.left && control.right <= layout.dock.right + 1
    && control.top >= layout.dock.top && control.bottom <= layout.dock.bottom + 1), 'Playback controls overlap or leave the dock');
  if (layout.contentPadding !== null) assert.ok(layout.contentPadding >= 126, 'Final rows need clearance from the dock');
  const png = await target.screenshot();
  const stats = await sharp(png).stats();
  assert.ok(stats.channels.some((channel) => channel.stdev > 12), 'Screenshot is blank or lacks visible media');
  await writeFile(path.join(screenshots, `${prefix}-${name}.png`), png);
  checks.push({ name, detail: layout });
  console.log(`PASS ${name}: ${JSON.stringify(layout)}`);
  return png;
}

async function theme(value: 'light' | 'dark') {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: value === 'light' ? '浅色' : '深色', exact: true }).click();
  await page.waitForFunction((value) => document.documentElement.dataset.theme === value, value);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
}

try {
  assert.ok((await stat(living)).size > 1000);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SHENGJI_DEV_URL;
  delete env.NODE_PATH;
  app = await _electron.launch({
    ...(executable ? { executablePath: executable } : {}),
    args: [root, '--mute-audio', `--import=${living}`], cwd: root,
    env: { ...env, SHENGJI_TEST: '1', SHENGJI_DATA_DIR: profile }, timeout: 60_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(35_000);
  page.on('pageerror', (error) => errors.push(error.message));
  const runtime = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, appPath: app.getAppPath() }));
  assert.equal(runtime.version, version, 'Appearance review must exercise the release version');
  assert.equal(runtime.packaged, Boolean(executable));
  if (executable) assert.match(runtime.appPath, /app\.asar$/);
  await page.locator('.player-bar').waitFor();
  const main = await app.browserWindow(page);
  const isolation = await main.evaluate((window) => ({ focused: window.isFocused(), bounds: window.getBounds() }));
  assert.equal(isolation.focused, false);
  assert.equal(await app.evaluate(() => process.env.SHENGJI_TEST), '1');
  assert.ok(isolation.bounds.x < -1000 && isolation.bounds.y < -1000);

  const input = page.getByRole('textbox', { name: '搜索音乐', exact: true });
  await input.fill('Laufey');
  await input.press('Enter');
  await page.getByRole('heading', { name: '搜索：Laufey', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.source-status.loading'), undefined, { timeout: 65_000 });
  await page.getByRole('combobox', { name: '音源筛选', exact: true }).selectOption('itunes');
  const track = page.locator('.track-row[data-track-id^="itunes:"]').first();
  await track.waitFor();
  const source = await track.getAttribute('data-track-id');
  await track.getByRole('button', { name: /^播放 / }).click();
  await page.waitForFunction(() => {
    const audio = document.querySelector<HTMLAudioElement>('#audio-engine');
    return audio && !audio.paused && audio.readyState >= 2 && audio.currentTime > 0.1;
  });
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.waitForFunction(() => (document.querySelector<HTMLImageElement>('.now-cover img')?.naturalWidth ?? 0) > 50);
  await capture('search-desktop-light');

  // The screenshot content is live catalog data, never a generated glass fixture.
  await page.getByRole('tab', { name: '专辑', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.source-status.loading'), undefined, { timeout: 65_000 });
  await page.locator('.album-tile').first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.album-image img')].filter((image) => image.naturalWidth > 50).length >= 4);
  const beforeScroll = await capture('albums-desktop-light');
  await page.locator('.main-content').evaluate((element) => { element.scrollTop = 140; });
  const afterScroll = await capture('content-behind-dock');
  const dockBounds = (await page.locator('.player-bar').boundingBox())!;
  const region = {
    left: Math.ceil(dockBounds.x + dockBounds.width * 0.28), top: Math.ceil(dockBounds.y + 14),
    width: Math.floor(dockBounds.width * 0.46), height: Math.floor(dockBounds.height - 28),
  };
  // The paused controls and current-cover underlay stay fixed; only the real DOM beneath them scrolls.
  const before = await sharp(beforeScroll).extract(region).removeAlpha().raw().toBuffer();
  const after = await sharp(afterScroll).extract(region).removeAlpha().raw().toBuffer();
  assert.equal(before.length, after.length);
  let difference = 0;
  for (let index = 0; index < before.length; index++) difference += Math.abs(before[index] - after[index]);
  const meanChannelChange = difference / before.length;
  assert.ok(meanChannelChange > 0.8, 'Scrolling actual album content must visibly change the composite through the dock');
  checks.push({ name: 'actual-dom-transmission', detail: { region, meanChannelChange } });
  await page.locator('.main-content').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const last = await page.locator('.album-tile').last().boundingBox();
  const dock = await page.locator('.player-bar').boundingBox();
  assert.ok(last && dock && last.y + last.height < dock.y - 10, 'Last album is hidden behind playback controls');
  checks.push({ name: 'last-album-clearance', detail: { last, dock } });
  await page.locator('.main-content').evaluate((element) => { element.scrollTop = 0; });
  await theme('dark');
  await capture('albums-desktop-dark');
  await main.evaluate((window) => { window.setSize(900, 620); window.setPosition(-12000, -12000); });
  await page.waitForFunction(() => innerWidth < 960 && innerHeight < 680);
  await capture('albums-compact-dark');
  await page.getByRole('button', { name: '音效', exact: true }).click();
  await page.locator('.effects-modal').waitFor();
  await capture('effects-compact-dark');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.locator('.effects-modal').waitFor({ state: 'detached' });
  await theme('light');
  await capture('albums-compact-light');
  await page.getByRole('button', { name: '音效', exact: true }).click();
  await page.locator('.effects-modal').waitFor();
  await capture('effects-compact-light');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.locator('.effects-modal').waitFor({ state: 'detached' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'off');
  await capture('reduced-motion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'on');

  const opened = app.waitForEvent('window');
  await page.getByRole('button', { name: '迷你播放器', exact: true }).click();
  const mini = await opened;
  mini.on('pageerror', (error) => errors.push(error.message));
  await mini.locator('.mini-player').waitFor();
  await mini.waitForFunction(() => (document.querySelector<HTMLImageElement>('.now-cover img')?.naturalWidth ?? 0) > 50);
  await capture('mini-light', mini);
  await mini.getByRole('button', { name: '还原主播放器', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.windowVisible === 'true');
  await theme('dark');
  await page.getByRole('button', { name: '迷你播放器', exact: true }).click();
  await mini.waitForFunction(() => document.documentElement.dataset.windowVisible === 'true');
  await mini.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await capture('mini-dark', mini);
  await mini.getByRole('button', { name: '还原主播放器', exact: true }).click();
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, `${prefix}-results.json`), JSON.stringify({ date: new Date().toISOString(), version, runtime, source, query: 'Laufey', artwork: 'Live Apple catalog artwork', isolation, checks, errors }, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  if (page) await page.screenshot({ path: path.join(screenshots, `${prefix}-failure.png`) }).catch(() => {});
} finally {
  await app?.close();
}
