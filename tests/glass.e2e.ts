import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, type CDPSession, type ElectronApplication, type Page } from 'playwright';
import sharp from 'sharp';
import type { LibrarySnapshot } from '../shared/types';
import { writeWav } from './helpers';

const root = path.resolve('.');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
const artifacts = path.join(root, 'test-artifacts');
const screenshots = path.join(artifacts, 'screenshots');
await mkdir(screenshots, { recursive: true });
const profile = await mkdtemp(path.join(artifacts, 'glass-profile-'));
const fixture = path.join(profile, 'fixtures', 'Glass test pattern.wav');
const living = process.env.SHENGJI_LOCAL_TEST_FILE || path.join(os.homedir(), 'Desktop', 'Florian Bur - Living.mp3');
const executable = process.env.SHENGJI_E2E_EXECUTABLE;
const detailedTrace = process.env.SHENGJI_GLASS_TRACE_DETAIL === '1';
const prefix = `${executable ? 'packaged-glass' : 'glass'}${detailedTrace ? '-detailed' : ''}`;
const checks: { name: string; status: 'pass' | 'fail'; detail: unknown }[] = [];
const rendererErrors: string[] = [];
const rendererConsoleErrors: string[] = [];
let application: ElectronApplication | undefined;
let page: Page;
let fixtureId = '';
let failed = false;
let traceSession: CDPSession | undefined;
let traceActive = false;
let traceCategories: string[] = [];
let advertisedTraceCategories: string[] = [];
let machine: unknown;

type DrawSample = { frame: number; time: number; phase: string };
type LongTask = { duration: number; start: number; phase: string };
type InteractionPhase = { name: string; start: number; end?: number };
type PixelSample = {
  frame: number; colored: number; nonblank: number; hash: number; distinct: number;
  width: number; height: number; error: number; playerColorInsideCover: number; playerColorOutsideCover: number;
};
type DrawProbe = {
  samples: DrawSample[]; longTasks: LongTask[]; phases: InteractionPhase[];
  phase: string; start: number; observer: MutationObserver; tasks: PerformanceObserver;
};

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

async function launch(dataDir = profile, extraArgs: string[] = []): Promise<void> {
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    SHENGJI_TEST: '1', SHENGJI_DATA_DIR: dataDir,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SHENGJI_DEV_URL;
  delete env.NODE_PATH;
  application = await _electron.launch({
    ...(executable ? { executablePath: executable } : {}),
    args: [root, '--mute-audio', `--import=${living}`, `--import=${fixture}`, ...extraArgs],
    cwd: root, env, timeout: 60_000,
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') { rendererConsoleErrors.push(message.text()); console.error(`RENDERER ${message.text()}`); }
  });
  await page.locator('.player-bar').waitFor();
  await page.waitForFunction(() => Boolean(document.querySelector('#audio-engine')));
  await page.waitForFunction(() => document.documentElement.dataset.glass === 'off'
    || ['webgl2', 'fallback'].includes(document.querySelector<HTMLCanvasElement>('canvas[data-testid="glass-optics"]')?.dataset.renderer ?? ''));
}

async function state() {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-testid="glass-optics"]');
    return {
      count: document.querySelectorAll('canvas[data-testid="glass-optics"]').length,
      frame: Number(canvas?.dataset.frame ?? 0), renderer: canvas?.dataset.renderer,
      active: canvas?.dataset.active, texture: canvas?.dataset.texture,
      surfaces: Number(canvas?.dataset.surfaces ?? 0),
      glass: document.documentElement.dataset.glass, motion: document.documentElement.dataset.motion,
      width: canvas?.width ?? 0, height: canvas?.height ?? 0,
    };
  });
}

async function settled(): Promise<Awaited<ReturnType<typeof state>>> {
  const deadline = Date.now() + 7000;
  let previous = await state();
  while (Date.now() < deadline) {
    await page.waitForTimeout(350);
    const current = await state();
    if (current.frame === previous.frame && current.count === previous.count) return current;
    previous = current;
  }
  assert.fail('Optics must stop submitting frames after interactions settle');
}

async function settings(): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('switch', { name: '玻璃效果', exact: true }).waitFor();
}

async function toggle(name: string, enabled: boolean): Promise<void> {
  const control = page.getByRole('switch', { name, exact: true });
  await control.setChecked(enabled);
  await page.waitForFunction(({ name, enabled }) => window.shengji.bootstrap().then((snapshot) =>
    (name === '玻璃效果' ? snapshot.settings.glassEffects : snapshot.settings.motionEffects) === enabled), { name, enabled });
  await page.waitForFunction((name) => {
    const control = [...document.querySelectorAll<HTMLInputElement>('.settings-section input[role="switch"]')]
      .find((input) => input.getAttribute('aria-label') === name);
    return control && !control.disabled;
  }, name);
}

async function playFixture(): Promise<void> {
  await page.getByRole('button', { name: '本地音乐', exact: true }).click();
  await page.locator(`[data-track-id="${fixtureId}"]`).getByRole('button', { name: '播放 Tagged song', exact: true }).click();
  await page.waitForFunction(() => {
    const audio = document.querySelector<HTMLAudioElement>('#audio-engine');
    return audio && !audio.paused && audio.readyState >= 2 && audio.currentTime > 0.15;
  });
}

