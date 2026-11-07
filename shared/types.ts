export type SourceId = 'local' | 'netease' | 'itunes' | 'archive' | 'jamendo' | 'qq' | 'spotify';
export type Availability = 'full' | 'preview' | 'subscription' | 'login' | 'external' | 'unavailable' | 'unverified';
export type SearchKind = 'song' | 'artist' | 'album';
export type PlayMode = 'order' | 'loop' | 'one' | 'shuffle';

export interface Track {
  id: string;
  source: SourceId;
  sourceId: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  artwork?: string;
  externalUrl?: string;
  availability: Availability;
  quality?: string;
  format?: string;
  bitrate?: number;
  sampleRate?: number;
  genres?: string[];
  filePath?: string;
  previewUrl?: string;
  streamUrl?: string;
  downloadUrl?: string;
  licenseUrl?: string;
  downloadable: boolean;
  addedAt?: number;
}

export interface TrackGroup { track: Track; alternatives: Track[]; }
export interface SourceStatus {
  source: SourceId;
  status: 'ok' | 'error' | 'disabled';
  count: number;
  error?: string;
  cached?: boolean;
}
export interface SearchRequest { query: string; kind: SearchKind; sources?: SourceId[]; }
export interface SearchResult { tracks: Track[]; statuses: SourceStatus[]; }
export interface SourceDescriptor {
  id: SourceId;
  name: string;
  color: string;
  implemented: boolean;
  configured: boolean;
  enabled: boolean;
  access: string;
}
export interface Playlist { id: string; name: string; createdAt: number; tracks: Track[]; }
export interface ScanFolder { path: string; lastScan: number; count: number; }
export interface Settings {
  theme: 'light' | 'dark' | 'system';
  enabledSources: SourceId[];
  downloadDir: string;
  closeToTray: boolean;
  mediaKeys: boolean;
  glassEffects: boolean;
  motionEffects: boolean;
}
export interface VisualState {
  visible: boolean;
  hardwareAccelerated: boolean;
  settings: Pick<Settings, 'theme' | 'glassEffects' | 'motionEffects'>;
}
export interface PlaybackState {
  queue: string[];
  currentId: string | null;
  index: number;
  position: number;
  volume: number;
  muted: boolean;
  mode: PlayMode;
}
export interface DownloadRecord {
  id: string; trackId: string; title: string; artist: string; path: string; date: number; licenseUrl?: string;
}
export interface LibrarySnapshot {
  localTracks: Track[];
  favorites: Track[];
  recent: Track[];
  playlists: Playlist[];
  folders: ScanFolder[];
  downloads: DownloadRecord[];
  settings: Settings;
  playback: PlaybackState;
  queueTracks: Track[];
  searchHistory: string[];
  audioEffects: AudioEffectsSettings;
  sources: SourceDescriptor[];
}
export interface ImportResult { imported: number; skipped: number; errors: string[]; }
export interface ResolvedTrack { track: Track; url: string; }
export interface LyricLine { timestamp: number; content: string; translation?: string; }
export interface LyricsResult {
  lines: LyricLine[];
  status: 'available' | 'instrumental' | 'missing' | 'unsupported' | 'unmatched';
  source: 'local' | 'netease' | 'lrclib' | null;
  synchronized: boolean;
  matchedTitle?: string;
}
export type AudioPreset = 'auto' | 'flat' | 'piano' | 'vocal' | 'bass' | 'warm' | 'bright' | 'night' | 'custom';
export interface AudioEffectsSettings {
  enabled: boolean;
  preset: AudioPreset;
  bands: number[];
  width: number;
  compressor: boolean;
  visualizer: boolean;
}
export type PlayerCommand = 'toggle' | 'next' | 'previous' | 'pause' | 'play' | 'refresh';
export interface PlayerSummary { title: string; artist: string; playing: boolean; hasTrack: boolean; }
export interface MiniState { current: Track | null; status: string; position: number; duration: number; volume: number; muted: boolean; }

export interface ShengjiAPI {
  bootstrap(): Promise<LibrarySnapshot>;
  search(request: SearchRequest): Promise<SearchResult>;
  discover(): Promise<SearchResult>;
  importFiles(): Promise<ImportResult>;
  importFolder(): Promise<ImportResult>;
  importPaths(paths: string[]): Promise<ImportResult>;
  rescanFolders(): Promise<ImportResult>;
  removeLocal(id: string): Promise<void>;
  resolveTrack(id: string): Promise<ResolvedTrack>;
  lyrics(id: string, online?: boolean, refresh?: boolean): Promise<LyricsResult>;
  saveAudioEffects(settings: AudioEffectsSettings): Promise<AudioEffectsSettings>;
  audioEffectsCheckpoint(settings: AudioEffectsSettings): void;
  favorite(id: string, enabled: boolean): Promise<void>;
  recordPlay(id: string): Promise<void>;
  createPlaylist(name: string): Promise<string>;
  renamePlaylist(id: string, name: string): Promise<void>;
  deletePlaylist(id: string): Promise<void>;
  reorderPlaylist(id: string, trackIds: string[]): Promise<void>;
  addToPlaylist(id: string, trackIds: string[]): Promise<void>;
  removeFromPlaylist(id: string, trackId: string): Promise<void>;
  savePlayback(state: PlaybackState): Promise<void>;
  saveSettings(settings: Settings): Promise<Settings>;
  setJamendoKey(key: string): Promise<void>;
  download(id: string): Promise<DownloadRecord | null>;
  chooseDownloadDir(): Promise<string | null>;
  clearSearchHistory(): Promise<void>;
  removeScanFolder(path: string): Promise<void>;
  openExternal(id: string): Promise<void>;
  revealFile(id: string): Promise<void>;
  revealDownload(id: string): Promise<void>;
  windowAction(action: 'minimize' | 'maximize' | 'close' | 'mini' | 'main' | 'mini-close'): Promise<void>;
  visualState(): Promise<VisualState>;
  onVisualState(callback: (state: VisualState) => void): () => void;
  filePath(file: File): string;
  playerSummary(summary: PlayerSummary): void;
  playbackCheckpoint(state: PlaybackState): void;
  miniBroadcast(state: MiniState): void;
  miniCommand(command: PlayerCommand): void;
  onCommand(callback: (command: PlayerCommand) => void): () => void;
  onMiniState(callback: (state: MiniState) => void): () => void;
  onImportProgress(callback: (progress: { done: number; total: number }) => void): () => void;
  onDownloadProgress(callback: (progress: { id: string; received: number; total: number }) => void): () => void;
}
