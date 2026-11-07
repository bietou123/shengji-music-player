import type { SearchKind, SearchRequest, SearchResult, SourceDescriptor, SourceId, Track, ResolvedTrack } from '../shared/types';
import { JsonClient, httpsUrl, networkError, validateMediaUrl } from './network';

export interface SourceAdapter {
  id: SourceId;
  search(query: string, kind: SearchKind): Promise<Track[]>;
  resolve(track: Track): Promise<ResolvedTrack>;
}

interface NeteaseSong {
  id: number; name: string; fee?: number; duration?: number; status?: number;
  artists?: { name: string }[];
  album?: { name: string; picUrl?: string };
  dt?: number; ar?: { name: string }[]; al?: { name: string; picUrl?: string };
}
interface NeteaseMedia {
  id: number; url: string | null; br: number; type: string; code: number; fee?: number;
  freeTrialInfo: null | { start: number; end: number }; sr?: number; time?: number;
}
function requireNetease(data: { code?: number }): void {
  if (data?.code !== 200) throw new Error('原平台暂不可用或拒绝了请求');
}

export class NeteaseAdapter implements SourceAdapter {
  id = 'netease' as const;
  constructor(private client: JsonClient) {}

  async search(query: string, kind: SearchKind): Promise<Track[]> {
    const params = new URLSearchParams({ s: query, type: kind === 'artist' ? '100' : kind === 'album' ? '10' : '1', limit: kind === 'song' ? '40' : '6', offset: '0' });
    const result = await this.client.get<{ code: number; result?: { songs?: NeteaseSong[]; artists?: { id: number }[]; albums?: { id: number }[] } }>(`https://music.163.com/api/search/get?${params}`, 180_000, requireNetease);
    let songs = result.result?.songs ?? [];
    if (kind === 'artist' || kind === 'album') {
      const items = (kind === 'artist' ? result.result?.artists : result.result?.albums) ?? [];
      const details = await Promise.allSettled(items.slice(0, kind === 'artist' ? 2 : 3).map(async (item) => {
        const data = await this.client.get<{ code: number; hotSongs?: NeteaseSong[]; songs?: NeteaseSong[]; album?: { songs?: NeteaseSong[] } }>(`https://music.163.com/api/${kind}/${item.id}`, 180_000, requireNetease);
        return kind === 'artist' ? data.hotSongs ?? [] : data.album?.songs ?? data.songs ?? [];
      }));
      if (details.length && details.every((item) => item.status === 'rejected')) throw new Error('曲目列表暂不可用，请稍后重试');
      songs = details.flatMap((item) => item.status === 'fulfilled' ? item.value : []);
    }
    songs = Array.from(new Map(songs.filter((song) => Number.isSafeInteger(song.id) && song.id > 0 && song.name).map((song) => [song.id, song])).values()).slice(0, 40);
    if (!songs.length) return [];
    let tracks: Track[] = songs.map((song) => ({
      id: `netease:${song.id}`, source: this.id, sourceId: String(song.id), title: song.name,
      artist: (song.artists ?? song.ar ?? []).map((artist) => artist.name).join(' / ') || '未知歌手', album: (song.album ?? song.al)?.name || '',
      duration: Math.max(0, (song.duration ?? song.dt ?? 0) / 1000), artwork: httpsUrl((song.album ?? song.al)?.picUrl), externalUrl: `https://music.163.com/#/song?id=${song.id}`,
      availability: song.status && song.status < 0 ? 'unavailable' : song.fee === 1 || song.fee === 4 ? 'subscription' : 'unverified',
      quality: song.fee === 1 || song.fee === 4 ? '未提供音频' : '待验证', downloadable: false,
    }));
    const [images, media] = await Promise.all([
      this.artwork(songs.filter((song) => !(song.album ?? song.al)?.picUrl).map((song) => song.id)),
      this.playerData(tracks.filter((track) => track.availability === 'unverified').map((track) => track.sourceId), 60_000).catch(() => []),
    ]);
    const byId = new Map(media.map((item) => [String(item.id), item]));
    tracks = tracks.map((track) => {
      const hydrated = { ...track, artwork: track.artwork || httpsUrl(images.get(Number(track.sourceId))) };
      const audio = byId.get(track.sourceId);
      return audio ? this.withMedia(hydrated, audio) : hydrated;
    });
    return tracks;
  }

