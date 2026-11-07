import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const root = path.resolve('.');
const artifacts = path.join(root, 'test-artifacts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(artifacts, 'portable-profile-'));
const executable = process.env.SHENGJI_PORTABLE_EXECUTABLE || path.join(root, 'release', 'Shengji-1.0.0-x64-portable.exe');
const living = process.env.SHENGJI_LOCAL_TEST_FILE || path.join(os.homedir(), 'Desktop', 'Florian Bur - Living.mp3');
const checks: { name: string; status: 'pass' | 'fail'; detail: unknown }[] = [];
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let localId = '';
let playlistId = '';
let failed = false;

async function check(name: string, action: () => Promise<unknown>): Promise<void> {
  try {
    const detail = await action();
    checks.push({ name, status: 'pass', detail });
    console.log(`PASS ${name}: ${JSON.stringify(detail)}`);
  } catch (error) {
    checks.push({ name, status: 'fail', detail: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function launch(importFile = false): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    SHENGJI_TEST: '1', SHENGJI_DATA_DIR: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SHENGJI_DEV_URL;
  delete env.NODE_PATH;
  // The portable wrapper does not relay Electron's inspector output; use loopback CDP instead.
  child = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--mute-audio', ...(importFile ? [`--import=${living}`] : [])], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let startupError: Error | undefined;
  child.on('error', (error) => { startupError = error; });
  child.stdout?.resume();
  child.stderr?.resume();
  const deadline = Date.now() + 90_000;
  const endpoint = `http://127.0.0.1:${port}`;
  while (true) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(`Portable launcher exited: ${child.exitCode}`);
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) break;
    } catch { /* The executable first extracts its bundled runtime. */ }
    if (Date.now() >= deadline) throw new Error('Portable CDP startup timed out');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000 });
  const context = browser.contexts()[0];
  page = context.pages()[0] || await context.waitForEvent('page');
  page.setDefaultTimeout(35_000);
  await page.locator('.player-bar').waitFor();
}

async function stop(): Promise<void> {
  if (page && !page.isClosed()) await page.evaluate(() => window.shengji.windowAction('close')).catch(() => undefined);
  await browser?.close().catch(() => undefined);
  const deadline = Date.now() + 15_000;
  while (child && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (child?.pid && child.exitCode === null) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* Already exited. */ }
  }
  page = undefined;
  browser = undefined;
  child = undefined;
}

async function audio() {
  return page!.locator('#audio-engine').evaluate((element) => {
    const audio = element as HTMLAudioElement;
    return { paused: audio.paused, position: audio.currentTime, duration: audio.duration, muted: audio.muted, error: audio.error?.code ?? null };
  });
}

async function playing(): Promise<void> {
  await page!.waitForFunction(() => {
    const audio = document.querySelector<HTMLAudioElement>('#audio-engine');
    return audio && !audio.paused && audio.readyState >= 2 && audio.currentTime > 0.2;
  }, undefined, { timeout: 45_000 });
}

