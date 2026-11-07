import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication, type Locator, type Page } from 'playwright';
import type { AudioEffectsSettings, LibrarySnapshot, PlaybackState } from '../shared/types';
import { writeWav } from './helpers';

const root = path.resolve('.');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
const artifacts = path.join(root, 'test-artifacts');
const screenshots = path.join(artifacts, 'screenshots');
await mkdir(screenshots, { recursive: true });
const profile = await mkdtemp(path.join(artifacts, 'e2e-profile-'));
const fixture = path.join(profile, 'fixtures', 'E2E tagged.wav');
const living = process.env.SHENGJI_LOCAL_TEST_FILE || path.join(os.homedir(), 'Desktop', 'Florian Bur - Living.mp3');
const executable = process.env.SHENGJI_E2E_EXECUTABLE;
const checks: { name: string; status: 'pass' | 'fail' | 'not-tested'; detail: unknown }[] = [];
const rendererErrors: string[] = [];
let application: ElectronApplication | undefined;
let page: Page;
let localId = '';
let fixtureId = '';
let playlistId = '';
let failed = false;

async function check(name: string, action: () => Promise<unknown>): Promise<void> {
  try {
    const detail = await action();
    checks.push({ name, status: 'pass', detail });
    console.log(`PASS ${name}: ${JSON.stringify(detail)}`);
  } catch (error) {
    failed = true;
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({ name, status: 'fail', detail });
    console.error(`FAIL ${name}: ${detail}`);
    throw error;
  }
}

async function launch(importFiles = false): Promise<void> {
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    SHENGJI_TEST: '1', SHENGJI_DATA_DIR: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SHENGJI_DEV_URL;
  delete env.NODE_PATH;
  application = await _electron.launch({
    ...(executable ? { executablePath: executable } : {}),
    args: [root, '--mute-audio', ...(importFiles ? [`--import=${living}`, `--import=${fixture}`] : [])],
    cwd: root,
    env,
    timeout: 60_000,
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  await page.locator('.player-bar').waitFor();
  await page.waitForFunction(() => Boolean(document.querySelector('#audio-engine')));
}

async function bootstrap(): Promise<LibrarySnapshot> {
  return page.evaluate(() => window.shengji.bootstrap());
}

async function audio() {
  return page.locator('#audio-engine').evaluate((element) => {
    const value = element as HTMLAudioElement;
    return {
      paused: value.paused,
      position: value.currentTime,
      duration: value.duration,
      volume: value.volume,
      muted: value.muted,
      readyState: value.readyState,
      source: value.currentSrc,
      error: value.error?.code ?? null,
    };
  });
}

async function playing(): Promise<void> {
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLAudioElement>('#audio-engine');
    return element && !element.paused && element.readyState >= 2 && element.currentTime > 0.2;
  }, undefined, { timeout: 40_000 });
}

async function dragRange(control: Locator, fraction: number): Promise<void> {
  const box = await control.boundingBox();
  assert.ok(box);
  const min = Number(await control.getAttribute('min') ?? 0);
  const max = Number(await control.getAttribute('max') ?? 1);
  const value = Number(await control.inputValue());
  const at = (ratio: number) => box.x + 6 + ratio * (box.width - 12);
  const y = box.y + box.height / 2;
  await page.mouse.move(at((value - min) / (max - min)), y);
  await page.mouse.down();
  await page.mouse.move(at(fraction), y, { steps: 8 });
  await page.mouse.up();
}

async function spectrum(control = page.locator('.player-tools .audio-spectrum')) {
  return control.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let upperPixels = 0;
    for (let y = 0; y < canvas.height - 6; y++) {
      for (let x = 0; x < canvas.width; x++) if (pixels[(y * canvas.width + x) * 4 + 3] > 0) upperPixels++;
    }
    return {
      frame: Number(canvas.dataset.frame ?? 0), rms: Number(canvas.dataset.rms ?? 0),
      peakHz: Number(canvas.dataset.peakHz ?? 0), peakDb: Number(canvas.dataset.peakDb ?? -100),
      compressionDb: Number(canvas.dataset.compressionDb ?? 0),
      upperPixels, width: canvas.width, height: canvas.height,
    };
  });
}

async function signal(selector = '.player-tools .audio-spectrum'): Promise<void> {
  await page.waitForFunction((selector) => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector);
    return Number(canvas?.dataset.rms ?? 0) > 0.0001 && Number(canvas?.dataset.frame ?? 0) > 2;
  }, selector);
}

async function effectsLayout(): Promise<unknown> {
  await page.waitForFunction(() => !document.querySelector('.effects-modal')!.getAnimations().some((animation) => animation.playState === 'running'));
  const result = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.effects-modal')!;
    const { x, y, width, height, right, bottom } = panel.getBoundingClientRect();
    return {
      width: innerWidth, height: innerHeight, panel: { x, y, width, height, right, bottom },
      scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth,
      scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight,
      bands: [...document.querySelectorAll('.eq-band')].map((element) => {
        const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
        return { x, y, width, height, right, bottom };
      }),
      sliders: [...document.querySelectorAll('.eq-slider')].map((element) => {
        const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
        return { x, y, width, height, right, bottom };
      }),
    };
  });
  assert.ok(result.panel.y >= 0 && result.panel.bottom <= result.height, 'Effects dialog extends outside the window');
  assert.ok(result.scrollWidth <= result.clientWidth + 1, 'Effects dialog overflows horizontally');
  assert.ok(result.scrollHeight <= result.clientHeight + 1, 'Effects controls need unexpected vertical scrolling');
  for (let i = 0; i < result.bands.length; i++) {
    const band = result.bands[i], slider = result.sliders[i];
    assert.ok(slider.x >= band.x && slider.right <= band.right + 1, 'EQ slider is misaligned');
    if (i) assert.ok(result.bands[i - 1].right <= band.x + 1, 'EQ bands overlap');
  }
  return { width: result.width, height: result.height, panel: result.panel, sliderHeight: result.sliders[0].height };
}