  private async artwork(ids: number[]): Promise<Map<number, string | undefined>> {
    if (!ids.length) return new Map();
    try {
      const detail = await this.client.get<{ code: number; songs?: NeteaseSong[] }>(`https://music.163.com/api/song/detail/?ids=${encodeURIComponent(JSON.stringify(ids))}`, 180_000, requireNetease);
      return new Map((detail.songs ?? []).map((song) => [song.id, (song.album ?? song.al)?.picUrl]));
    } catch { return new Map(); }
  }

  private async playerData(ids: string[], ttl: number): Promise<NeteaseMedia[]> {
    if (!ids.length) return [];
    const params = new URLSearchParams({ ids: JSON.stringify(ids.map(Number)), br: '320000' });
    const result = await this.client.get<{ code: number; data?: NeteaseMedia[] }>(`https://music.163.com/api/song/enhance/player/url?${params}`, ttl, requireNetease);
    return result.data ?? [];
  }

  private withMedia(track: Track, media: NeteaseMedia): Track {
    if (media.fee === 1 || media.fee === 4) return { ...track, availability: 'subscription', quality: '未提供音频' };
    if (!media.url || media.code !== 200) return { ...track, availability: media.code === 401 ? 'login' : 'external', quality: '未提供音频' };
    try { validateMediaUrl(media.url, this.id); } catch { return { ...track, availability: 'unavailable', quality: '无效音源' }; }
    const bitrate = Number.isFinite(media.br) && media.br > 0 ? media.br : undefined;
    return { ...track, availability: media.freeTrialInfo ? 'preview' : 'full', format: media.type?.toUpperCase(), bitrate, sampleRate: media.sr,
      quality: bitrate ? `${Math.round(bitrate / 1000)} kbps` : '码率未提供', downloadable: false };
  }

  async resolve(track: Track): Promise<ResolvedTrack> {
    if (track.availability === 'subscription' || track.availability === 'login') throw new Error('此曲目需要原平台账号权限');
    const media = (await this.playerData([track.sourceId], 0)).find((item) => String(item.id) === track.sourceId);
    if (!media?.url || media.code !== 200) throw new Error('原平台未提供可播放音频');
    const resolved = this.withMedia(track, media);
    if (resolved.availability !== 'full' && resolved.availability !== 'preview') throw new Error('原平台未提供公开可播放音频');
    return { url: validateMediaUrl(media.url, this.id), track: resolved };
  }
}

interface AppleSong {
  kind?: string; trackId: number; trackName: string; artistName: string; collectionName?: string;
  trackTimeMillis?: number; artworkUrl100?: string; trackViewUrl?: string; previewUrl?: string;
}
function requireApple(data: { results?: unknown[] }): void {
  if (!Array.isArray(data?.results)) throw new Error('Apple Music 目录暂不可用');
}

export class AppleAdapter implements SourceAdapter {
  id = 'itunes' as const;
  constructor(private client: JsonClient) {}

  async search(query: string, kind: SearchKind): Promise<Track[]> {
    const params = new URLSearchParams({ term: query, entity: 'song', media: 'music', limit: '40', country: 'us' });
    if (kind !== 'song') params.set('attribute', kind === 'artist' ? 'artistTerm' : 'albumTerm');
    const result = await this.client.get<{ results: AppleSong[] }>(`https://itunes.apple.com/search?${params}`, 180_000, requireApple);
    return (result.results ?? []).filter((song) => song.kind === 'song' && song.trackId && song.trackName).map((song) => ({
      id: `itunes:${song.trackId}`, source: this.id, sourceId: String(song.trackId), title: song.trackName, artist: song.artistName,
      album: song.collectionName ?? '', duration: (song.trackTimeMillis ?? 0) / 1000,
      artwork: httpsUrl(song.artworkUrl100?.replace('/100x100bb.', '/600x600bb.')), externalUrl: httpsUrl(song.trackViewUrl),
      previewUrl: httpsUrl(song.previewUrl), availability: httpsUrl(song.previewUrl) ? 'preview' : 'external', quality: 'AAC · 码率未提供', format: 'AAC', downloadable: false,
    }));
  }

