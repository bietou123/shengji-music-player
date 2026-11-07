import type { LyricsResult, LyricLine, SourceId, Track } from '../shared/types';
import type { LibraryDatabase } from './database';
import { LocalLibrary, parseLyrics } from './library';
import { JsonClient } from './network';

interface NeteaseLyrics {
  code: number;
  lrc?: { lyric?: string };
  tlyric?: { lyric?: string };
}
interface LyricCandidate {
  id: number;
  name: string;
  artists?: { name: string }[];
  duration?: number;
}
interface LrclibTrack {
  trackName: string;
  artistName: string;
  duration: number;
  instrumental: boolean;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
}
const empty = (status: LyricsResult['status'] = 'missing'): LyricsResult => ({ lines: [], status, source: null, synchronized: false });
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const instrumentalLine = (text: string) => /^(?:纯音乐(?:[，,。!！\s]+(?:请欣赏|欣赏))?[。!！\s]*|instrumental(?: track)?[.!]?\s*|music only[.!]?\s*)$/i.test(text.trim());

export function exactLyricMatch(track: Track, title: string, artist: string, duration: number): boolean {
  if (!normalize(track.title) || !normalize(track.artist) || /^(?:未知歌手|unknown artist)$/i.test(track.artist.trim())) return false;
  return normalize(track.title) === normalize(title) && normalize(track.artist) === normalize(artist)
    && Number.isFinite(duration) && Number.isFinite(track.duration) && track.duration > 0 && duration > 0
    && Math.abs(track.duration - duration) <= Math.max(3, track.duration * 0.02);
}

export function lyricsFromLrc(text: string, source: LyricsResult['source'], translation = ''): LyricsResult {
  const lines = parseLyrics(text).slice(0, 5000);
  if (lines.some((line) => instrumentalLine(line.content)))
    return { ...empty('instrumental'), source };
  if (!lines.some((line) => line.content.trim())) return { ...empty(), source };
  const translations = parseLyrics(translation).slice(0, 5000).filter((line) => line.content.trim());
  const translated = lines.map((line) => {
    const match = translations.find((item) => Math.abs(item.timestamp - line.timestamp) < 0.05);
    return match ? { ...line, translation: match.content } : line;
  });
  return { lines: translated, source, synchronized: true, status: 'available' };
}

export class LyricsService {
  constructor(private local: LocalLibrary, private database: LibraryDatabase, private client: JsonClient, private enabled: () => SourceId[]) {}

  async get(track: Track, online = false, refresh = false): Promise<LyricsResult> {
    if (track.source === 'local') {
      const lines = await this.local.lyrics(track);
      if (lines.some((line) => line.content.trim())) {
        const instrumental = lines.some((line) => instrumentalLine(line.content));
        return { lines: instrumental ? [] : lines, status: instrumental ? 'instrumental' : 'available', source: 'local', synchronized: !instrumental };
      }
      const key = `lyric-match:${track.id}`;
      const identity = JSON.stringify([track.title, track.artist, track.duration]);
      const cached = this.database.getValue<{ identity: string; result: LyricsResult } | null>(key, null);
      if (!refresh && cached?.identity === identity) return cached.result;
      // Only the explicit online-match action may send local metadata off this computer.
      if (!online) return empty();
      const result = await this.matchLocal(track, refresh);
      this.database.setValue(key, { identity, result });
      return result;
    }
    if (track.availability === 'preview') return empty('unsupported');
    if (track.source === 'netease' && this.enabled().includes('netease')) return this.netease(track.sourceId, refresh);
    return empty('unsupported');
  }

  private async netease(id: string, refresh: boolean): Promise<LyricsResult> {
    if (!/^\d{1,15}$/.test(id)) throw new Error('歌词曲目编号无效');
    const data = await this.client.get<NeteaseLyrics>(`https://music.163.com/api/song/lyric?id=${id}&lv=-1&tv=-1`, refresh ? 0 : 3_600_000,
      (value) => { if (value?.code !== 200) throw new Error('歌词来源暂不可用'); });
    return lyricsFromLrc(data.lrc?.lyric ?? '', 'netease', data.tlyric?.lyric);
  }

  private async matchLocal(track: Track, refresh: boolean): Promise<LyricsResult> {
    let error: unknown;
    let matched: LyricsResult | undefined;
    if (this.enabled().includes('netease')) {
      try {
        const params = new URLSearchParams({ s: `${track.title} ${track.artist}`, type: '1', limit: '20', offset: '0' });
        const data = await this.client.get<{ code: number; result?: { songs?: LyricCandidate[] } }>(`https://music.163.com/api/search/get?${params}`, refresh ? 0 : 3_600_000,
          (value) => { if (value?.code !== 200) throw new Error('歌词目录暂不可用'); });
        const candidate = data.result?.songs?.find((item) => Number.isSafeInteger(item.id) && item.id > 0
          && exactLyricMatch(track, item.name, (item.artists ?? []).map((artist) => artist.name).join(' / '), (item.duration ?? 0) / 1000));
        if (candidate) {
          matched = { ...await this.netease(String(candidate.id), refresh), matchedTitle: `${candidate.name} · ${track.artist}` };
          if (matched.status === 'available' || matched.status === 'instrumental') return matched;
        }
      } catch (cause) { error = cause; }
    }
    try {
      const params = new URLSearchParams({ track_name: track.title, artist_name: track.artist, duration: String(Math.round(track.duration)) });
      const data = await this.client.get<LrclibTrack>(`https://lrclib.net/api/get?${params}`, refresh ? 0 : 3_600_000);
      if (!exactLyricMatch(track, data.trackName ?? '', data.artistName ?? '', data.duration)) return matched ?? empty('unmatched');
      let result: LyricsResult;
      if (data.instrumental) result = { ...empty('instrumental'), source: 'lrclib' };
      else if (data.syncedLyrics) result = lyricsFromLrc(data.syncedLyrics, 'lrclib');
      else {
        const lines: LyricLine[] = (data.plainLyrics ?? '').split(/\r?\n/).slice(0, 5000).map((content) => ({ timestamp: 0, content }));
        result = { lines, status: lines.some((line) => line.content.trim()) ? 'available' : 'missing', source: 'lrclib', synchronized: false };
      }
      return { ...result, matchedTitle: `${data.trackName} · ${data.artistName}` };
    } catch (cause) {
      if (!(cause instanceof Error && cause.message === 'HTTP 404')) error ??= cause;
    }
    if (matched) return matched;
    if (error) throw error;
    return empty('unmatched');
  }
}