async function lyricsLayout(): Promise<unknown> {
  await page.waitForFunction(() => !document.querySelector('.lyric-artwork')!.getAnimations().some((animation) => animation.playState === 'running'));
  const result = await page.evaluate(() => {
    const [artwork, view, heading, canvas, player] = [
      '.lyric-artwork', '.instrumental-view', '.instrumental-view h3', '.instrumental-view canvas', '.player-bar',
    ].map((selector) => {
      const { y, bottom, width, height } = document.querySelector(selector)!.getBoundingClientRect();
      return { y, bottom, width, height };
    });
    const content = document.querySelector<HTMLElement>('.lyrics-content')!;
    const state = document.querySelector<HTMLElement>('.instrumental-view')!;
    return {
      artwork, view, heading, canvas, player, overflow: content.scrollHeight - content.clientHeight,
      stateOverflow: state.scrollHeight - state.clientHeight,
      controls: [...state.querySelectorAll('.button, .lyrics-origin, .spectrum-scale')].map((element) => {
        const { y, bottom } = element.getBoundingClientRect();
        return { y, bottom };
      }),
    };
  });
  assert.ok(result.artwork.bottom <= result.view.y + 1, 'Artwork overlaps the lyrics state');
  assert.ok(result.heading.bottom <= result.canvas.y + 1, 'Lyrics state overlaps the spectrum');
  assert.ok(result.canvas.bottom <= result.view.bottom + 1, 'Spectrum extends outside the lyrics view');
  assert.ok(result.view.bottom <= result.player.y + 1, 'Lyrics overlap the player');
  assert.ok(result.overflow <= 1, 'Lyrics panel overflows vertically');
  assert.ok(result.stateOverflow <= 1, 'Lyrics state clips its controls');
  assert.ok(result.controls.every((control) => control.y >= result.view.y && control.bottom <= result.view.bottom + 1), 'Lyrics controls extend outside the panel');
  return result;
}

async function localView(): Promise<void> {
  await page.getByRole('button', { name: '本地音乐', exact: true }).click();
  await page.locator(`[data-track-id="${localId}"]`).waitFor();
}

async function menu(id: string, command: string): Promise<void> {
  const row = page.locator(`[data-track-id="${id}"]`);
  await row.getByRole('button', { name: /的更多操作$/ }).click();
  await page.getByRole('menuitem', { name: command, exact: true }).click();
}