  async resolve(track: Track): Promise<ResolvedTrack> {
    let preview = track.previewUrl;
    if (!preview) {
      const result = await this.client.get<{ results: AppleSong[] }>(`https://itunes.apple.com/lookup?id=${encodeURIComponent(track.sourceId)}&country=us`, 0, requireApple);
      preview = result.results?.[0]?.previewUrl;
    }
    if (!preview) throw new Error('此曲目仅可在原平台打开');
    return { track: { ...track, availability: 'preview', downloadable: false }, url: validateMediaUrl(preview, this.id) };
  }
}

export function isOpenLicense(value?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port &&
      (url.hostname === 'creativecommons.org' || url.hostname === 'www.creativecommons.org') &&
      /^\/(?:licenses\/(?:by|by-sa|by-nd|by-nc|by-nc-sa|by-nc-nd)\/(?:1\.0|2\.0|2\.5|3\.0|4\.0)|publicdomain\/(?:zero|mark)\/1\.0)(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

interface ArchiveMetadata {
  metadata?: { title?: string; creator?: string | string[]; licenseurl?: string | string[] };
  files?: { name: string; format?: string; title?: string; artist?: string; length?: string; size?: string }[];
}

export class ArchiveAdapter implements SourceAdapter {
  id = 'archive' as const;
  constructor(private client: JsonClient) {}

  async search(query: string, kind: SearchKind): Promise<Track[]> {
    const clean = query.replace(/["\\]/g, ' ').trim();
    const field = kind === 'artist' ? 'creator' : kind === 'album' ? 'title' : '(title';
    const match = kind === 'song' ? `(title:"${clean}" OR creator:"${clean}")` : `${field}:"${clean}"`;
    const params = new URLSearchParams({ q: `mediatype:audio AND licenseurl:* AND ${match}`, rows: '6', output: 'json' });
    params.append('fl[]', 'identifier');
    const result = await this.client.get<{ response?: { docs?: { identifier: string }[] } }>(`https://archive.org/advancedsearch.php?${params}`);
    const tracks: Track[] = [];
    for (const doc of (result.response?.docs ?? []).slice(0, 6)) {
      const metadata = await this.client.get<ArchiveMetadata>(`https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`);
      const license = Array.isArray(metadata.metadata?.licenseurl) ? metadata.metadata.licenseurl[0] : metadata.metadata?.licenseurl;
      if (!isOpenLicense(license)) continue;
      const files = (metadata.files ?? []).filter((file) => file.format === 'VBR MP3' || file.format === 'MP3' || file.format === 'Ogg Vorbis').slice(0, 8);
      for (const file of files) {
        const url = `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${file.name.split('/').map(encodeURIComponent).join('/')}`;
        const artist = file.artist || (Array.isArray(metadata.metadata?.creator) ? metadata.metadata.creator.join(' / ') : metadata.metadata?.creator) || 'Internet Archive';
        const duration = file.length?.includes(':') ? file.length.split(':').reduce((sum, value) => sum * 60 + Number(value), 0) : Number(file.length ?? 0);
        tracks.push({ id: `archive:${doc.identifier}:${file.name}`, source: this.id, sourceId: `${doc.identifier}/${file.name}`, title: file.title || file.name.replace(/\.[^.]+$/, ''), artist,
          album: metadata.metadata?.title || '', duration, artwork: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
          externalUrl: `https://archive.org/details/${encodeURIComponent(doc.identifier)}`, streamUrl: url, downloadUrl: url, licenseUrl: license,
          availability: 'full', format: file.format?.includes('MP3') ? 'MP3' : 'OGG', quality: '原始音频', downloadable: true });
      }
    }
    return tracks;
  }

  async resolve(track: Track): Promise<ResolvedTrack> {
    if (!isOpenLicense(track.licenseUrl) || !track.streamUrl) throw new Error('未找到可验证的开放授权');
    return { track, url: validateMediaUrl(track.streamUrl, this.id) };
  }
}

export class JamendoAdapter implements SourceAdapter {
  id = 'jamendo' as const;
  constructor(private client: JsonClient, private getKey: () => string | undefined) {}

  async search(query: string, kind: SearchKind): Promise<Track[]> {
    const key = this.getKey();
    if (!key) throw new Error('尚未配置 Client ID');
    const params = new URLSearchParams({ client_id: key, format: 'json', limit: '30', audioformat: 'mp32', include: 'musicinfo', [kind === 'artist' ? 'artist_name' : kind === 'album' ? 'album_name' : 'namesearch']: query });
    const result = await this.client.get<{ headers: { status: string }; results: { id: string; name: string; artist_name: string; album_name: string; duration: number; image: string; shareurl: string; audio: string; audiodownload: string; audiodownload_allowed: boolean; license_ccurl: string }[] }>(`https://api.jamendo.com/v3.0/tracks/?${params}`, 0);
    if (result.headers?.status !== 'success') throw new Error('Jamendo 授权或请求失败');
    return (result.results ?? []).map((song) => ({ id: `jamendo:${song.id}`, source: this.id, sourceId: String(song.id), title: song.name, artist: song.artist_name, album: song.album_name, duration: song.duration,
      artwork: httpsUrl(song.image), externalUrl: httpsUrl(song.shareurl), streamUrl: httpsUrl(song.audio), downloadUrl: httpsUrl(song.audiodownload), licenseUrl: song.license_ccurl,
      availability: song.audio ? 'full' : 'external', quality: 'MP3 原始音频', format: 'MP3', downloadable: song.audiodownload_allowed && isOpenLicense(song.license_ccurl) }));
  }

  async resolve(track: Track): Promise<ResolvedTrack> {
    if (!track.streamUrl) throw new Error('音源暂不可用');
    return { track, url: validateMediaUrl(track.streamUrl, this.id) };
  }
}

export class SourceRegistry {
  private adapters: Map<SourceId, SourceAdapter>;
  constructor(client: JsonClient, getJamendoKey: () => string | undefined, private enabled: () => SourceId[], private configured: () => boolean) {
    this.adapters = new Map<SourceId, SourceAdapter>([
      ['netease', new NeteaseAdapter(client)], ['itunes', new AppleAdapter(client)], ['archive', new ArchiveAdapter(client)], ['jamendo', new JamendoAdapter(client, getJamendoKey)],
    ]);
  }

  descriptors(): SourceDescriptor[] {
    return [
      { id: 'netease', name: '网易云音乐', color: '#dc5353', implemented: true, configured: true, enabled: this.enabled().includes('netease'), access: '目录 / 公开可播曲目' },
      { id: 'itunes', name: 'Apple Music', color: '#e45773', implemented: true, configured: true, enabled: this.enabled().includes('itunes'), access: '目录 / 试听' },
      { id: 'archive', name: 'Internet Archive', color: '#7865ad', implemented: true, configured: true, enabled: this.enabled().includes('archive'), access: '开放授权 / 完整播放' },
      { id: 'jamendo', name: 'Jamendo', color: '#dd8b40', implemented: true, configured: this.configured(), enabled: this.enabled().includes('jamendo'), access: '开放授权 / Client ID' },
      { id: 'qq', name: 'QQ 音乐', color: '#2d996c', implemented: false, configured: false, enabled: false, access: '未接入' },
      { id: 'spotify', name: 'Spotify', color: '#168b54', implemented: false, configured: false, enabled: false, access: '未接入' },
    ];
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    const selected = request.sources ?? this.enabled();
    const descriptors = this.descriptors();
    const results = await Promise.all(selected.map(async (source) => {
      const adapter = this.adapters.get(source);
      const descriptor = descriptors.find((item) => item.id === source);
      if (!adapter || !descriptor?.configured || !descriptor.enabled) return { tracks: [] as Track[], status: { source, status: 'disabled' as const, count: 0 } };
      try {
        const tracks = await adapter.search(request.query, request.kind);
        return { tracks, status: { source, status: 'ok' as const, count: tracks.length } };
      } catch (error) { return { tracks: [] as Track[], status: { source, status: 'error' as const, count: 0, error: networkError(error) } }; }
    }));
    return { tracks: results.flatMap((result) => result.tracks), statuses: results.map((result) => result.status) };
  }

  async resolve(track: Track): Promise<ResolvedTrack> {
    const adapter = this.adapters.get(track.source);
    if (!adapter) throw new Error('此音源尚未接入');
    const source = this.descriptors().find((item) => item.id === track.source);
    if (!source?.enabled || !source.configured) throw new Error('此音源未启用');
    return adapter.resolve(track);
  }
}
