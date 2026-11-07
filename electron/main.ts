import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, protocol, safeStorage, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { mkdir, stat, open, rename, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseFile } from 'music-metadata';
import { z } from 'zod';
import { LibraryDatabase } from './database';
import { LocalLibrary } from './library';
import { mediaResponse, RemoteMedia } from './media';
import { fetchMedia, JsonClient, validateMediaUrl } from './network';
import { isOpenLicense, SourceRegistry } from './sources';
import { LyricsService } from './lyrics';
import { audioEffectsSchema } from '../shared/audio-effects';
import type { AudioEffectsSettings, DownloadRecord, MiniState, PlaybackState, PlayerCommand, PlayerSummary, SearchRequest, Settings, Track, VisualState } from '../shared/types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST = process.env.SHENGJI_TEST === '1';
const DEV_URL = process.env.SHENGJI_DEV_URL;
const htmlUrl = pathToFileURL(path.join(ROOT, 'dist', 'index.html')).href;
app.setName('声迹');
app.setPath('userData', process.env.SHENGJI_DATA_DIR || path.join(app.getPath('appData'), 'Shengji'));
protocol.registerSchemesAsPrivileged([{ scheme: 'shengji-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let window: BrowserWindow | null = null;
let mini: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let database: LibraryDatabase;
let library: LocalLibrary;
let sources: SourceRegistry;
let lyrics: LyricsService;
const remoteMedia = new RemoteMedia();
const catalog = new Map<string, Track>();
let lastMini: MiniState = { current: null, status: 'idle', position: 0, duration: 0, volume: 0.65, muted: TEST };
let summary: PlayerSummary = { title: '声迹', artist: '', playing: false, hasTrack: false };
let lastCheckpoint: PlaybackState | undefined;
let lastEffectsCheckpoint: AudioEffectsSettings | undefined;

const idSchema = z.string().min(1).max(2000);
const sourceSchema = z.enum(['netease', 'itunes', 'archive', 'jamendo']);
const settingsSchema = z.object({ theme: z.enum(['light', 'dark', 'system']), enabledSources: z.array(sourceSchema).max(4), downloadDir: z.string().max(1000), closeToTray: z.boolean(), mediaKeys: z.boolean(), glassEffects: z.boolean().default(true), motionEffects: z.boolean().default(true) });
const playbackSchema = z.object({ queue: z.array(idSchema).max(10000), currentId: idSchema.nullable(), index: z.number().int().min(-1).max(10000), position: z.number().finite().min(0).max(86400), volume: z.number().min(0).max(1), muted: z.boolean(), mode: z.enum(['order', 'loop', 'one', 'shuffle']) });
const nameSchema = z.string().trim().min(1).max(60);

function trusted(event: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  if (event.sender !== window?.webContents && event.sender !== mini?.webContents) return false;
  const url = event.senderFrame?.url ?? '';
  if (DEV_URL) { try { return new URL(url).origin === new URL(DEV_URL).origin; } catch { return false; } }
  return url.split('?')[0] === htmlUrl;
}

function handle<T>(channel: string, handler: (...args: any[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!trusted(event)) throw new Error('拒绝来自不受信任页面的请求');
    return handler(...args);
  });
}

function registerTracks(tracks: Track[]): void {
  for (const track of tracks) catalog.set(track.id, track);
  while (catalog.size > 4000) catalog.delete(catalog.keys().next().value!);
}

function getTrack(id: string): Track {
  idSchema.parse(id);
  const track = catalog.get(id) || database.getTrack(id);
  if (!track) throw new Error('曲目不存在，请重新搜索或导入');
  return track;
}

function getJamendoKey(): string | undefined {
  const encrypted = database.getValue<string | null>('jamendoCredential', null);
  if (!encrypted) return undefined;
  try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); } catch { return undefined; }
}

function sendCommand(command: PlayerCommand): void { window?.webContents.send('player:command', command); }
function showMain(): void { if (TEST) window?.showInactive(); else { window?.show(); window?.focus(); } }