async function layout() {
  const result = await page.evaluate(() => {
    const boxes = ['.titlebar', '.sidebar', '.main-content', '.player-bar'].map((selector) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const { x, y, right, bottom, width, height } = element.getBoundingClientRect();
      return { selector, x, y, right, bottom, width, height, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
    const queueElement = document.querySelector<HTMLElement>('.queue-panel:not([aria-hidden="true"])');
    const queueBounds = queueElement?.getBoundingClientRect();
    const queue = queueBounds ? { x: queueBounds.x, y: queueBounds.y, right: queueBounds.right, bottom: queueBounds.bottom } : null;
    const rootElement = document.querySelector<HTMLElement>('#root')!;
    const root = rootElement.getBoundingClientRect();
    const app = document.querySelector<HTMLElement>('.app')!;
    const appBounds = app.getBoundingClientRect();
    const active = document.activeElement;
    const scrolling = [document.documentElement, document.body, rootElement, app].map((element) => ({
      selector: element === document.documentElement ? 'html' : element === document.body ? 'body' : element === rootElement ? '#root' : '.app',
      scrollLeft: element.scrollLeft, scrollTop: element.scrollTop, scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth, overflowX: getComputedStyle(element).overflowX,
    }));
    return { width: innerWidth, height: innerHeight, root: { x: root.x, y: root.y, width: root.width, height: root.height }, app: { x: appBounds.x, width: appBounds.width, scrollLeft: app.scrollLeft, scrollWidth: app.scrollWidth, clientWidth: app.clientWidth }, scrolling, active: { tag: active?.tagName, label: active?.getAttribute('aria-label'), text: active?.textContent?.slice(0, 50) }, boxes, queue, documentOverflow: document.documentElement.scrollWidth - innerWidth };
  });
  const [titlebar, sidebar, content, player] = result.boxes;
  assert.ok(result.scrolling.every((element) => element.scrollLeft === 0), `A window root scrolled horizontally: ${JSON.stringify(result.scrolling)}`);
  assert.ok(Math.abs(result.root.x) <= 1 && Math.abs(result.root.width - result.width) <= 1, 'Root is shifted or uses an outdated viewport width');
  assert.ok(Math.abs(titlebar.x) <= 1 && Math.abs(sidebar.x) <= 1, `Window chrome is shifted left or right: ${JSON.stringify(result)}`);
  assert.ok(Math.abs(player.x - 14) <= 1 && Math.abs(player.right - (result.width - 14)) <= 1, 'Floating dock must keep its horizontal clearance');
  assert.ok(Math.abs(player.bottom - (result.height - 12)) <= 1 && Math.abs(player.height - 90) <= 1, 'Floating dock height or bottom clearance changed');
  assert.ok(content.y >= titlebar.bottom - 1 && Math.abs(content.bottom - result.height) <= 1, 'Real content must continue behind the dock without overlapping the titlebar');
  assert.ok(sidebar.bottom <= player.y + 1 && player.right <= result.width + 1, 'Navigation or player exceeds bounds');
  assert.ok(content.scrollWidth <= content.clientWidth + 1 && result.documentOverflow <= 1, 'Window overflows horizontally');
  if (result.queue) {
    assert.ok(Math.abs(result.queue.y - titlebar.bottom) <= 1, 'Queue starts below or overlaps the titlebar');
    assert.ok(Math.abs(player.y - result.queue.bottom - 8) <= 1, 'Queue must leave eight pixels above the floating dock');
    assert.ok(result.queue.x >= 0 && result.queue.right <= result.width + 1, 'Queue extends outside the window');
  }
  return result;
}

async function compactQueueFocusCheck() {
  const measurements = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    const open = await page.locator('.queue-panel').getAttribute('data-open') === 'true';
    const button = page.getByRole('button', { name: open ? '收起播放队列' : '展开播放队列', exact: true });
    await button.focus();
    const focused = await layout();
    await button.click();
    await page.waitForFunction((expected) => document.querySelector('.queue-panel')?.getAttribute('data-open') === String(expected), !open);
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '设置', exact: true }).focus();
    measurements.push({ cycle, queueOpen: !open, focused, after: await layout() });
  }
  return measurements;
}

async function stableScreenshot(name: string): Promise<void> {
  await layout();
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.waitForTimeout(120);
    const png = await page.screenshot();
    const metadata = await sharp(png).metadata();
    assert.ok(metadata.width && metadata.height);
    const controls = await sharp(png).extract({ left: metadata.width - 96, top: 8, width: 88, height: 40 }).stats();
    if (controls.channels.some((channel) => channel.stdev > 4)) {
      await writeFile(path.join(screenshots, `${prefix}-${name}.png`), png);
      return;
    }
    await writeFile(path.join(screenshots, `${prefix}-${name}-unsettled-${attempt + 1}.png`), png);
    await page.waitForTimeout(350);
  }
  assert.fail(`Screenshot ${name} has blank right-side window controls despite valid DOM layout`);
}

async function backdrop() {
  return page.evaluate(() => ['.titlebar', '.sidebar', '.player-bar'].map((selector) => {
    const style = getComputedStyle(document.querySelector(selector)!);
    const context = document.createElement('canvas').getContext('2d')!;
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return { selector, filter: style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter'), alpha: context.getImageData(0, 0, 1, 1).data[3], background: style.backgroundColor };
  }));
}

// Read in the data-frame microtask, before Chromium discards the drawing buffer.
// Only this pixel check adds a GPU readback; the performance observer does not.
async function installPixelProbe(selector?: string): Promise<void> {
  await page.evaluate((selector) => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-testid="glass-optics"]')!;
    const gl = canvas.getContext('webgl2')!;
    const results: PixelSample[] = [];
    const observer = new MutationObserver(() => {
      if (results.length >= 6 || gl.isContextLost()) return;
      const region = selector ? document.querySelector(selector)!.getBoundingClientRect() : null;
      const scaleX = gl.drawingBufferWidth / innerWidth, scaleY = gl.drawingBufferHeight / innerHeight;
      const x = region ? Math.max(0, Math.floor(region.left * scaleX)) : 0;
      const y = region ? Math.max(0, Math.floor((innerHeight - region.bottom) * scaleY)) : 0;
      const width = region ? Math.min(gl.drawingBufferWidth - x, Math.ceil(region.width * scaleX)) : gl.drawingBufferWidth;
      const height = region ? Math.min(gl.drawingBufferHeight - y, Math.ceil(region.height * scaleY)) : gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let nonblank = 0, colored = 0, hash = 2166136261;
      let playerColorInsideCover = 0, playerColorOutsideCover = 0;
      const player = document.querySelector('.player-bar')?.getBoundingClientRect();
      const underlay = document.querySelector('[data-glass-backdrop]')?.getBoundingClientRect();
      const colors = new Set<number>();
      for (let i = 0; i < pixels.length; i += 16) {
        if (pixels[i + 3]) {
          nonblank++;
          if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 8) {
            colored++;
            const cssX = (x + (i / 4) % width) / scaleX;
            const cssY = (gl.drawingBufferHeight - y - Math.floor((i / 4) / width)) / scaleY;
            if (player && underlay && cssX > player.left + 2 && cssX < player.right - 2 && cssY > player.top + 2 && cssY < player.bottom - 2) {
              if (cssX < underlay.right - 2) playerColorInsideCover++;
              if (cssX > underlay.right + 2) playerColorOutsideCover++;
            }
          }
          colors.add((pixels[i] >> 4) << 8 | (pixels[i + 1] >> 4) << 4 | pixels[i + 2] >> 4);
        }
        hash = Math.imul(hash ^ pixels[i], 16777619) >>> 0;
        hash = Math.imul(hash ^ pixels[i + 3], 16777619) >>> 0;
      }
      results.push({ frame: Number(canvas.dataset.frame), colored, nonblank, hash, distinct: colors.size, width, height, error: gl.getError(), playerColorInsideCover, playerColorOutsideCover });
    });
    observer.observe(canvas, { attributes: true, attributeFilter: ['data-frame'] });
    (window as unknown as { glassPixels: { results: typeof results; observer: MutationObserver } }).glassPixels = { results, observer };
  }, selector);
}

