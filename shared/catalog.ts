import type { Availability, SourceId, Track, TrackGroup } from './types';

export const SOURCE_NAMES: Record<SourceId, string> = {
  local: '本地音乐', netease: '网易云音乐', itunes: 'Apple Music', archive: 'Internet Archive', jamendo: 'Jamendo', qq: 'QQ 音乐', spotify: 'Spotify',
};
export const AVAILABILITY_NAMES: Record<Availability, string> = {
  full: '完整播放', preview: '试听', subscription: '需会员', login: '需登录', external: '打开原平台', unavailable: '暂不可用', unverified: '待验证',
};
const rank: Record<Availability, number> = { full: 0, preview: 1, unverified: 2, login: 3, subscription: 4, external: 5, unavailable: 6 };
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}]+/gu, '');
const albumVersion = (value: string) => (value.toLowerCase().match(/\blive\b|\binstrumental\b|\bacoustic\b|\bunplugged\b|\bremaster(?:ed)?\b|\bremix\b|现场|演唱会|纯音乐|伴奏|重制|混音/g) ?? []).sort().join('|');

export function groupTracks(tracks: Track[]): TrackGroup[] {
  const groups = new Map<string, Track[][]>();
  for (const track of tracks) {
    // Version text stays in the key, so live, instrumental and remastered recordings remain separate.
    const key = `${normalize(track.title)}|${normalize(track.artist)}|${albumVersion(track.album)}`;
    const clusters = groups.get(key) ?? [];
    if (clusters.some((list) => list.some((item) => item.id === track.id))) continue;
    const list = clusters.find((items) => {
      const duration = items[0].duration;
      return duration > 0 && track.duration > 0 ? Math.abs(duration - track.duration) <= 3 : duration === track.duration;
    });
    if (list) list.push(track);
    else clusters.push([track]);
    groups.set(key, clusters);
  }
  return Array.from(groups.values()).flat().map((list) => {
    list.sort((a, b) => rank[a.availability] - rank[b.availability] || Number(b.source === 'local') - Number(a.source === 'local') || (b.bitrate ?? 0) - (a.bitrate ?? 0));
    return { track: list[0], alternatives: list };
  });
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export const playable = (track: Track) => track.availability === 'full' || track.availability === 'preview' || track.availability === 'unverified';
