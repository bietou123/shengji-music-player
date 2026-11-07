import path from 'node:path';
import { createHash } from 'node:crypto';
import { stat, readdir, mkdir, writeFile, readFile } from 'node:fs/promises';
import { parseFile } from 'music-metadata';
import { Lrc } from 'lrc-kit';
import type { ImportResult, LyricLine, Track } from '../shared/types';
import type { LibraryDatabase } from './database';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.aac', '.m4a', '.ogg', '.opus', '.webm']);

export class LocalLibrary {
  private busy = false;
  constructor(private database: LibraryDatabase, private artworkDir: string, private progress: (done: number, total: number) => void) {}

  async readTrack(file: string): Promise<Track> {
    const resolved = path.resolve(file);
    if (!AUDIO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) throw new Error('不支持的音频格式');
    const info = await stat(resolved);
    if (!info.isFile() || info.size > 2_000_000_000) throw new Error('音频文件无效或过大');
    const metadata = await parseFile(resolved, { duration: true, skipCovers: false });
    if (!metadata.format.duration || !metadata.format.codec) throw new Error('无法读取音频');
    const id = `local:${createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex').slice(0, 24)}`;
    const cover = metadata.common.picture?.[0];
    let artwork: string | undefined;
    if (cover && cover.data.length < 12_000_000 && ['image/jpeg', 'image/png', 'image/webp'].includes(cover.format)) {
      await mkdir(this.artworkDir, { recursive: true });
      const ext = cover.format === 'image/png' ? '.png' : cover.format === 'image/webp' ? '.webp' : '.jpg';
      await writeFile(path.join(this.artworkDir, `${id.slice(6)}${ext}`), cover.data);
      artwork = `shengji-media://cover/${encodeURIComponent(id)}`;
    }
    const base = path.basename(resolved, path.extname(resolved));
    const fallback = base.includes(' - ') ? base.split(' - ') : [];
    const bitrate = metadata.format.bitrate ? Math.round(metadata.format.bitrate) : undefined;
    return {
      id, source: 'local', sourceId: id.slice(6), title: metadata.common.title || fallback.slice(1).join(' - ') || base,
      artist: metadata.common.artist || fallback[0] || '未知歌手', album: metadata.common.album || '本地音乐', duration: metadata.format.duration,
      artwork, filePath: resolved, format: path.extname(resolved).slice(1).toUpperCase(), bitrate, sampleRate: metadata.format.sampleRate,
      quality: metadata.format.lossless ? '无损' : bitrate ? `${Math.round(bitrate / 1000)} kbps` : metadata.format.codec,
      availability: 'full', downloadable: false, addedAt: this.database.getTrack(id)?.addedAt ?? Date.now(),
    };
  }

  private async collect(input: string, result: string[], visited: Set<string>): Promise<void> {
    const resolved = path.resolve(input);
    if (visited.has(resolved) || result.length >= 20_000) return;
    visited.add(resolved);
    const info = await stat(resolved);
    if (info.isFile()) { if (AUDIO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) result.push(resolved); return; }
    if (!info.isDirectory()) return;
    const entries = await readdir(resolved, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory() && !AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try { await this.collect(path.join(resolved, entry.name), result, visited); } catch { /* Inaccessible subfolders are skipped. */ }
    }
  }

  async import(inputs: string[]): Promise<ImportResult> {
    if (this.busy) throw new Error('另一项导入正在进行');
    this.busy = true;
    const result: ImportResult = { imported: 0, skipped: 0, errors: [] };
    try {
      const files: string[] = [];
      const visited = new Set<string>();
      for (const input of inputs) {
        try { await this.collect(input, files, visited); } catch { result.errors.push(`${path.basename(input)}：无法访问`); }
      }
      const tracks: Track[] = [];
      this.progress(0, files.length);
      for (let index = 0; index < files.length; index++) {
        try { tracks.push(await this.readTrack(files[index])); result.imported++; }
        catch { result.skipped++; if (result.errors.length < 12) result.errors.push(`${path.basename(files[index])}：无法解码`); }
        if (index % 10 === 0 || index === files.length - 1) this.progress(index + 1, files.length);
      }
      this.database.putTracks(tracks);
      for (const input of inputs) {
        try {
          if ((await stat(input)).isDirectory()) this.database.recordFolder({ path: path.resolve(input), lastScan: Date.now(), count: tracks.filter((track) => track.filePath?.startsWith(`${path.resolve(input)}${path.sep}`)).length });
        } catch { /* The selection may have been removed during the scan. */ }
      }
      return result;
    } finally { this.busy = false; }
  }

  async lyrics(track: Track): Promise<LyricLine[]> {
    if (!track.filePath) return [];
    const file = track.filePath.slice(0, -path.extname(track.filePath).length) + '.lrc';
    try {
      const info = await stat(file);
      if (info.size > 1_000_000) return [];
      return parseLyrics(await readFile(file, 'utf8'));
    } catch { return []; }
  }
}

export function parseLyrics(text: string): LyricLine[] {
  const lrc = Lrc.parse(text);
  const offset = Number(lrc.info.offset ?? 0) / 1000;
  return lrc.lyrics.map((line) => ({ timestamp: Math.max(0, line.timestamp + offset), content: line.content })).sort((a, b) => a.timestamp - b.timestamp);
}