function visualState(target: BrowserWindow): VisualState {
  const features = app.getGPUFeatureStatus();
  const settings = database.settings();
  return {
    visible: target.isVisible() && !target.isMinimized(),
    hardwareAccelerated: app.isHardwareAccelerationEnabled() && features.gpu_compositing === 'enabled' && features.webgl?.startsWith('enabled'),
    settings: { theme: settings.theme, glassEffects: settings.glassEffects, motionEffects: settings.motionEffects },
  };
}

function sendVisualState(target: BrowserWindow | null): void {
  if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) target.webContents.send('visual:state', visualState(target));
}

function observeVisualState(target: BrowserWindow): void {
  // Audio stays unthrottled; only the renderer's visual frame clock is suspended.
  const update = () => sendVisualState(target);
  target.on('show', update); target.on('hide', update);
  target.on('minimize', update); target.on('restore', update);
  target.webContents.on('did-finish-load', () => sendVisualState(target));
}

function updateTray(): void {
  if (!tray) return;
  tray.setToolTip(summary.hasTrack ? `${summary.title} · ${summary.artist}`.slice(0, 120) : '声迹');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开声迹', click: showMain },
    { label: summary.playing ? '暂停' : '播放', enabled: summary.hasTrack, click: () => sendCommand('toggle') },
    { label: '上一首', enabled: summary.hasTrack, click: () => sendCommand('previous') },
    { label: '下一首', enabled: summary.hasTrack, click: () => sendCommand('next') },
    { type: 'separator' },
    { label: '迷你播放器', click: () => { void showMini(); } },
    { label: '退出', click: () => app.quit() },
  ]));
}