try {
  await check('Portable wrapper launches its bundled runtime and imports the real MP3', async () => {
    assert.ok((await stat(living)).size > 1000);
    await launch(true);
    assert.match(page!.url(), /\/resources\/app\.asar\/dist\/index\.html$/);
    const snapshot = await page!.evaluate(() => window.shengji.bootstrap());
    const track = snapshot.localTracks.find((track) => track.filePath === living);
    assert.ok(track);
    assert.equal(track.title, 'Living');
    localId = track.id;
    assert.ok((await stat(path.join(profile, 'library.sqlite'))).size > 1000);
    return { title: track.title, bundledAsar: true, sqliteLoaded: true };
  });

  await check('Portable local audio actually decodes, pauses and resumes', async () => {
    await page!.getByRole('button', { name: '本地音乐', exact: true }).click();
    await page!.locator(`[data-track-id="${localId}"]`).getByRole('button', { name: '播放 Living', exact: true }).click();
    await playing();
    const before = await audio();
    await page!.waitForTimeout(700);
    assert.ok((await audio()).position > before.position + 0.3);
    await page!.getByRole('button', { name: '暂停', exact: true }).click();
    const paused = await audio();
    await page!.waitForTimeout(400);
    assert.ok(Math.abs((await audio()).position - paused.position) < 0.1);
    await page!.getByRole('button', { name: '播放', exact: true }).click();
    await playing();
    assert.equal((await audio()).error, null);
    await page!.getByRole('button', { name: '暂停', exact: true }).click();
    return { duration: before.duration, decoded: true, pauseResume: true };
  });

  await check('Portable live search and full online playback work', async () => {
    const field = page!.getByRole('textbox', { name: '搜索音乐', exact: true });
    await field.fill('Florian Bur Living');
    await field.press('Enter');
    await page!.getByRole('heading', { name: '搜索：Florian Bur Living', exact: true }).waitFor();
    await page!.waitForFunction(() => !document.querySelector('.source-status.loading'), undefined, { timeout: 65_000 });
    assert.equal(await page!.locator('.source-status.ok').count(), 2);
    await page!.getByRole('combobox', { name: '音源筛选', exact: true }).selectOption('netease');
    const track = page!.locator('[data-track-id="netease:36841028"]');
    assert.match(await track.innerText(), /完整播放/);
    await track.getByRole('button', { name: '播放 Living', exact: true }).click();
    await playing();
    const state = await audio();
    assert.ok(state.duration > 120);
    await page!.getByRole('button', { name: '暂停', exact: true }).click();
    return { successfulSources: 2, fullDuration: state.duration, decoded: true };
  });

  await check('Portable Apple preview remains distinctly labeled and decodes', async () => {
    await page!.getByRole('combobox', { name: '音源筛选', exact: true }).selectOption('itunes');
    const row = page!.locator('[data-track-id^="itunes:"]').filter({ has: page!.getByText('Florian Bur', { exact: true }) }).first();
    assert.match(await row.innerText(), /试听/);
    await row.getByRole('button', { name: /^播放 / }).click();
    await playing();
    const state = await audio();
    assert.ok(state.duration > 10 && state.duration < 95);
    assert.equal(await page!.locator('.now-meta .status-tag.preview').count(), 1);
    await page!.getByRole('button', { name: '暂停', exact: true }).click();
    return { duration: state.duration, labeledPreview: true };
  });

  await check('Portable SQLite favorites, playlist and playback survive launcher restart', async () => {
    playlistId = await page!.evaluate(async (id) => {
      await window.shengji.favorite(id, true);
      const playlist = await window.shengji.createPlaylist('Portable verification');
      await window.shengji.addToPlaylist(playlist, [id]);
      return playlist;
    }, localId);
    await page!.getByRole('button', { name: '本地音乐', exact: true }).click();
    await page!.locator(`[data-track-id="${localId}"]`).getByRole('button', { name: '播放 Living', exact: true }).click();
    await playing();
    await page!.getByRole('button', { name: '暂停', exact: true }).click();
    const expected = await audio();
    await stop();
    await launch();
    await page!.waitForFunction(() => document.querySelector<HTMLAudioElement>('#audio-engine')?.readyState! >= 2);
    const restored = await audio();
    const snapshot = await page!.evaluate(() => window.shengji.bootstrap());
    assert.equal(restored.paused, true);
    assert.ok(Math.abs(restored.position - expected.position) < 0.5);
    assert.equal(snapshot.playback.currentId, localId);
    assert.ok(snapshot.favorites.some((track) => track.id === localId));
    assert.deepEqual(snapshot.playlists.find((playlist) => playlist.id === playlistId)?.tracks.map((track) => track.id), [localId]);
    return { noAutoplay: true, position: restored.position, favorites: true, playlist: true };
  });
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await stop();
  await writeFile(path.join(artifacts, 'portable-e2e-results.json'), JSON.stringify({ date: new Date().toISOString(), executable: path.basename(executable), failed, profile, checks }, null, 2));
  if (failed) process.exitCode = 1;
}