async function setSource(name: string, enabled: boolean): Promise<void> {
  const control = page.getByRole('switch', { name: `启用${name}`, exact: true });
  await control.setChecked(enabled);
  await page.waitForFunction(({ name, enabled }) => window.shengji.bootstrap().then((snapshot) =>
    snapshot.sources.find((source) => source.name === name)?.enabled === enabled), { name, enabled });
  await page.getByRole('button', { name: '深色', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.theme-segmented button')?.disabled);
}

async function search(query: string): Promise<void> {
  const field = page.getByRole('textbox', { name: '搜索音乐', exact: true });
  await field.fill(query);
  await field.press('Enter');
  await page.getByRole('heading', { name: `搜索：${query}`, exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.source-status.loading'), undefined, { timeout: 65_000 });
}

async function layout(): Promise<unknown> {
  const result = await page.evaluate(() => {
    const [main, player, sidebar, header] = ['.main-content', '.player-bar', '.sidebar', '.titlebar'].map((selector) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
      return { x, y, width, height, right, bottom, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
    const queueElement = document.querySelector<HTMLElement>('.queue-panel:not([aria-hidden="true"])');
    const queueBounds = queueElement?.getBoundingClientRect();
    const queue = queueBounds ? { x: queueBounds.x, y: queueBounds.y, right: queueBounds.right, bottom: queueBounds.bottom, width: queueBounds.width, height: queueBounds.height } : null;
    return { width: innerWidth, height: innerHeight, main, player, sidebar, header, queue };
  });
  assert.ok(result.main.bottom <= result.player.y + 1, 'Content overlaps the player');
  assert.ok(result.sidebar.bottom <= result.player.y + 1, 'Navigation overlaps the player');
  assert.ok(result.main.y >= result.header.bottom - 1, 'Content overlaps the titlebar');
  assert.ok(result.player.right <= result.width + 1, 'Player extends outside the window');
  assert.ok(result.main.scrollWidth <= result.main.clientWidth + 1, 'Music content overflows horizontally');
  if (result.queue) {
    assert.ok(Math.abs(result.queue.y - result.header.bottom) <= 1, 'Queue starts below or overlaps the titlebar');
    assert.ok(Math.abs(result.queue.bottom - result.player.y) <= 1, 'Queue does not meet the player boundary');
    assert.ok(result.queue.right <= result.width + 1 && result.queue.x >= 0, 'Queue extends outside the window');
  }
  return result;
}

try {
  await check('Real desktop MP3 import and secure Electron window', async () => {
    assert.ok((await stat(living)).size > 1000, 'Desktop MP3 is missing');
    await writeWav(fixture, 40, true, 0.6);
    await writeFile(fixture.replace(/\.wav$/, '.lrc'), '[00:00.00]First line\n[00:05.00]Second line\n');
    await launch(true);
    const runtime = await application!.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), version: app.getVersion() }));
    assert.equal(runtime.version, version, 'The tested runtime must match the source release version');
    assert.equal(runtime.packaged, Boolean(executable));
    if (executable) assert.match(runtime.appPath, /app\.asar$/);
    const snapshot = await bootstrap();
    const local = snapshot.localTracks.find((track) => track.filePath === living);
    const tagged = snapshot.localTracks.find((track) => track.filePath === fixture);
    assert.ok(local && tagged);
    localId = local.id;
    fixtureId = tagged.id;
    assert.equal(local.title, 'Living');
    assert.equal(local.artist, 'Florian Bur');
    assert.ok(local.duration > 120);
    assert.equal(tagged.title, 'Tagged song');
    assert.ok(tagged.artwork);
    const windows = await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.getBounds()));
    assert.ok(windows.every((bounds) => bounds.x < -4000));
    const renderer = await page.evaluate(() => ({
      nodeAbsent: typeof (globalThis as unknown as { require?: unknown }).require === 'undefined'
        && typeof (globalThis as unknown as { process?: unknown }).process === 'undefined',
      bridgeFrozen: Object.isFrozen(window.shengji),
    }));
    assert.equal(renderer.nodeAbsent, true);
    assert.equal(renderer.bridgeFrozen, true);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.track-table img')].some((image) => image.naturalWidth > 0));
    return { title: local.title, artist: local.artist, format: local.format, duration: local.duration, quality: local.quality, packaged: runtime.packaged, version: runtime.version, ...renderer };
  });

  await check('Local playback actually advances and pause/resume works', async () => {
    await page.locator(`[data-track-id="${localId}"]`).getByRole('button', { name: '播放 Living', exact: true }).click();
    await playing();
    const first = await audio();
    await page.waitForTimeout(1100);
    assert.ok((await audio()).position > first.position + 0.7);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const stopped = await audio();
    assert.equal(stopped.paused, true);
    await page.waitForTimeout(700);
    assert.ok(Math.abs((await audio()).position - stopped.position) < 0.05);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await playing();
    await page.waitForTimeout(450);
    assert.ok((await audio()).position > stopped.position + 0.2);
    return { first: first.position, paused: stopped.position, resumed: (await audio()).position };
  });

  await check('Next/previous decode audio and local LRC lyrics are interactive', async () => {
    await page.getByRole('button', { name: '下一首', exact: true }).click();
    await page.waitForFunction((id) => document.querySelector<HTMLAudioElement>('#audio-engine')?.currentSrc.includes(encodeURIComponent(id)), fixtureId);
    await playing();
    await page.getByRole('button', { name: '歌词', exact: true }).click();
    await page.getByRole('button', { name: 'Second line', exact: true }).click();
    assert.ok((await audio()).position >= 4.8);
    await page.getByRole('tab', { name: /播放队列/ }).click();
    await page.getByRole('button', { name: /播放队列第 .* Living$/ }).click();
    await playing();
    await page.getByRole('button', { name: '下一首', exact: true }).click();
    await playing();
    await page.getByRole('button', { name: '上一首', exact: true }).click();
    await page.waitForFunction((id) => document.querySelector<HTMLAudioElement>('#audio-engine')?.currentSrc.includes(encodeURIComponent(id)), localId);
    await playing();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    return { next: 'Tagged song', previous: 'Living', lyricSeek: 5 };
  });

  await check('Actual FFT detects the fixture tone; pause, resume and reduced motion stop animation correctly', async () => {
    // Keep the OS output muted via --mute-audio, but feed the analyser real samples.
    if ((await audio()).muted) await page.getByRole('button', { name: '取消静音', exact: true }).click();
    await page.locator(`[data-track-id="${fixtureId}"]`).getByRole('button', { name: '播放 Tagged song', exact: true }).click();
    await playing();
    await signal();
    const first = await spectrum();
    assert.ok(Math.abs(first.peakHz - 440) < 35, `Unexpected FFT peak: ${first.peakHz}`);
    assert.ok(first.rms > 0.005 && first.upperPixels > 20, 'FFT must contain real nonblank audio pixels');
    await page.waitForTimeout(550);
    const moving = await spectrum();
    assert.ok(moving.frame > first.frame + 2);
    assert.ok(moving.frame - first.frame < 24, 'Spectrum scheduled duplicate animation loops');
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.waitForTimeout(100);
    const paused = await spectrum();
    await page.waitForTimeout(550);
    assert.equal((await spectrum()).frame, paused.frame);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await playing();
    await page.waitForTimeout(450);
    assert.ok((await spectrum()).frame > paused.frame);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(500);
    const reduced = await spectrum();
    await page.waitForTimeout(500);
    assert.equal((await spectrum()).frame, reduced.frame);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: '音效', exact: true }).click();
    await page.getByRole('switch', { name: '频谱动画', exact: true }).setChecked(false);
    await page.waitForTimeout(100);
    const disabled = await spectrum();
    assert.equal(disabled.rms, 0);
    await page.waitForTimeout(450);
    assert.equal((await spectrum()).frame, disabled.frame);
    await page.getByRole('switch', { name: '频谱动画', exact: true }).setChecked(true);
    await signal();
    await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    return { peakHz: first.peakHz, rms: first.rms, upperPixels: first.upperPixels, pauseFreezes: true, reducedMotion: true, visualizerToggle: true };
  });

  await check('Ten-band EQ and compression measurably process audio; bypass, width and presets work', async () => {
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await playing();
    await page.getByRole('button', { name: '音效', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '音效', exact: true });
    const preset = modal.getByRole('combobox', { name: '音色预设', exact: true });
    assert.equal(await preset.isDisabled(), true);
    await modal.getByRole('switch', { name: '启用音效', exact: true }).setChecked(true);
    await preset.selectOption('flat');
    await signal('.effects-monitor canvas');
    await page.waitForTimeout(650);
    const baseline = await spectrum(modal.locator('canvas'));
    assert.equal(await modal.getByRole('slider', { name: /^均衡器 / }).count(), 10);
    await modal.getByRole('slider', { name: '均衡器 500 Hz', exact: true }).press('Home');
    assert.equal(await preset.inputValue(), 'custom');
    assert.equal(await modal.getByRole('slider', { name: '均衡器 500 Hz', exact: true }).inputValue(), '-12');
    await page.waitForTimeout(850);
    const cut = await spectrum(modal.locator('canvas'));
    assert.ok(cut.peakDb < baseline.peakDb - 6, 'EQ control did not attenuate the actual 440 Hz signal');
    assert.ok(cut.rms < baseline.rms * 0.65);
    await modal.getByRole('switch', { name: '启用音效', exact: true }).setChecked(false);
    await page.waitForTimeout(700);
    const bypass = await spectrum(modal.locator('canvas'));
    assert.ok(Math.abs(bypass.peakDb - baseline.peakDb) < 1.5, 'Bypass did not restore unprocessed audio');
    await modal.getByRole('switch', { name: '启用音效', exact: true }).setChecked(true);
    await preset.selectOption('flat');
    await modal.getByRole('switch', { name: '动态压缩', exact: true }).setChecked(true);
    await page.waitForTimeout(900);
    const compressed = await spectrum(modal.locator('canvas'));
    // Web Audio includes makeup gain; verify native reduction and a changed output.
    assert.ok(compressed.compressionDb < -0.1, `Compressor has no gain reduction: ${JSON.stringify(compressed)}`);
    assert.ok(Math.abs(compressed.rms / baseline.rms - 1) > 0.03, `Compressor did not change the output: ${JSON.stringify({ baseline, compressed })}`);
    await modal.getByRole('switch', { name: '动态压缩', exact: true }).setChecked(false);
    await modal.getByRole('slider', { name: '立体声宽度', exact: true }).press('Home');
    assert.equal(await modal.getByRole('slider', { name: '立体声宽度', exact: true }).inputValue(), '0');
    await modal.getByRole('slider', { name: '立体声宽度', exact: true }).press('End');
    assert.equal(await modal.getByRole('slider', { name: '立体声宽度', exact: true }).inputValue(), '1.5');
    assert.match(await modal.locator('.headroom-label').innerText(), /-4\.0/);
    await preset.selectOption('night');
    assert.equal(await modal.getByRole('switch', { name: '动态压缩', exact: true }).isChecked(), true);
    assert.equal(await modal.getByRole('switch', { name: '动态压缩', exact: true }).isDisabled(), true);
    await modal.getByRole('button', { name: '重置音效', exact: true }).click();
    assert.equal(await preset.inputValue(), 'auto');
    assert.equal(await modal.getByRole('slider', { name: '立体声宽度', exact: true }).inputValue(), '1');
    assert.equal(await modal.getByRole('switch', { name: '动态压缩', exact: true }).isChecked(), false);
    const desktop = await effectsLayout();
    await page.screenshot({ path: path.join(screenshots, 'effects-light-desktop.png') });
    await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    return { baselineRms: baseline.rms, eqRms: cut.rms, attenuationDb: cut.peakDb - baseline.peakDb, compressionRms: compressed.rms, compressionDb: compressed.compressionDb, bypassRms: bypass.rms, desktop };
  });

  await check('Living adapts to piano; missing lyrics show genuine spectrum without invented text', async () => {
    await page.locator(`[data-track-id="${localId}"]`).getByRole('button', { name: '播放 Living', exact: true }).click();
    await playing();
    await page.getByRole('button', { name: '音效', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '音效', exact: true });
    assert.equal(await modal.getByLabel('当前适配音色', { exact: true }).innerText(), '钢琴');
    assert.equal(await modal.getByRole('slider', { name: '均衡器 500 Hz', exact: true }).inputValue(), '1.5');
    await modal.getByRole('switch', { name: '启用音效', exact: true }).setChecked(false);
    await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await page.getByRole('button', { name: '歌词', exact: true }).click();
    await page.getByRole('heading', { name: '暂无歌词', exact: true }).waitFor();
    assert.equal(await page.locator('.lyric-line').count(), 0);
    assert.equal(await page.getByRole('button', { name: '匹配在线歌词', exact: true }).count(), 1);
    await signal('.instrumental-view canvas');
    const metrics = await spectrum(page.locator('.instrumental-view canvas'));
    assert.ok(metrics.upperPixels > 20);
    const desktop = await lyricsLayout();
    await page.screenshot({ path: path.join(screenshots, 'lyrics-missing-light.png') });
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.getByRole('tab', { name: /播放队列/ }).click();
    return { adaptedPreset: 'piano', inventedLines: 0, rms: metrics.rms, desktop };
  });

  await check('Progress drag, volume drag, mute and all four play modes', async () => {
    await dragRange(page.getByRole('slider', { name: '播放进度', exact: true }), 0.34);
    assert.ok(Math.abs((await audio()).position - (await audio()).duration * 0.34) < 1.5);
    await dragRange(page.getByRole('slider', { name: '音量', exact: true }), 0.23);
    assert.ok(Math.abs((await audio()).volume - 0.23) < 0.04);
    assert.equal((await audio()).muted, false);
    await page.getByRole('button', { name: '静音', exact: true }).click();
    assert.equal((await audio()).muted, true);
    await page.getByRole('button', { name: '取消静音', exact: true }).click();
    assert.equal((await audio()).muted, false);
    await page.getByRole('button', { name: '静音', exact: true }).click();
    for (const [label, mode] of [['顺序播放', 'loop'], ['列表循环', 'one'], ['单曲循环', 'shuffle'], ['随机播放', 'order']] as const) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForFunction((mode) => window.shengji.bootstrap().then((snapshot) => snapshot.playback.mode === mode), mode);
    }
    return await audio();
  });

  await check('Queue next-up, reordering, duplicate selection and removal', async () => {
    await menu(localId, '下一首播放');
    await page.waitForFunction(() => document.querySelectorAll('.queue-track').length === 3);
    await page.getByRole('button', { name: '下移队列第 1 首', exact: true }).click();
    await page.waitForFunction(() => window.shengji.bootstrap().then((snapshot) => snapshot.playback.index === 0));
    assert.equal((await bootstrap()).playback.currentId, localId);
    await page.getByRole('button', { name: '播放队列第 3 首 Living', exact: true }).click();
    await playing();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.waitForFunction(() => window.shengji.bootstrap().then((snapshot) => snapshot.playback.index === 2));
    await page.getByRole('button', { name: '移除队列第 2 首', exact: true }).click();
    await page.waitForFunction(() => window.shengji.bootstrap().then((snapshot) => snapshot.playback.queue.length === 2 && snapshot.playback.index === 1));
    await menu(fixtureId, '加入队列');
    await page.waitForFunction(() => document.querySelectorAll('.queue-track').length === 3);
    return (await bootstrap()).playback;
  });

  await check('Favorites and editable playlists use persistent SQLite data', async () => {
    await page.locator(`[data-track-id="${localId}"]`).getByRole('button', { name: '收藏 Living', exact: true }).click();
    await page.waitForFunction((id) => window.shengji.bootstrap().then((snapshot) => snapshot.favorites.some((track) => track.id === id)), localId);
    await page.getByRole('button', { name: '新建歌单', exact: true }).click();
    await page.getByRole('textbox', { name: '歌单名称', exact: true }).fill('E2E Playlist');
    await page.getByRole('dialog', { name: '新建歌单', exact: true }).getByRole('button', { name: '创建', exact: true }).click();
    await page.getByRole('heading', { name: 'E2E Playlist', exact: true }).waitFor();
    playlistId = (await bootstrap()).playlists.find((playlist) => playlist.name === 'E2E Playlist')!.id;
    await localView();
    for (const id of [localId, fixtureId]) {
      await menu(id, '加入歌单');
      await page.getByRole('dialog', { name: '加入歌单', exact: true }).getByRole('button', { name: /E2E Playlist/ }).click();
      await page.getByRole('dialog', { name: '加入歌单', exact: true }).waitFor({ state: 'hidden' });
    }
    await page.locator('.sidebar-playlists').getByRole('button', { name: /E2E Playlist/ }).click();
    await page.getByRole('button', { name: '编辑歌单', exact: true }).click();
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    await page.getByRole('textbox', { name: '歌单名称', exact: true }).fill('E2E Renamed');
    await page.getByRole('dialog', { name: '重命名歌单', exact: true }).getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('heading', { name: 'E2E Renamed', exact: true }).waitFor();
    const rows = page.locator('.track-row[data-track-id]');
    await rows.first().dragTo(rows.last());
    await page.waitForFunction(({ playlistId, fixtureId }) => window.shengji.bootstrap().then((snapshot) =>
      snapshot.playlists.find((playlist) => playlist.id === playlistId)?.tracks[0]?.id === fixtureId), { playlistId, fixtureId });
    await menu(fixtureId, '从歌单移除');
    await page.waitForFunction((playlistId) => window.shengji.bootstrap().then((snapshot) => snapshot.playlists.find((playlist) => playlist.id === playlistId)?.tracks.length === 1), playlistId);
    await localView();
    return { favorites: (await bootstrap()).favorites.length, playlist: (await bootstrap()).playlists[0].name, remainingTracks: 1 };
  });

  await check('Missing local source displays an error and retries after recovery', async () => {
    await unlink(fixture);
    await page.locator(`[data-track-id="${fixtureId}"]`).getByRole('button', { name: '播放 Tagged song', exact: true }).click();
    await page.locator('.player-error').waitFor();
    assert.match(await page.locator('.player-error').innerText(), /ENOENT|移动|删除/);
    await writeWav(fixture, 40, true, 0.6);
    await page.getByRole('button', { name: '重试播放', exact: true }).click();
    await playing();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    return { errorShown: true, recoveryPlayed: true };
  });

  await check('Dark/light themes and unimplemented sources have real settings', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    assert.equal(await page.locator('.settings-footer span').nth(1).innerText(), version, 'Settings must show the tested runtime version');
    assert.equal(await page.getByRole('switch', { name: '启用QQ 音乐', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('switch', { name: '启用Spotify', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('switch', { name: '启用Jamendo', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.screenshot({ path: path.join(screenshots, 'settings-dark.png') });
    await page.getByRole('button', { name: '浅色', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await setSource('网易云音乐', false);
    await setSource('Apple Music', false);
    await search('No sources verification');
    await page.getByRole('heading', { name: '没有已启用的音源', exact: true }).waitFor();
    assert.equal(await page.locator('.track-row[data-track-id]').count(), 0);
    await page.waitForFunction(() => window.shengji.bootstrap().then((snapshot) => snapshot.searchHistory.includes('No sources verification')));
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await setSource('网易云音乐', true);
    await setSource('Apple Music', true);
    return { version, themes: ['dark', 'light'], disabledSources: ['qq', 'spotify', 'jamendo'], emptySearch: true };
  });

  if (process.env.SHENGJI_E2E_SKIP_ONLINE !== '1') {
    await check('Explicit local lyrics matching identifies Living as instrumental and persists the real result', async () => {
      await localView();
      await page.locator(`[data-track-id="${localId}"]`).getByRole('button', { name: '播放 Living', exact: true }).click();
      await playing();
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      await page.getByRole('button', { name: '歌词', exact: true }).click();
      await page.getByRole('heading', { name: '暂无歌词', exact: true }).waitFor();
      await page.getByRole('button', { name: '匹配在线歌词', exact: true }).click();
      await page.getByRole('heading', { name: '纯音乐', exact: true }).waitFor({ timeout: 65_000 });
      const lyrics = await page.evaluate((id) => window.shengji.lyrics(id), localId);
      assert.equal(lyrics.source, 'netease');
      assert.equal(lyrics.status, 'instrumental');
      assert.equal(lyrics.synchronized, false);
      assert.equal(await page.locator('.lyric-line').count(), 0);
      await page.screenshot({ path: path.join(screenshots, 'lyrics-instrumental-light.png') });
      return { source: lyrics.source, status: lyrics.status, matchedTitle: lyrics.matchedTitle, savedForOffline: true };
    });

    await check('Live catalog search, source filtering, sorting and real covers', async () => {
      await search('Florian Bur Living');
      assert.equal(await page.locator('.source-status.ok').count(), 2, await page.locator('.source-statuses').innerText());
      await page.getByRole('combobox', { name: '音源筛选', exact: true }).selectOption('netease');
      await page.getByRole('combobox', { name: '搜索排序', exact: true }).selectOption('full');
      const full = page.locator('[data-track-id="netease:36841028"]');
      await full.waitFor();
      assert.match(await full.innerText(), /完整播放/);
      assert.match(await full.innerText(), /320 kbps/);
      await page.waitForFunction(() => (document.querySelector<HTMLImageElement>('[data-track-id="netease:36841028"] .cover img')?.naturalWidth ?? 0) > 50);
      await full.getByRole('button', { name: /的更多操作$/ }).click();
      assert.equal(await page.getByRole('menuitem', { name: '下载音频', exact: true }).count(), 0);
      await page.getByRole('heading', { name: '搜索：Florian Bur Living', exact: true }).click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(screenshots, 'search-light.png') });
      return { sources: 2, neteaseRows: await page.locator('[data-track-id^="netease:"]').count(), coverLoaded: true };
    });

    await check('Public full online MP3 playback really decodes and seeks', async () => {
      if ((await audio()).muted) await page.getByRole('button', { name: '取消静音', exact: true }).click();
      await page.locator('[data-track-id="netease:36841028"]').getByRole('button', { name: '播放 Living', exact: true }).click();
      await playing();
      await signal();
      const before = await audio();
      assert.ok(before.duration > 120);
      assert.match(before.source, /^shengji-media:\/\/stream\/[0-9a-f-]{36}$/);
      const metrics = await spectrum();
      assert.ok(metrics.rms > 0.0001, 'Online audio must reach Web Audio instead of a CORS-silenced graph');
      await page.waitForTimeout(800);
      assert.ok((await audio()).position > before.position + 0.4);
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      await dragRange(page.getByRole('slider', { name: '播放进度', exact: true }), 0.45);
      await page.getByRole('button', { name: '播放', exact: true }).click();
      await playing();
      assert.ok((await audio()).position > 50);
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      await page.getByRole('button', { name: '静音', exact: true }).click();
      return { ...await audio(), spectrumRms: metrics.rms };
    });

    await check('Official Apple audio decodes as a labeled preview, not a full song', async () => {
      await page.getByRole('combobox', { name: '音源筛选', exact: true }).selectOption('itunes');
      const preview = page.locator('[data-track-id^="itunes:"]').filter({ has: page.getByText('Florian Bur', { exact: true }) }).first();
      await preview.waitFor();
      assert.match(await preview.innerText(), /试听/);
      await preview.getByRole('button', { name: /^播放 / }).click();
      await playing();
      const state = await audio();
      assert.ok(state.duration > 10 && state.duration < 95);
      assert.match(state.source, /^shengji-media:\/\/stream\/[0-9a-f-]{36}$/);
      assert.equal(await page.locator('.now-meta .status-tag.preview').count(), 1);
      await page.getByRole('button', { name: '歌词', exact: true }).click();
      await page.getByRole('heading', { name: '试听无同步歌词', exact: true }).waitFor();
      assert.equal(await page.locator('.lyric-line').count(), 0);
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      return { duration: state.duration, labeledPreview: true, position: state.position };
    });

    await check('Chinese search and real album grid remain usable', async () => {
      await search('周杰伦');
      assert.ok(await page.locator('.track-row[data-track-id]').count());
      await search('Tunes of Fantasy');
      await page.getByRole('tab', { name: '专辑', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.source-status.loading'), undefined, { timeout: 65_000 });
      await page.locator('.album-tile').first().waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.album-image img')].some((image) => image.naturalWidth > 50));
      await page.screenshot({ path: path.join(screenshots, 'albums-light.png') });
      return { albumTiles: await page.locator('.album-tile').count(), chineseResults: true };
    });

    await check('Real online vocal lyrics and translations synchronize and seek to the selected line', async () => {
      await search('Dream It Possible Delacey');
      await page.getByRole('tab', { name: '歌曲', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.source-status.loading'), undefined, { timeout: 65_000 });
      await page.getByRole('combobox', { name: '音源筛选', exact: true }).selectOption('netease');
      const row = page.locator('.track-row[data-track-id^="netease:"]')
        .filter({ has: page.getByText('Dream It Possible', { exact: true }) })
        .filter({ has: page.getByText('Delacey', { exact: true }) }).first();
      await row.waitFor();
      const id = await row.getAttribute('data-track-id');
      assert.ok(id && /^netease:\d+$/.test(id));
      assert.match(await row.innerText(), /完整播放/);
      await row.getByRole('button', { name: '播放 Dream It Possible', exact: true }).click();
      await playing();
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      await page.getByRole('button', { name: '歌词', exact: true }).click();
      await page.locator('.lyric-lines .lyric-line').nth(5).waitFor();
      assert.ok(await page.locator('.lyric-line small').count(), 'Genuine translation should be displayed');
      const lyrics = await page.evaluate((id) => window.shengji.lyrics(id), id);
      assert.equal(lyrics.source, 'netease');
      assert.equal(lyrics.synchronized, true);
      const target = lyrics.lines.find((line) => line.timestamp > 20 && line.translation && line.content.trim())!;
      assert.ok(target);
      await page.locator('.lyric-line').filter({ has: page.getByText(target.content, { exact: true }) }).first().click();
      assert.ok(Math.abs((await audio()).position - target.timestamp) < 0.3);
      await page.screenshot({ path: path.join(screenshots, 'lyrics-online-translated.png') });
      return { id, lines: lyrics.lines.length, translatedLines: lyrics.lines.filter((line) => line.translation).length, seek: target.timestamp };
    });
  } else {
    checks.push({ name: 'Live online catalogs and playback', status: 'not-tested', detail: 'SHENGJI_E2E_SKIP_ONLINE=1' });
  }

  await check('Desktop/compact window layouts and mini controls', async () => {
    await localView();
    await page.locator(`[data-track-id="${localId}"]`).getByRole('button', { name: '播放 Living', exact: true }).click();
    await playing();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const desktop = await layout();
    await page.screenshot({ path: path.join(screenshots, 'library-desktop.png') });
    const main = await application!.browserWindow(page);
    await main.evaluate((window) => { window.setSize(900, 620); window.setPosition(-12000, -12000); });
    await page.waitForFunction(() => innerWidth >= 900 && innerWidth < 960 && innerHeight < 680);
    const compact = await layout();
    await page.screenshot({ path: path.join(screenshots, 'library-compact.png') });
    await page.getByRole('button', { name: '歌词', exact: true }).click();
    await page.locator('.instrumental-view').waitFor();
    const compactLyrics = await lyricsLayout();
    await page.screenshot({ path: path.join(screenshots, 'lyrics-compact.png') });
    await page.getByRole('button', { name: '音效', exact: true }).click();
    const compactEffects = await effectsLayout();
    await page.screenshot({ path: path.join(screenshots, 'effects-light-compact.png') });
    await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await main.evaluate((window) => { window.setSize(1280, 800); window.setPosition(-12000, -12000); });
    const opened = application!.waitForEvent('window');
    await page.getByRole('button', { name: '迷你播放器', exact: true }).click();
    const mini = await opened;
    await mini.locator('.mini-player').waitFor();
    await mini.getByRole('button', { name: '播放', exact: true }).click();
    await playing();
    await mini.getByRole('button', { name: '暂停', exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLAudioElement>('#audio-engine')?.paused === true);
    await mini.screenshot({ path: path.join(screenshots, 'mini.png') });
    assert.equal(await mini.locator('#audio-engine').count(), 0, 'Mini window must not create a second audio engine');
    await mini.getByRole('button', { name: '关闭迷你播放器', exact: true }).click();
    return { desktop, compact, compactLyrics, compactEffects, miniControls: true };
  });

  await check('Invalid IPC, unauthorized local access and forbidden download are rejected', async () => {
    const results = await page.evaluate(async (localId) => {
      const snapshot = await window.shengji.bootstrap();
      const [download, traversal, queue, playlist] = await Promise.all([
        window.shengji.download(localId),
        window.shengji.resolveTrack('../Windows/System32/config/SAM'),
        window.shengji.savePlayback({ ...snapshot.playback, currentId: 'not-in-queue', index: 999 }),
        window.shengji.createPlaylist('   '),
      ].map((operation) => operation.then(() => false, () => true)));
      return {
        download, traversal, queue, playlist,
        nodeAbsent: typeof (window as unknown as { require?: unknown }).require === 'undefined',
        effects: await window.shengji.saveAudioEffects({ enabled: true, preset: 'custom', bands: [100], width: 10, compressor: false, visualizer: true })
          .then(() => false, () => true),
        glassSetting: await window.shengji.saveSettings({ ...snapshot.settings, glassEffects: 'yes' as unknown as boolean })
          .then(() => false, () => true),
        motionSetting: await window.shengji.saveSettings({ ...snapshot.settings, motionEffects: null as unknown as boolean })
          .then(() => false, () => true),
      };
    }, localId);
    assert.ok(Object.values(results).every(Boolean));
    return results;
  });

  await check('Immediate close/restart restores exact duplicate queue index and playback state', async () => {
    const expand = page.getByRole('button', { name: '展开播放队列', exact: true });
    if (await expand.count()) await expand.click();
    await page.getByRole('tab', { name: /播放队列/ }).click();
    await menu(localId, '加入队列');
    await page.waitForFunction(() => document.querySelectorAll('.queue-track').length === 3);
    await page.getByRole('button', { name: '播放队列第 3 首 Living', exact: true }).click();
    await playing();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.getByRole('button', { name: '顺序播放', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await dragRange(page.getByRole('slider', { name: '音量', exact: true }), 0.27);
    await page.getByRole('button', { name: '静音', exact: true }).click();
    await dragRange(page.getByRole('slider', { name: '播放进度', exact: true }), 0.41);
    const expected: Pick<PlaybackState, 'position' | 'volume' | 'muted'> = await audio();
    const expectedEffects: AudioEffectsSettings = { enabled: true, preset: 'custom', bands: [0, 0, 0, 0, 0, -12, 0, 0, 0, 0], width: 0, compressor: true, visualizer: false };
    await page.getByRole('button', { name: '音效', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '音效', exact: true });
    await modal.getByRole('switch', { name: '启用音效', exact: true }).setChecked(true);
    await modal.getByRole('combobox', { name: '音色预设', exact: true }).selectOption('flat');
    await modal.getByRole('slider', { name: '均衡器 1000 Hz', exact: true }).press('Home');
    await modal.getByRole('slider', { name: '立体声宽度', exact: true }).press('Home');
    await modal.getByRole('switch', { name: '动态压缩', exact: true }).setChecked(true);
    await effectsLayout();
    await page.screenshot({ path: path.join(screenshots, 'effects-dark-desktop.png') });
    await modal.getByRole('switch', { name: '频谱动画', exact: true }).setChecked(false);
    await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
    const closed = application!.waitForEvent('close');
    await page.getByRole('button', { name: '关闭声迹', exact: true }).click();
    await closed;
    application = undefined;
    await launch();
    await page.waitForFunction(() => document.querySelector<HTMLAudioElement>('#audio-engine')?.readyState! >= 2);
    const restored = await audio();
    const snapshot = await bootstrap();
    assert.equal(restored.paused, true, 'Restart must not autoplay');
    assert.ok(Math.abs(restored.position - expected.position) < 0.5);
    assert.ok(Math.abs(restored.volume - expected.volume) < 0.01);
    assert.equal(restored.muted, expected.muted);
    assert.equal(snapshot.playback.index, 2);
    assert.equal(snapshot.playback.currentId, localId);
    assert.deepEqual(snapshot.playback.queue, [fixtureId, localId, localId]);
    assert.equal(snapshot.playback.mode, 'loop');
    assert.equal(snapshot.settings.theme, 'dark');
    assert.ok(snapshot.favorites.some((track) => track.id === localId));
    assert.equal(snapshot.playlists.find((playlist) => playlist.id === playlistId)?.name, 'E2E Renamed');
    assert.ok(snapshot.recent.some((track) => track.id === localId));
    assert.ok(snapshot.searchHistory.length);
    assert.deepEqual(snapshot.audioEffects, expectedEffects);
    await page.getByRole('button', { name: '音效', exact: true }).click();
    const restoredModal = page.getByRole('dialog', { name: '音效', exact: true });
    assert.equal(await restoredModal.getByRole('combobox', { name: '音色预设', exact: true }).inputValue(), 'custom');
    assert.equal(await restoredModal.getByRole('slider', { name: '均衡器 1000 Hz', exact: true }).inputValue(), '-12');
    assert.equal(await restoredModal.getByRole('switch', { name: '频谱动画', exact: true }).isChecked(), false);
    await restoredModal.getByRole('button', { name: '关闭对话框', exact: true }).click();
    if (process.env.SHENGJI_E2E_SKIP_ONLINE !== '1') {
      await page.getByRole('button', { name: '歌词', exact: true }).click();
      await page.getByRole('heading', { name: '纯音乐', exact: true }).waitFor();
      await page.screenshot({ path: path.join(screenshots, 'lyrics-restored-dark.png') });
    }
    await page.screenshot({ path: path.join(screenshots, 'restored-dark.png') });
    return { position: restored.position, volume: restored.volume, muted: restored.muted, queue: snapshot.playback.queue, index: snapshot.playback.index, mode: snapshot.playback.mode, theme: snapshot.settings.theme, effects: snapshot.audioEffects };
  });

  await check('No renderer JavaScript errors', async () => {
    assert.deepEqual(rendererErrors, []);
    return { errors: rendererErrors.length };
  });
} catch (error) {
  failed = true;
  console.error(error);
  if (page! && !page.isClosed()) await page.screenshot({ path: path.join(screenshots, 'failure.png') }).catch(() => undefined);
} finally {
  await application?.close().catch(() => undefined);
  await writeFile(path.join(artifacts, executable ? 'packaged-e2e-results.json' : 'e2e-results.json'), JSON.stringify({
    date: new Date().toISOString(), executable: executable ? path.basename(executable) : 'development Electron', failed, profile, checks, rendererErrors,
  }, null, 2));
  if (failed) process.exitCode = 1;
}