async function pixels() {
  return page.evaluate(() => {
    const probe = (window as unknown as { glassPixels: { results: PixelSample[]; observer: MutationObserver } }).glassPixels;
    probe.observer.disconnect();
    return probe.results;
  });
}

async function overlayPixels(selector: string) {
  await settled();
  const box = await page.locator(selector).boundingBox();
  assert.ok(box);
  const bounds = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= bounds.width + 1 && box.y + box.height <= bounds.height + 1, 'Overlay extends outside the viewport');
  await installPixelProbe(selector);
  await page.mouse.move(box.x + box.width * 0.35, box.y + 3);
  await page.mouse.move(box.x + box.width * 0.7, box.y + 4, { steps: 8 });
  await page.waitForFunction(() => (window as unknown as { glassPixels: { results: unknown[] } }).glassPixels.results.length >= 3);
  const samples = await pixels();
  assert.ok(samples.every((sample) => sample.error === 0));
  assert.ok(samples.some((sample) => sample.nonblank > 20), `No real glass pixels inside ${selector}`);
  return { box, samples, optics: await state() };
}

async function watchExit(selector: string): Promise<void> {
  await page.evaluate((selector) => {
    const element = document.querySelector<HTMLElement>(selector)!;
    const states: { state: string | undefined; inert: boolean; animation: string; duration: string }[] = [];
    const observer = new MutationObserver(() => {
      const style = getComputedStyle(element);
      states.push({ state: element.dataset.state, inert: element.inert, animation: style.animationName, duration: style.animationDuration });
    });
    observer.observe(element, { attributes: true, attributeFilter: ['data-state'] });
    (window as unknown as { glassExit: { states: typeof states; observer: MutationObserver } }).glassExit = { states, observer };
  }, selector);
}

async function exitStates() {
  return page.evaluate(() => {
    const probe = (window as unknown as { glassExit: { states: { state: string | undefined; inert: boolean; animation: string; duration: string }[]; observer: MutationObserver } }).glassExit;
    probe.observer.disconnect();
    return probe.states;
  });
}

async function finishTrace() {
  if (!traceSession || !traceActive) return undefined;
  const completed = new Promise<{ stream?: string }>((resolve) => traceSession!.once('Tracing.tracingComplete', resolve));
  await traceSession.send('Tracing.end');
  traceActive = false;
  const { stream } = await completed;
  assert.ok(stream, 'Chromium must return the requested trace stream');
  let raw = '';
  while (true) {
    const chunk = await traceSession.send('IO.read', { handle: stream, size: 1_048_576 });
    raw += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data;
    if (chunk.eof) break;
  }
  await traceSession.send('IO.close', { handle: stream });
  await writeFile(path.join(artifacts, `${prefix}-interaction-trace.json`), raw);
  const events = (JSON.parse(raw) as { traceEvents: { name: string; cat?: string; dur?: number; ph?: string; pid?: number; args?: Record<string, unknown> }[] }).traceEvents;
  const names = new Map<string, number>();
  for (const event of events) if (/DrawFrame|SubmitCompositorFrame|PipelineReporter|GPUTask|Paint|CompositeLayers|BeginFrame|RunTask/.test(event.name)) names.set(event.name, (names.get(event.name) ?? 0) + 1);
  const gpuProcessIds = [...new Set(events.filter((event) => event.name === 'process_name' && /gpu/i.test(String(event.args?.name))).map((event) => event.pid).filter((pid): pid is number => pid !== undefined))];
  const gpuEvents = events.filter((event) => event.ph !== 'M' && (/gpu/i.test(event.cat ?? '') || gpuProcessIds.includes(event.pid ?? -1)));
  const gpuNames = new Map<string, number>();
  for (const event of gpuEvents) gpuNames.set(event.name, (gpuNames.get(event.name) ?? 0) + 1);
  await traceSession.detach();
  traceSession = undefined;
  return {
    events: events.length, eventCounts: Object.fromEntries(names), mode: detailedTrace ? 'detailed' : 'standard', categories: traceCategories, advertisedCategories: advertisedTraceCategories,
    gpuProcessIds, gpuEvents: gpuEvents.length,
    gpuEventCounts: Object.fromEntries([...gpuNames].sort((a, b) => b[1] - a[1]).slice(0, 12)),
    traceFile: `${prefix}-interaction-trace.json`,
  };
}

