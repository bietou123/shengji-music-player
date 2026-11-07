import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DownloadRecord, LibrarySnapshot, PlaybackState, Playlist, ScanFolder, Settings, Track } from '../shared/types';

const require = createRequire(import.meta.url);
let sqlite: Promise<SqlJsStatic> | undefined;
export const defaultPlayback = (muted = false): PlaybackState => ({ queue: [], currentId: null, index: -1, position: 0, volume: 0.65, muted, mode: 'order' });

export class LibraryDatabase {
  private constructor(private db: Database, private file: string, private defaults: Settings, private test: boolean) {}

  static async open(file: string, defaults: Settings, test = false): Promise<LibraryDatabase> {
    sqlite ??= initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
    const SQL = await sqlite;
    mkdirSync(path.dirname(file), { recursive: true });
    const db = new SQL.Database(existsSync(file) ? readFileSync(file) : undefined);
    db.run(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tracks (id TEXT PRIMARY KEY, data TEXT NOT NULL, source TEXT NOT NULL, added INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS favorites (track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE, added INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recent (track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE, played INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS playlist_tracks (playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE, track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE, position INTEGER NOT NULL, PRIMARY KEY(playlist_id,track_id));
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY, scanned INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS downloads (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version=1;`);
    const instance = new LibraryDatabase(db, file, defaults, test);
    instance.flush();
    return instance;
  }

  private rows(sql: string, params: (string | number)[] = []): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const result: Record<string, unknown>[] = [];
      while (stmt.step()) result.push(stmt.getAsObject());
      return result;
    } finally { stmt.free(); }
  }

  flush(): void {
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, this.db.export());
    renameSync(temp, this.file);
  }

  getValue<T>(key: string, fallback: T): T {
    const row = this.rows('SELECT value FROM kv WHERE key=?', [key])[0];
    if (!row) return fallback;
    try { return JSON.parse(String(row.value)) as T; } catch { return fallback; }
  }

  setValue(key: string, value: unknown, persist = true): void {
    this.db.run('INSERT OR REPLACE INTO kv VALUES (?,?)', [key, JSON.stringify(value)]);
    if (persist) this.flush();
  }

  putTrack(track: Track, persist = false): void {
    const data = { ...track };
    if (data.source === 'netease') { delete data.streamUrl; delete data.downloadUrl; }
    this.db.run('INSERT INTO tracks VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', [track.id, JSON.stringify(data), track.source, track.addedAt ?? Date.now()]);
    if (persist) this.flush();
  }

  putTracks(tracks: Track[]): void {
    this.db.run('BEGIN');
    try { for (const track of tracks) this.putTrack(track); this.db.run('COMMIT'); }
    catch (error) { this.db.run('ROLLBACK'); throw error; }
    this.flush();
  }

  getTrack(id: string): Track | undefined {
    const row = this.rows('SELECT data FROM tracks WHERE id=?', [id])[0];
    return row ? JSON.parse(String(row.data)) as Track : undefined;
  }

  private tracks(sql: string, params: (string | number)[] = []): Track[] {
    return this.rows(sql, params).map((row) => JSON.parse(String(row.data)) as Track);
  }

  favorite(track: Track, enabled: boolean): void {
    this.putTrack(track);
    if (enabled) this.db.run('INSERT OR REPLACE INTO favorites VALUES (?,?)', [track.id, Date.now()]);
    else this.db.run('DELETE FROM favorites WHERE track_id=?', [track.id]);
    this.flush();
  }

  recordPlay(track: Track): void {
    this.putTrack(track);
    this.db.run('INSERT OR REPLACE INTO recent VALUES (?,?)', [track.id, Date.now()]);
    this.db.run('DELETE FROM recent WHERE track_id NOT IN (SELECT track_id FROM recent ORDER BY played DESC LIMIT 100)');
    this.flush();
  }

  createPlaylist(name: string): string {
    const id = randomUUID();
    this.db.run('INSERT INTO playlists VALUES (?,?,?)', [id, name, Date.now()]);
    this.flush();
    return id;
  }

  renamePlaylist(id: string, name: string): void {
    this.db.run('UPDATE playlists SET name=? WHERE id=?', [name, id]); this.flush();
  }

  deletePlaylist(id: string): void {
    this.db.run('DELETE FROM playlists WHERE id=?', [id]); this.flush();
  }

  addToPlaylist(id: string, tracks: Track[]): void {
    if (!this.rows('SELECT id FROM playlists WHERE id=?', [id]).length) throw new Error('歌单不存在');
    this.db.run('BEGIN');
    try {
      let position = Number(this.rows('SELECT COALESCE(MAX(position),-1) AS p FROM playlist_tracks WHERE playlist_id=?', [id])[0].p) + 1;
      for (const track of tracks) {
        this.putTrack(track);
        this.db.run('INSERT OR IGNORE INTO playlist_tracks VALUES (?,?,?)', [id, track.id, position++]);
      }
      this.db.run('COMMIT');
    } catch (error) { this.db.run('ROLLBACK'); throw error; }
    this.flush();
  }

  removeFromPlaylist(id: string, trackId: string): void {
    this.db.run('DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?', [id, trackId]); this.flush();
  }

  reorderPlaylist(id: string, trackIds: string[]): void {
    if (!this.rows('SELECT id FROM playlists WHERE id=?', [id]).length) throw new Error('歌单不存在');
    const existing = this.rows('SELECT track_id FROM playlist_tracks WHERE playlist_id=?', [id]).map((row) => String(row.track_id));
    if (trackIds.length !== existing.length || new Set(trackIds).size !== existing.length || !trackIds.every((trackId) => existing.includes(trackId))) throw new Error('歌单曲目已变化，请刷新后重试');
    this.db.run('BEGIN');
    try {
      trackIds.forEach((trackId, position) => this.db.run('UPDATE playlist_tracks SET position=? WHERE playlist_id=? AND track_id=?', [position, id, trackId]));
      this.db.run('COMMIT');
    } catch (error) { this.db.run('ROLLBACK'); throw error; }
    this.flush();
  }

  removeLocal(id: string): void {
    this.db.run("DELETE FROM tracks WHERE id=? AND source='local'", [id]);
    const state = this.playback();
    const queue = state.queue.filter((entry) => entry !== id);
    this.setValue('playback', { ...state, queue, currentId: state.currentId === id ? null : state.currentId, index: state.currentId === id ? -1 : queue.indexOf(state.currentId ?? '') }, false);
    this.flush();
  }

  recordFolder(folder: ScanFolder): void {
    this.db.run('INSERT OR REPLACE INTO folders VALUES (?,?,?)', [folder.path, folder.lastScan, folder.count]); this.flush();
  }

  removeFolder(folder: string): void { this.db.run('DELETE FROM folders WHERE path=?', [folder]); this.flush(); }

  settings(): Settings { return { ...this.defaults, ...this.getValue<Partial<Settings>>('settings', {}) }; }
  playback(): PlaybackState { return { ...defaultPlayback(this.test), ...this.getValue<Partial<PlaybackState>>('playback', {}) }; }

  rememberSearch(query: string): void {
    const history = this.getValue<string[]>('searchHistory', []);
    this.setValue('searchHistory', [query, ...history.filter((entry) => entry !== query)].slice(0, 12));
  }

  addDownload(record: DownloadRecord): void {
    this.db.run('INSERT INTO downloads VALUES (?,?)', [record.id, JSON.stringify(record)]); this.flush();
  }

  snapshot(): Omit<LibrarySnapshot, 'sources'> {
    const playlists: Playlist[] = this.rows('SELECT * FROM playlists ORDER BY created').map((row) => ({
      id: String(row.id), name: String(row.name), createdAt: Number(row.created),
      tracks: this.tracks('SELECT t.data FROM tracks t JOIN playlist_tracks p ON t.id=p.track_id WHERE p.playlist_id=? ORDER BY p.position', [String(row.id)]),
    }));
    const playback = this.playback();
    return {
      localTracks: this.tracks("SELECT data FROM tracks WHERE source='local' ORDER BY added DESC"),
      favorites: this.tracks('SELECT t.data FROM tracks t JOIN favorites f ON t.id=f.track_id ORDER BY f.added DESC'),
      recent: this.tracks('SELECT t.data FROM tracks t JOIN recent r ON t.id=r.track_id ORDER BY r.played DESC'),
      playlists,
      folders: this.rows('SELECT * FROM folders ORDER BY scanned DESC').map((row) => ({ path: String(row.path), lastScan: Number(row.scanned), count: Number(row.count) })),
      downloads: this.rows('SELECT data FROM downloads').map((row) => JSON.parse(String(row.data)) as DownloadRecord).sort((a, b) => b.date - a.date),
      settings: this.settings(), playback,
      queueTracks: playback.queue.map((id) => this.getTrack(id)).filter((track): track is Track => Boolean(track)),
      searchHistory: this.getValue<string[]>('searchHistory', []),
    };
  }

  close(): void { this.flush(); this.db.close(); }
}