function updateMediaKeys(settings: Settings): void {
  for (const key of ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack']) globalShortcut.unregister(key);
  if (TEST || !settings.mediaKeys) return;
  globalShortcut.register('MediaPlayPause', () => sendCommand('toggle'));
  globalShortcut.register('MediaNextTrack', () => sendCommand('next'));
  globalShortcut.register('MediaPreviousTrack', () => sendCommand('previous'));
}

async function load(target: BrowserWindow, small = false): Promise<void> {
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  target.webContents.on('will-navigate', (event) => event.preventDefault());
  target.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  if (DEV_URL) await target.loadURL(`${DEV_URL}${small ? '?mini=1' : ''}`);
  else await target.loadFile(path.join(ROOT, 'dist', 'index.html'), small ? { query: { mini: '1' } } : undefined);
}

async function createWindow(): Promise<void> {
  const dimensions = database.getValue<{ width: number; height: number }>('windowSize', { width: 1280, height: 800 });
  window = new BrowserWindow({
    width: Math.max(900, Math.min(1920, dimensions.width)), height: Math.max(620, Math.min(1200, dimensions.height)), minWidth: 900, minHeight: 620,
    ...(TEST ? { x: -12000, y: -12000, skipTaskbar: true } : {}), show: false, frame: false, title: '声迹', backgroundColor: '#f9fafb',
    icon: path.join(ROOT, 'dist', 'app-icon.png'),
    webPreferences: { preload: path.join(ROOT, 'dist-electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, webSecurity: true },
  });
  window.once('ready-to-show', () => { if (TEST) window?.showInactive(); else window?.show(); });
  observeVisualState(window);
  window.on('close', (event) => {
    if (!quitting && database.settings().closeToTray && !TEST) { event.preventDefault(); window?.hide(); return; }
    if (window && !TEST) { const [width, height] = window.getSize(); database.setValue('windowSize', { width, height }); }
    if (!quitting) app.quit();
  });
  window.on('closed', () => { window = null; });
  await load(window);
}

async function showMini(): Promise<void> {
  if (!mini) {
    mini = new BrowserWindow({ width: 420, height: 164, minWidth: 380, minHeight: 164, maxHeight: 164, frame: false, alwaysOnTop: true, resizable: true,
      ...(TEST ? { x: -13000, y: -13000, skipTaskbar: true } : {}), show: false, backgroundColor: '#ffffff',
      webPreferences: { preload: path.join(ROOT, 'dist-electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    mini.on('closed', () => { mini = null; });
    observeVisualState(mini);
    await load(mini, true);
  }
  if (TEST) mini.showInactive(); else mini.show();
  window?.hide();
  mini.webContents.send('player:mini-state', lastMini);
}

async function downloadTrack(id: string): Promise<DownloadRecord | null> {
  const track = getTrack(id);
  if (!track.downloadable || !track.downloadUrl || !isOpenLicense(track.licenseUrl) || !['archive', 'jamendo'].includes(track.source)) throw new Error('此音源未提供可验证的下载授权');
  const url = validateMediaUrl(track.downloadUrl, track.source);
  const filename = `${track.artist} - ${track.title}`.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 140);
  const extension = track.format === 'OGG' ? '.ogg' : '.mp3';
  const choice = await dialog.showSaveDialog(window!, { defaultPath: path.join(database.settings().downloadDir, filename + extension), filters: [{ name: 'Audio', extensions: [extension.slice(1)] }] });
  if (choice.canceled || !choice.filePath) return null;
  const temp = `${choice.filePath}.part-${randomUUID()}`;
  await mkdir(path.dirname(choice.filePath), { recursive: true });
  try {
    const response = await fetchMedia(url, track.source, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw new Error('下载失败');
    const total = Number(response.headers.get('content-length') ?? 0);
    if (total > 500_000_000) throw new Error('音频文件过大');
    const file = await open(temp, 'wx');
    let received = 0, notified = 0;
    try {
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        if (received > 500_000_000) throw new Error('音频文件过大');
        await file.write(chunk);
        if (Date.now() - notified > 200) { window?.webContents.send('download:progress', { id, received, total }); notified = Date.now(); }
      }
    } finally { await file.close(); }
    if (total && total !== received) throw new Error('下载文件不完整');
    const metadata = await parseFile(temp, { duration: true });
    if (!metadata.format.duration) throw new Error('下载内容不是可识别的音频');
    await rename(temp, choice.filePath);
    const record: DownloadRecord = { id: randomUUID(), trackId: track.id, title: track.title, artist: track.artist, path: choice.filePath, date: Date.now(), licenseUrl: track.licenseUrl };
    database.addDownload(record);
    return record;
  } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}

function registerIPC(): void {
  ipcMain.handle('visual:state', (event) => {
    if (!trusted(event)) throw new Error('拒绝来自不受信任页面的请求');
    return visualState(event.sender === mini?.webContents ? mini! : window!);
  });
  handle('library:bootstrap', () => ({ ...database.snapshot(), sources: sources.descriptors() }));
  handle('catalog:search', async (input: SearchRequest) => {
    const request = z.object({ query: z.string().trim().min(1).max(150), kind: z.enum(['song', 'artist', 'album']), sources: z.array(sourceSchema).max(4).optional() }).parse(input);
    database.rememberSearch(request.query);
    const result = await sources.search(request); registerTracks(result.tracks); return result;
  });
  handle('catalog:discover', async () => {
    const active = database.settings().enabledSources.filter((id) => id === 'netease' || id === 'itunes');
    const results = await Promise.all(active.map((id) => sources.search({ query: id === 'netease' ? 'Florian Bur' : 'Laufey', kind: 'song', sources: [id] })));
    const result = { tracks: results.flatMap((entry) => entry.tracks), statuses: results.flatMap((entry) => entry.statuses) };
    registerTracks(result.tracks); return result;
  });
  handle('catalog:clear-history', () => database.setValue('searchHistory', []));
  handle('library:import-files', async () => {
    const selected = await dialog.showOpenDialog(window!, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'opus', 'webm'] }] });
    return library.import(selected.canceled ? [] : selected.filePaths);
  });
  handle('library:import-folder', async () => {
    const selected = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
    return library.import(selected.canceled ? [] : selected.filePaths);
  });
  handle('library:import-paths', (paths: string[]) => library.import(z.array(z.string().min(1).max(2000)).max(1000).parse(paths)));
  handle('library:rescan', () => library.import(database.snapshot().folders.map((folder) => folder.path)));
  handle('library:remove-folder', (folder: string) => database.removeFolder(z.string().min(1).max(2000).parse(folder)));
  handle('library:remove', (id: string) => { const track = getTrack(id); if (track.source !== 'local') throw new Error('非本地曲目'); database.removeLocal(id); catalog.delete(id); });
  handle('player:resolve', async (id: string) => {
    const track = getTrack(id);
    if (track.source === 'local') {
      const file = track.filePath && await stat(track.filePath).catch(() => null);
      if (!file || !file.isFile()) throw new Error('本地音频已被移动或删除');
      return { track, url: `shengji-media://track/${encodeURIComponent(track.id)}` };
    }
    const resolved = await sources.resolve(track); registerTracks([resolved.track]);
    return { track: resolved.track, url: remoteMedia.authorize(resolved.url, resolved.track.source) };
  });
  handle('player:lyrics', (id: string, online = false, refresh = false) => lyrics.get(getTrack(id), z.boolean().parse(online), z.boolean().parse(refresh)));
  handle('player:effects', (input: AudioEffectsSettings) => {
    const settings = audioEffectsSchema.parse(input);
    database.setValue('audioEffects', settings);
    return settings;
  });
  handle('library:favorite', (id: string, value: boolean) => database.favorite(getTrack(id), z.boolean().parse(value)));
  handle('library:played', (id: string) => database.recordPlay(getTrack(id)));
  handle('playlist:create', (name: string) => database.createPlaylist(nameSchema.parse(name)));
  handle('playlist:rename', (id: string, name: string) => database.renamePlaylist(idSchema.parse(id), nameSchema.parse(name)));
  handle('playlist:delete', (id: string) => database.deletePlaylist(idSchema.parse(id)));
  handle('playlist:reorder', (id: string, ids: string[]) => database.reorderPlaylist(idSchema.parse(id), z.array(idSchema).max(10000).parse(ids)));
  handle('playlist:add', (id: string, ids: string[]) => database.addToPlaylist(idSchema.parse(id), z.array(idSchema).max(1000).parse(ids).map(getTrack)));
  handle('playlist:remove', (id: string, trackId: string) => database.removeFromPlaylist(idSchema.parse(id), idSchema.parse(trackId)));
  handle('player:save', (input: PlaybackState) => {
    const state = playbackSchema.parse(input);
    const tracks = state.queue.map(getTrack);
    if (state.currentId ? state.queue[state.index] !== state.currentId : state.index !== -1) throw new Error('播放位置不在队列中');
    for (const track of tracks) database.putTrack(track);
    database.setValue('playback', state);
  });
  handle('settings:save', (input: Settings) => {
    const settings = settingsSchema.parse(input);
    if (!path.isAbsolute(settings.downloadDir)) throw new Error('下载目录必须是完整路径');
    settings.enabledSources = settings.enabledSources.filter((id) => id !== 'jamendo' || Boolean(getJamendoKey()));
    database.setValue('settings', settings); updateMediaKeys(settings);
    sendVisualState(window); sendVisualState(mini); return settings;
  });
  handle('settings:jamendo-key', (key: string) => {
    const value = z.string().trim().max(100).regex(/^[a-zA-Z0-9]*$/).parse(key);
    if (value && !safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用');
    database.setValue('jamendoCredential', value ? safeStorage.encryptString(value).toString('base64') : null);
  });
  handle('download:start', downloadTrack);
  handle('download:directory', async () => { const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
  handle('shell:external', async (id: string) => {
    const track = getTrack(id); const url = track.externalUrl;
    if (!url) throw new Error('没有原平台链接');
    const parsed = new URL(url);
    const domains = ['music.163.com', 'music.apple.com', 'itunes.apple.com', 'archive.org', 'www.jamendo.com', 'jamendo.com'];
    if (parsed.protocol !== 'https:' || !domains.includes(parsed.hostname)) throw new Error('链接不受信任');
    await shell.openExternal(parsed.href);
  });
  handle('shell:reveal-file', (id: string) => { const track = getTrack(id); if (track.source !== 'local' || !track.filePath) throw new Error('非本地文件'); shell.showItemInFolder(track.filePath); });
  handle('shell:reveal-download', (id: string) => { const record = database.snapshot().downloads.find((item) => item.id === idSchema.parse(id)); if (!record) throw new Error('下载记录不存在'); shell.showItemInFolder(record.path); });
  handle('window:action', async (value: string) => {
    const action = z.enum(['minimize', 'maximize', 'close', 'mini', 'main', 'mini-close']).parse(value);
    if (action === 'minimize') window?.minimize();
    if (action === 'maximize') window?.isMaximized() ? window.unmaximize() : window?.maximize();
    if (action === 'close') window?.close();
    if (action === 'mini') await showMini();
    if (action === 'main') { showMain(); mini?.hide(); }
    if (action === 'mini-close') { mini?.close(); showMain(); }
  });
  ipcMain.on('player:summary', (event, input: PlayerSummary) => {
    if (!trusted(event)) return;
    const result = z.object({ title: z.string().max(1000), artist: z.string().max(1000), playing: z.boolean(), hasTrack: z.boolean() }).safeParse(input);
    if (result.success && JSON.stringify(summary) !== JSON.stringify(result.data)) { summary = result.data; updateTray(); }
  });
  ipcMain.on('player:checkpoint', (event, input: PlaybackState) => {
    if (!trusted(event) || event.sender !== window?.webContents) return;
    const result = playbackSchema.safeParse(input);
    if (!result.success) return;
    const state = result.data;
    if (state.currentId ? state.queue[state.index] !== state.currentId : state.index !== -1) return;
    try { state.queue.forEach(getTrack); lastCheckpoint = state; } catch { /* Ignore stale or unauthorized track IDs. */ }
  });
  ipcMain.on('player:effects-checkpoint', (event, input: AudioEffectsSettings) => {
    if (!trusted(event) || event.sender !== window?.webContents) return;
    const result = audioEffectsSchema.safeParse(input);
    if (result.success) lastEffectsCheckpoint = result.data;
  });
  ipcMain.on('player:mini-broadcast', (event, state: MiniState) => {
    if (!trusted(event) || event.sender !== window?.webContents) return;
    lastMini = state;
    mini?.webContents.send('player:mini-state', state);
  });
  ipcMain.on('player:mini-command', (event, command: PlayerCommand) => {
    if (trusted(event) && ['toggle', 'next', 'previous', 'pause', 'play', 'refresh'].includes(command)) sendCommand(command);
  });
}

if (!TEST && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showMain);
  app.whenReady().then(async () => {
    const defaults: Settings = { theme: 'light', enabledSources: ['netease', 'itunes'], downloadDir: path.join(app.getPath('music'), '声迹下载'), closeToTray: false, mediaKeys: true, glassEffects: true, motionEffects: true };
    database = await LibraryDatabase.open(path.join(app.getPath('userData'), 'library.sqlite'), defaults, TEST);
    library = new LocalLibrary(database, path.join(app.getPath('userData'), 'artwork'), (done, total) => window?.webContents.send('import:progress', { done, total }));
    const client = new JsonClient();
    sources = new SourceRegistry(client, getJamendoKey, () => database.settings().enabledSources, () => Boolean(getJamendoKey()));
    lyrics = new LyricsService(library, database, client, () => database.settings().enabledSources);
    protocol.handle('shengji-media', (request) => new URL(request.url).hostname === 'stream' ? remoteMedia.response(request) : mediaResponse(request, database, path.join(app.getPath('userData'), 'artwork')));
    registerIPC();
    const imports = process.argv.filter((arg) => arg.startsWith('--import=')).map((arg) => arg.slice(9));
    if (imports.length) await library.import(imports);
    await createWindow();
    const image = nativeImage.createFromPath(path.join(ROOT, 'dist', 'app-icon.png'));
    if (!TEST && !image.isEmpty()) { tray = new Tray(image.resize({ width: 20, height: 20 })); tray.on('double-click', showMain); updateTray(); }
    updateMediaKeys(database.settings());
  }).catch((error) => { console.error('Shengji startup failed:', error instanceof Error ? error.message : 'unknown'); app.exit(1); });
}

app.on('before-quit', () => {
  quitting = true;
  if (database) {
    const playback = lastCheckpoint ?? database.playback();
    for (const id of playback.queue) { const track = catalog.get(id) || database.getTrack(id); if (track) database.putTrack(track); }
    const current = lastMini.current && playback.currentId === lastMini.current.id;
    database.setValue('playback', current ? { ...playback, position: lastMini.position, volume: lastMini.volume, muted: lastMini.muted } : playback, false);
    if (lastEffectsCheckpoint) database.setValue('audioEffects', lastEffectsCheckpoint, false);
    database.flush();
  }
  globalShortcut.unregisterAll();
  tray?.destroy(); tray = null;
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('gpu-info-update', () => { if (database) { sendVisualState(window); sendVisualState(mini); } });
