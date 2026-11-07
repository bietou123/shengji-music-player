import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ShengjiAPI } from '../shared/types';

const listen = <T>(channel: string, callback: (value: T) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api: ShengjiAPI = {
  bootstrap: () => ipcRenderer.invoke('library:bootstrap'),
  search: (request) => ipcRenderer.invoke('catalog:search', request),
  discover: () => ipcRenderer.invoke('catalog:discover'),
  importFiles: () => ipcRenderer.invoke('library:import-files'),
  importFolder: () => ipcRenderer.invoke('library:import-folder'),
  importPaths: (paths) => ipcRenderer.invoke('library:import-paths', paths),
  rescanFolders: () => ipcRenderer.invoke('library:rescan'),
  removeLocal: (id) => ipcRenderer.invoke('library:remove', id),
  resolveTrack: (id) => ipcRenderer.invoke('player:resolve', id),
  lyrics: (id, online = false, refresh = false) => ipcRenderer.invoke('player:lyrics', id, online, refresh),
  saveAudioEffects: (settings) => ipcRenderer.invoke('player:effects', settings),
  audioEffectsCheckpoint: (settings) => ipcRenderer.send('player:effects-checkpoint', settings),
  favorite: (id, value) => ipcRenderer.invoke('library:favorite', id, value),
  recordPlay: (id) => ipcRenderer.invoke('library:played', id),
  createPlaylist: (name) => ipcRenderer.invoke('playlist:create', name),
  renamePlaylist: (id, name) => ipcRenderer.invoke('playlist:rename', id, name),
  deletePlaylist: (id) => ipcRenderer.invoke('playlist:delete', id),
  reorderPlaylist: (id, ids) => ipcRenderer.invoke('playlist:reorder', id, ids),
  addToPlaylist: (id, ids) => ipcRenderer.invoke('playlist:add', id, ids),
  removeFromPlaylist: (id, trackId) => ipcRenderer.invoke('playlist:remove', id, trackId),
  savePlayback: (state) => ipcRenderer.invoke('player:save', state),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  setJamendoKey: (key) => ipcRenderer.invoke('settings:jamendo-key', key),
  download: (id) => ipcRenderer.invoke('download:start', id),
  chooseDownloadDir: () => ipcRenderer.invoke('download:directory'),
  clearSearchHistory: () => ipcRenderer.invoke('catalog:clear-history'),
  removeScanFolder: (path) => ipcRenderer.invoke('library:remove-folder', path),
  openExternal: (id) => ipcRenderer.invoke('shell:external', id),
  revealFile: (id) => ipcRenderer.invoke('shell:reveal-file', id),
  revealDownload: (id) => ipcRenderer.invoke('shell:reveal-download', id),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  filePath: (file) => webUtils.getPathForFile(file),
  playerSummary: (summary) => ipcRenderer.send('player:summary', summary),
  playbackCheckpoint: (state) => ipcRenderer.send('player:checkpoint', state),
  miniBroadcast: (state) => ipcRenderer.send('player:mini-broadcast', state),
  miniCommand: (command) => ipcRenderer.send('player:mini-command', command),
  onCommand: (callback) => listen('player:command', callback),
  onMiniState: (callback) => listen('player:mini-state', callback),
  onImportProgress: (callback) => listen('import:progress', callback),
  onDownloadProgress: (callback) => listen('download:progress', callback),
};
contextBridge.exposeInMainWorld('shengji', api);