try {
  await check('Independent muted offscreen runtime matches release and reports actual GPU backend', async () => {
    assert.ok((await stat(living)).size > 1000);
    const colors = Buffer.alloc(128 * 128 * 3);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      const offset = (y * 128 + x) * 3;
      colors[offset] = x < 64 ? 215 : 48;
      colors[offset + 1] = y < 64 ? 180 : 76;
      colors[offset + 2] = ((x >> 4) + (y >> 4)) % 2 ? 210 : 62;
    }
    const artwork = await sharp(colors, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
    await writeWav(fixture, 40, true, 0.25, artwork);
    await launch();
    const runtime = await application!.evaluate(async ({ app, BrowserWindow, screen }) => ({
      version: app.getVersion(), packaged: app.isPackaged,
      windows: BrowserWindow.getAllWindows().map((window) => ({ bounds: window.getBounds(), focused: window.isFocused() })),
      hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(),
      processes: app.getAppMetrics().map((process) => ({ pid: process.pid, type: process.type })),
      displays: screen.getAllDisplays().map((display) => ({ bounds: display.bounds, scaleFactor: display.scaleFactor, refreshHz: display.displayFrequency })),
      versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
      gpuFeatureStatus: app.getGPUFeatureStatus(), gpuInfo: await app.getGPUInfo('complete'),
    }));
    assert.equal(runtime.version, version);
    assert.equal(runtime.packaged, Boolean(executable));
    assert.ok(runtime.windows.every((window) => window.bounds.x < -4000 && !window.focused));
    const snapshot: LibrarySnapshot = await page.evaluate(() => window.shengji.bootstrap());
    const track = snapshot.localTracks.find((track) => track.filePath === fixture);
    assert.ok(track?.artwork);
    fixtureId = track.id;
    assert.equal(snapshot.settings.glassEffects, true);
    assert.equal(snapshot.settings.motionEffects, true);
    const backend = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-testid="glass-optics"]')!;
      const gl = canvas.dataset.renderer === 'webgl2' ? canvas.getContext('webgl2') : null;
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      return { renderer: canvas.dataset.renderer, unmaskedRenderer: debug ? gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null, vendor: debug ? gl!.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null, version: gl?.getParameter(gl.VERSION), attributes: gl?.getContextAttributes() };
    });
    machine = {
      cpu: { model: os.cpus()[0]?.model, logicalProcessors: os.cpus().length },
      os: { type: os.type(), release: os.release(), version: os.version(), architecture: os.arch() },
      displays: runtime.displays, versions: runtime.versions,
      gpuDevices: (runtime.gpuInfo as { gpuDevice?: unknown[] }).gpuDevice, backend,
      testWindow: 'Muted, unfocused, entirely outside all visible displays',
    };
    await writeFile(path.join(artifacts, `${prefix}-gpu-info.json`), JSON.stringify({ runtime, backend, machine }, null, 2));
    assert.equal(backend.renderer, 'webgl2', 'Normal launch must exercise WebGL2; fallback alone is not a GPU pass');
    assert.equal(backend.attributes?.preserveDrawingBuffer, false);
    return { version, packaged: runtime.packaged, gpuFeatureStatus: runtime.gpuFeatureStatus, backend, machine, gpuInfoFile: `${prefix}-gpu-info.json`, artwork: 'Synthetic embedded test pattern, not catalog artwork' };
  });

  await check('One WebGL2 optics canvas draws real nonblank changing pixels and uploads artwork', async () => {
    await playFixture();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('canvas[data-testid="glass-optics"]')?.dataset.texture === 'cover');
    const before = await settled();
    assert.equal(before.count, 1);
    assert.ok(before.surfaces >= 3 && before.width >= 900 && before.height >= 620);
    await installPixelProbe();
    await page.mouse.move(390, 42);
    await page.mouse.move(720, 45, { steps: 12 });
    await page.waitForFunction(() => (window as unknown as { glassPixels: { results: unknown[] } }).glassPixels.results.length >= 3);
    const samples = await pixels();
    await writeFile(path.join(artifacts, `${prefix}-pixels.json`), JSON.stringify({ samples, rendererConsoleErrors }, null, 2));
    assert.ok(samples.every((sample) => sample.error === 0), `WebGL pixel diagnostics: ${JSON.stringify(samples)}`);
    assert.ok(samples.some((sample) => sample.nonblank > 100 && sample.distinct > 3), 'Canvas must contain actual visible pixels');
    assert.ok(new Set(samples.map((sample) => sample.hash)).size > 1, 'Interaction must change rendered pixels');
    assert.ok(samples.some((sample) => sample.playerColorInsideCover > 10), 'The real cover underlay must supply colored refraction pixels');
    assert.ok(samples.every((sample) => sample.playerColorOutsideCover === 0), 'Cover refraction must not invent image pixels outside the actual masked underlay');
    return { state: await state(), samples };
  });

  await check('CSS composites genuine translucent DOM backdrop in light and dark themes', async () => {
    const light = await backdrop();
    assert.ok(light.every((surface) => surface.filter !== 'none' && surface.alpha > 0 && surface.alpha < 255));
    await stableScreenshot('desktop-light');
    const lightLayout = await layout();
    await settings();
    assert.equal(await page.locator('.settings-footer span').nth(1).innerText(), version);
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    const dark = await backdrop();
    assert.ok(dark.every((surface) => surface.filter !== 'none' && surface.alpha > 0 && surface.alpha < 255));
    assert.notEqual(light[0].background, dark[0].background);
    await settled();
    await stableScreenshot('desktop-dark');
    return { light, dark, lightLayout, darkLayout: await layout() };
  });

  await check('Navigation indicator follows repeated real navigation and compact controls remain contained', async () => {
    const indicator = page.getByTestId('nav-indicator');
    assert.equal(await indicator.count(), 1);
    const start = await indicator.boundingBox();
    for (const name of ['本地音乐', '我的收藏', '最近播放', '本地音乐']) await page.getByRole('button', { name, exact: true }).click();
    await page.waitForFunction(() => {
      const indicator = document.querySelector('[data-testid="nav-indicator"]')!.getBoundingClientRect();
      const selected = document.querySelector('.sidebar .nav-item.selected')!.getBoundingClientRect();
      return Math.abs(indicator.y + indicator.height / 2 - selected.y - selected.height / 2) < 3;
    });
    const end = await indicator.boundingBox();
    assert.ok(start && end && Math.abs(end.y - start.y) > 5);
    const main = await application!.browserWindow(page);
    await main.evaluate((window) => { window.setSize(900, 620); window.setPosition(-12000, -12000); });
    await page.waitForFunction(() => innerWidth < 960 && innerHeight < 680);
    await settled();
    const compactDark = await layout();
    const compactDarkFocus = await compactQueueFocusCheck();
    await stableScreenshot('compact-dark');
    await settings();
    const controls = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.settings-section [role="switch"]')].map((control) => {
      const { x, right, y, bottom } = control.getBoundingClientRect();
      return { label: control.getAttribute('aria-label'), x, right, y, bottom, visible: control.offsetParent !== null };
    }));
    assert.ok(controls.filter((control) => control.label === '玻璃效果' || control.label === '界面动画').every((control) => control.visible && control.x >= 0 && control.right <= compactDark.width));
    await page.getByRole('button', { name: '浅色', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await settled();
    const compactLight = await layout();
    const compactLightFocus = await compactQueueFocusCheck();
    await stableScreenshot('compact-light');
    await main.evaluate((window) => { window.setSize(1280, 800); window.setPosition(-12000, -12000); });
    await page.waitForFunction(() => innerWidth >= 1280 && innerHeight >= 800);
    return { start, end, compactDark, compactDarkFocus, controls, compactLight, compactLightFocus };
  });

  await check('Actual interaction draw intervals and Chromium trace exclude idle RAF and pixel-readback overhead', async () => {
    await playFixture();
    await settled();
    traceSession = await page.context().newCDPSession(page);
    // Chromium can enumerate an empty list before tracing; actual captured GPU events are the capability check.
    advertisedTraceCategories = await application!.evaluate(({ contentTracing }) => contentTracing.getCategories());
    traceCategories = ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'blink.user_timing', 'cc', 'gpu', 'viz'];
    if (detailedTrace) traceCategories.push('disabled-by-default-gpu.service', 'disabled-by-default-gpu.device');
    await traceSession.send('Tracing.start', { categories: traceCategories.join(','), transferMode: 'ReturnAsStream' });
    traceActive = true;
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-testid="glass-optics"]')!;
      const samples: DrawSample[] = [];
      const longTasks: LongTask[] = [];
      const phases: InteractionPhase[] = [];
      const observer = new MutationObserver(() => {
        const probe = (window as unknown as { glassPerformance: DrawProbe }).glassPerformance;
        samples.push({ frame: Number(canvas.dataset.frame), time: performance.now(), phase: probe.phase });
      });
      observer.observe(canvas, { attributes: true, attributeFilter: ['data-frame'] });
      const tasks = new PerformanceObserver((entries) => longTasks.push(...entries.getEntries().map((entry) => ({ duration: entry.duration, start: entry.startTime, phase: phases.slice().reverse().find((phase) => entry.startTime >= phase.start)?.name ?? '' }))));
      if (PerformanceObserver.supportedEntryTypes.includes('longtask')) tasks.observe({ type: 'longtask', buffered: false });
      (window as unknown as { glassPerformance: DrawProbe }).glassPerformance = { samples, longTasks, phases, phase: '', start: performance.now(), observer, tasks };
    });
    const phase = (name: string) => page.evaluate((name) => {
      const probe = (window as unknown as { glassPerformance: DrawProbe }).glassPerformance;
      const now = performance.now();
      if (probe.phases.length) probe.phases[probe.phases.length - 1].end = now;
      probe.phase = name;
      probe.phases.push({ name, start: now });
      performance.mark(`glass-interaction:${name}`);
    }, name);
    const drag = async (name: string, from: number, to: number) => {
      const slider = page.getByRole('slider', { name, exact: true });
      const box = await slider.boundingBox();
      assert.ok(box && box.width > 20);
      const x = (fraction: number) => box.x + 6 + (box.width - 12) * fraction;
      await page.mouse.move(x(from), box.y + box.height / 2);
      await page.mouse.down();
      for (let step = 1; step <= 24; step++) {
        await page.mouse.move(x(from + (to - from) * step / 24), box.y + box.height / 2);
        await page.waitForTimeout(14);
      }
      await page.mouse.up();
      const value = await slider.evaluate((element) => Number((element as HTMLInputElement).value));
      const maximum = await slider.evaluate((element) => Number((element as HTMLInputElement).max));
      assert.ok(Math.abs(value / maximum - to) < 0.08, `Real mouse drag did not update ${name}`);
      return { name, from, to, value, maximum, mouseMoves: 24 };
    };
    await phase('pointer-and-navigation');
    const names = ['我的收藏', '最近播放', '本地音乐'];
    for (let i = 0; i < 96; i++) {
      await page.mouse.move(350 + Math.sin(i / 7) * 150 + i * 2, 34 + Math.sin(i / 4) * 9);
      if (i % 16 === 0) await page.getByRole('button', { name: names[Math.floor(i / 16) % names.length], exact: true }).click();
      await page.waitForTimeout(24);
    }
    await phase('progress-and-volume-mouse-drags');
    const drags = [];
    for (let i = 0; i < 3; i++) {
      drags.push(await drag('播放进度', i % 2 === 0 ? 0.18 : 0.62, i % 2 === 0 ? 0.62 : 0.18));
      drags.push(await drag('音量', i % 2 === 0 ? 0.25 : 0.8, i % 2 === 0 ? 0.8 : 0.25));
    }
    await phase('next-and-previous-track-switches');
    const switches = [];
    for (let i = 0; i < 3; i++) {
      for (const name of ['下一首', '上一首']) {
        const source = await page.locator('#audio-engine').evaluate((audio) => (audio as HTMLAudioElement).currentSrc);
        await page.getByRole('button', { name, exact: true }).click();
        await page.waitForFunction((source) => {
          const audio = document.querySelector<HTMLAudioElement>('#audio-engine');
          return audio && audio.currentSrc !== source && !audio.paused && audio.readyState >= 2 && audio.currentTime > 0.08;
        }, source);
        switches.push({ command: name, title: await page.locator('.now-meta strong').innerText(), decodedAndPlaying: true });
        await page.waitForTimeout(350);
      }
    }
    await phase('queue-open-and-close');
    const queueStates = [];
    for (let i = 0; i < 6; i++) {
      const open = await page.locator('.queue-panel').getAttribute('data-open') === 'true';
      await page.getByRole('button', { name: open ? '收起播放队列' : '展开播放队列', exact: true }).click();
      await page.waitForFunction((expected) => document.querySelector('.queue-panel')?.getAttribute('data-open') === String(expected), !open);
      queueStates.push(!open);
      await page.waitForTimeout(260);
    }
    await phase('effects-modal-open-and-close');
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: '音效', exact: true }).click();
      await page.locator('.effects-modal').waitFor();
      await page.waitForTimeout(260);
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await page.locator('.effects-modal').waitFor({ state: 'detached' });
      await page.waitForTimeout(80);
    }
    const observation = await page.evaluate(() => {
      const probe = (window as unknown as { glassPerformance: DrawProbe }).glassPerformance;
      probe.observer.disconnect();
      probe.tasks.disconnect();
      const end = performance.now();
      probe.phases[probe.phases.length - 1].end = end;
      return { samples: probe.samples, longTasks: probe.longTasks, phases: probe.phases, elapsedMs: end - probe.start };
    });
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    assert.ok(observation.samples.length >= 10, 'Real interactions must submit actual WebGL draws');
    assert.ok(observation.samples.slice(1).every((sample, index) => sample.frame - observation.samples[index].frame === 1), 'Each observed render interval must describe one real submission');
    const summarize = (samples: DrawSample[]) => {
      const intervals = samples.slice(1).flatMap((sample, index) => sample.phase === samples[index].phase ? [sample.time - samples[index].time] : []).sort((a, b) => a - b);
      const quantile = (fraction: number) => intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * fraction))] ?? 0;
      const above = (threshold: number) => {
        const count = intervals.filter((value) => value > threshold).length;
        return { count, percentage: intervals.length ? count * 100 / intervals.length : 0 };
      };
      return {
        draws: samples.length, measuredIntervals: intervals.length, medianIntervalMs: quantile(0.5), p95IntervalMs: quantile(0.95),
        intervalsOver33_3Ms: above(33.3), intervalsOver50Ms: above(50),
        estimatedMissedSlotsAt16_67Ms: intervals.reduce((total, interval) => total + Math.max(0, Math.round(interval / 16.67) - 1), 0),
      };
    };
    const report = {
      ...summarize(observation.samples), elapsedMs: observation.elapsedMs,
      submissionRatePerSecond: observation.samples.length * 1000 / observation.elapsedMs,
      phases: observation.phases.map((phase) => ({ ...phase, elapsedMs: phase.end! - phase.start, ...summarize(observation.samples.filter((sample) => sample.phase === phase.name)), longTasks: observation.longTasks.filter((task) => task.phase === phase.name) })),
      interactions: { navigationClicks: 6, pointerMoves: 96, drags, switches, queueStates, effectsModalOpenCloseCycles: 3, pausedAfterSamplingBeforeTraceRead: true },
      longTasks: observation.longTasks, trace: await finishTrace(), machine,
      interpretation: 'Observed WebGL submission intervals during actual controls and finite animations, excluding inter-phase gaps. These are not display FPS; the 16.67 ms missed-slot estimate is a rounded 60 Hz reference, not measured presentation loss. Muted unfocused offscreen window; no test-injected GPU readback in this measurement. Audio is paused after sampling, before tracing ends and the trace stream is read.',
    };
    await writeFile(path.join(artifacts, `${prefix}-performance.json`), JSON.stringify({ ...report, samples: observation.samples }, null, 2));
    assert.ok(report.trace && report.trace.events > 10);
    assert.ok(report.trace.gpuEvents > 0, 'The captured trace must contain actual GPU-service or GPU-process events');
    return report;
  });

  await check('Modal and menu have actual local glass pixels, stay contained, and animate inert exits', async () => {
    const main = await application!.browserWindow(page);
    const measurements: unknown[] = [];
    for (const compact of [false, true]) {
      if (compact) {
        await main.evaluate((window) => { window.setSize(900, 620); window.setPosition(-12000, -12000); });
        await page.waitForFunction(() => innerWidth < 960 && innerHeight < 680);
      }
      await page.getByRole('button', { name: '本地音乐', exact: true }).click();
      await page.getByRole('button', { name: '音效', exact: true }).click();
      const modal = await overlayPixels('.effects-modal');
      await stableScreenshot(`modal-${compact ? 'compact' : 'desktop'}`);
      await watchExit('.effects-modal');
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await page.screenshot({ path: path.join(screenshots, `${prefix}-modal-exit-${compact ? 'compact' : 'desktop'}.png`) });
      await page.locator('.effects-modal').waitFor({ state: 'detached' });
      const modalExit = await exitStates();
      assert.ok(modalExit.some((entry) => entry.state === 'closing' && entry.inert && entry.animation.includes('glass-out')));
      await page.locator(`[data-track-id="${fixtureId}"]`).getByRole('button', { name: /的更多操作$/ }).click();
      const menu = await overlayPixels('.dropdown-menu');
      await stableScreenshot(`menu-${compact ? 'compact' : 'desktop'}`);
      await watchExit('.dropdown-menu');
      await page.keyboard.press('Escape');
      await page.locator('.dropdown-menu').waitFor({ state: 'detached' });
      const menuExit = await exitStates();
      assert.ok(menuExit.some((entry) => entry.state === 'closing' && entry.inert && entry.animation.includes('glass-out')));
      measurements.push({ compact, modal, modalExit, menu, menuExit });
    }
    await main.evaluate((window) => { window.setSize(1280, 800); window.setPosition(-12000, -12000); });
    await page.waitForFunction(() => innerWidth >= 1280 && innerHeight >= 800);
    return measurements;
  });

  await check('Mini player has one real artwork-backed optics canvas, contained controls and unfocused main restoration', async () => {
    await playFixture();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const mainPage = page;
    const opened = application!.waitForEvent('window');
    await mainPage.getByRole('button', { name: '迷你播放器', exact: true }).click();
    const mini = await opened;
    mini.setDefaultTimeout(30_000);
    mini.on('pageerror', (error) => rendererErrors.push(error.message));
    mini.on('console', (message) => { if (message.type() === 'error') rendererConsoleErrors.push(message.text()); });
    await mini.locator('.mini-player').waitFor();
    await mini.waitForFunction(() => document.querySelector<HTMLCanvasElement>('canvas[data-testid="glass-optics"]')?.dataset.renderer === 'webgl2');
    await mini.waitForFunction(() => document.querySelector<HTMLCanvasElement>('canvas[data-testid="glass-optics"]')?.dataset.texture === 'cover');
    const miniLayout = await mini.evaluate(() => {
      const boxes = ['.mini-player-frame', '.mini-player', '.mini-titlebar', '.mini-track', '.mini-timeline'].map((selector) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        const rect = element.getBoundingClientRect();
        return { selector, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
      });
      return { width: innerWidth, height: innerHeight, boxes };
    });
    assert.ok(miniLayout.boxes.every((box) => box.x >= 0 && box.y >= 0 && box.right <= miniLayout.width + 1 && box.bottom <= miniLayout.height + 1 && box.scrollWidth <= box.clientWidth + 1));
    const windows = await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ bounds: window.getBounds(), focused: window.isFocused() })));
    assert.ok(windows.every((window) => window.bounds.x < -4000 && !window.focused));
    let lightPixels: unknown;
    let darkPixels: unknown;
    let hiddenMini: Awaited<ReturnType<typeof state>>;
    try {
      page = mini;
      lightPixels = await overlayPixels('.mini-player');
      await mini.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await mini.screenshot({ path: path.join(screenshots, `${prefix}-mini-light.png`) });
      assert.equal((await state()).count, 1);
      assert.equal(await mini.locator('#audio-engine').count(), 0, 'Mini must control the main engine, not create another audio engine');
      await mini.getByRole('button', { name: '播放', exact: true }).click();
      await mainPage.waitForFunction(() => {
        const audio = document.querySelector<HTMLAudioElement>('#audio-engine');
        return audio && !audio.paused && audio.readyState >= 2;
      });
      await mini.getByRole('button', { name: '暂停', exact: true }).click();
      await mainPage.waitForFunction(() => document.querySelector<HTMLAudioElement>('#audio-engine')?.paused === true);
      await mainPage.getByRole('button', { name: '设置', exact: true }).click();
      await mainPage.getByRole('button', { name: '深色', exact: true }).click();
      await mini.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      darkPixels = await overlayPixels('.mini-player');
      await mini.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await mini.screenshot({ path: path.join(screenshots, `${prefix}-mini-dark.png`) });
      await mainPage.getByRole('button', { name: '浅色', exact: true }).click();
      await mini.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      await mini.getByRole('button', { name: '还原主播放器', exact: true }).click();
      await mainPage.waitForFunction(() => document.documentElement.dataset.windowVisible === 'true');
      await mini.waitForTimeout(350);
      hiddenMini = await state();
      await mini.waitForTimeout(700);
      assert.equal((await state()).frame, hiddenMini.frame);
      assert.equal(hiddenMini.active, 'false');
      await mainPage.getByRole('button', { name: '迷你播放器', exact: true }).click();
      await mini.waitForFunction(() => document.documentElement.dataset.windowVisible === 'true');
      const closed = mini.waitForEvent('close');
      await mini.getByRole('button', { name: '关闭迷你播放器', exact: true }).click();
      await closed;
    } finally { page = mainPage; }
    await page.waitForFunction(() => document.documentElement.dataset.windowVisible === 'true');
    const restored = await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ bounds: window.getBounds(), focused: window.isFocused(), visible: window.isVisible() })));
    assert.ok(restored.length === 1 && restored[0].visible && !restored[0].focused && restored[0].bounds.x < -4000);
    return { layout: miniLayout, lightPixels, darkPixels, hiddenMini: hiddenMini!, miniPlaybackControls: true, mainRestored: restored };
  });

  await check('Idle, reduced-motion and disabled animation stop continuous drawing', async () => {
    const idle = await settled();
    await page.waitForTimeout(700);
    assert.equal((await state()).frame, idle.frame);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.documentElement.dataset.motion === 'off');
    await page.getByRole('button', { name: '我的收藏', exact: true }).click();
    const reduced = await settled();
    await page.waitForTimeout(700);
    assert.equal((await state()).frame, reduced.frame);
    await page.screenshot({ path: path.join(screenshots, `${prefix}-reduced-motion.png`) });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await settings();
    await toggle('界面动画', false);
    await page.waitForFunction(() => document.documentElement.dataset.motion === 'off');
    const disabled = await settled();
    await page.waitForTimeout(700);
    assert.equal((await state()).frame, disabled.frame);
    await toggle('界面动画', true);
    await page.waitForFunction(() => document.documentElement.dataset.motion === 'on');
    return { idleFrame: idle.frame, reducedFrame: reduced.frame, animationDisabledFrame: disabled.frame, noContinuousIdleDraws: true };
  });

  await check('Hidden and minimized windows stop GPU work while audio keeps playing, then resume', async () => {
    await playFixture();
    const main = await application!.browserWindow(page);
    await main.evaluate((window) => window.hide());
    await page.waitForTimeout(350);
    const hidden = await state();
    const position = await page.locator('#audio-engine').evaluate((audio) => (audio as HTMLAudioElement).currentTime);
    await page.waitForTimeout(700);
    assert.equal((await state()).frame, hidden.frame);
    assert.equal(hidden.active, 'false');
    assert.ok(await page.locator('#audio-engine').evaluate((audio) => (audio as HTMLAudioElement).currentTime) > position + 0.3);
    await main.evaluate((window) => { window.setPosition(-12000, -12000); window.showInactive(); });
    await page.mouse.move(490, 40, { steps: 5 });
    await page.waitForFunction((frame) => Number(document.querySelector<HTMLCanvasElement>('canvas[data-testid="glass-optics"]')?.dataset.frame) > frame, hidden.frame);
    await main.evaluate((window) => window.minimize());
    await page.waitForTimeout(350);
    const minimized = await state();
    await page.waitForTimeout(700);
    assert.equal((await state()).frame, minimized.frame);
    assert.equal(minimized.active, 'false');
    await main.evaluate((window) => { window.restore(); window.setPosition(-12000, -12000); window.showInactive(); });
    await page.mouse.move(650, 42, { steps: 5 });
    await page.waitForFunction((frame) => Number(document.querySelector<HTMLCanvasElement>('canvas[data-testid="glass-optics"]')?.dataset.frame) > frame, minimized.frame);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    return { hidden, minimized, hiddenAudioContinued: true, restored: await state() };
  });

  await check('WebGL context loss degrades to opaque UI without crashing audio or navigation', async () => {
    const supported = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-testid="glass-optics"]')!;
      const extension = canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context');
      (window as unknown as { glassContextExtension: WEBGL_lose_context | null }).glassContextExtension = extension;
      extension?.loseContext();
      return Boolean(extension);
    });
    assert.equal(supported, true, 'Context-loss extension is required for this test');
    await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('canvas[data-testid="glass-optics"]')?.dataset.renderer === 'fallback');
    const lost = await state();
    assert.equal(lost.glass, 'fallback');
    await playFixture();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await settings();
    await stableScreenshot('context-loss');
    const plain = await backdrop();
    assert.ok(plain.every((surface) => surface.filter === 'none' && surface.alpha === 255), 'Context loss must disable blur and use opaque window chrome');
    await page.evaluate(() => (window as unknown as { glassContextExtension: WEBGL_lose_context }).glassContextExtension.restoreContext());
    const restored = await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('canvas[data-testid="glass-optics"]')?.dataset.renderer === 'webgl2', undefined, { timeout: 8000 }).then(() => true, () => false);
    return { lost, plain, audioPlayableDuringFallback: true, navigationUsableDuringFallback: true, contextRestored: restored, afterRestore: await state() };
  });

  await check('Glass-off removes backdrop effects and restart preserves separate appearance choices', async () => {
    await settings();
    await toggle('玻璃效果', false);
    await toggle('界面动画', false);
    await page.waitForFunction(() => document.documentElement.dataset.glass === 'off' && document.documentElement.dataset.motion === 'off');
    const off = await settled();
    await page.waitForTimeout(700);
    assert.equal((await state()).frame, off.frame);
    const plain = await backdrop();
    assert.ok(plain.every((surface) => surface.filter === 'none'), 'Disabled glass must remove expensive CSS backdrop filters');
    await page.screenshot({ path: path.join(screenshots, `${prefix}-effects-off.png`) });
    const beforeRestart = await page.evaluate(() => window.shengji.bootstrap());
    await application!.close();
    application = undefined;
    await launch();
    const snapshot = await page.evaluate(() => window.shengji.bootstrap());
    assert.equal(snapshot.settings.glassEffects, false);
    assert.equal(snapshot.settings.motionEffects, false);
    assert.deepEqual(snapshot.playback.queue, beforeRestart.playback.queue);
    assert.equal(snapshot.playback.currentId, beforeRestart.playback.currentId);
    assert.equal(snapshot.playback.index, beforeRestart.playback.index);
    assert.equal(snapshot.playback.volume, beforeRestart.playback.volume);
    assert.equal(snapshot.playback.muted, beforeRestart.playback.muted);
    assert.equal(snapshot.playback.mode, beforeRestart.playback.mode);
    assert.ok(Math.abs(snapshot.playback.position - beforeRestart.playback.position) < 0.5, 'Restart must restore the saved playhead');
    await page.waitForFunction(() => document.documentElement.dataset.glass === 'off' && document.documentElement.dataset.motion === 'off');
    await settings();
    assert.equal(await page.getByRole('switch', { name: '玻璃效果', exact: true }).isChecked(), false);
    assert.equal(await page.getByRole('switch', { name: '界面动画', exact: true }).isChecked(), false);
    const noAutoplay = await page.locator('#audio-engine').evaluate((audio) => (audio as HTMLAudioElement).paused);
    assert.equal(noAutoplay, true);
    return { off, plain, restarted: { glassEffects: snapshot.settings.glassEffects, motionEffects: snapshot.settings.motionEffects, playback: snapshot.playback }, noAutoplay };
  });

  await check('Startup without WebGL uses explicit usable opaque fallback and still decodes local music', async () => {
    await application!.close();
    application = undefined;
    const fallbackProfile = await mkdtemp(path.join(artifacts, 'glass-fallback-profile-'));
    await launch(fallbackProfile, ['--disable-webgl']);
    const snapshot = await page.evaluate(() => window.shengji.bootstrap());
    fixtureId = snapshot.localTracks.find((track) => track.filePath === fixture)!.id;
    assert.equal((await state()).renderer, 'fallback');
    assert.equal((await state()).glass, 'fallback');
    await playFixture();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await stableScreenshot('webgl-unavailable');
    const css = await backdrop();
    assert.ok(css.every((surface) => surface.filter === 'none' && surface.alpha === 255), 'Unavailable WebGL must use the plain opaque fallback, not CSS blur');
    await settings();
    assert.equal(await page.getByRole('switch', { name: '玻璃效果', exact: true }).isChecked(), true);
    return { state: await state(), gpuFeatureStatus: await application!.evaluate(({ app }) => app.getGPUFeatureStatus()), css, layout: await layout(), localAudioDecoded: true };
  });

  await check('No uncaught renderer errors across themes, restoration and fallback', async () => {
    assert.deepEqual(rendererErrors, []);
    const shaderErrors = rendererConsoleErrors.filter((message) => /THREE\.WebGLProgram|Shader Error|(?:Fragment|Vertex) shader is not compiled/.test(message));
    assert.deepEqual(shaderErrors, [], 'A shader compile failure must never count as successful drawing');
    return { errors: 0, shaderErrors: 0 };
  });
} catch (error) {
  failed = true;
  console.error(error);
  if (page! && !page.isClosed()) await page.screenshot({ path: path.join(screenshots, `${prefix}-failure.png`) }).catch(() => undefined);
} finally {
  if (traceActive) await finishTrace().catch(() => undefined);
  await application?.close().catch(() => undefined);
  await writeFile(path.join(artifacts, `${prefix}-e2e-results.json`), JSON.stringify({ date: new Date().toISOString(), version, traceMode: detailedTrace ? 'detailed' : 'standard', executable: executable ? path.basename(executable) : 'development Electron', failed, checks, rendererErrors, rendererConsoleErrors, profile }, null, 2));
  if (failed) process.exitCode = 1;
}
