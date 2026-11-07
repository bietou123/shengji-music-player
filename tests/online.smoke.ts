import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseBuffer } from 'music-metadata';
import { AppleAdapter, ArchiveAdapter, NeteaseAdapter } from '../electron/sources';
import { fetchMedia, JsonClient, networkError } from '../electron/network';
import { lyricsFromLrc } from '../electron/lyrics';
import type { SourceAdapter } from '../electron/sources';
import type { Track } from '../shared/types';

const checks: { name: string; status: 'pass' | 'fail' | 'not-tested'; detail: unknown }[] = [];
const client = new JsonClient();
const netease = new NeteaseAdapter(client); const apple = new AppleAdapter(client);
let failed = false;
async function check(name: string, action: () => Promise<unknown>) {
  try { const detail = await action(); checks.push({ name, status: 'pass', detail }); console.log(`PASS ${name}: ${JSON.stringify(detail)}`); }
  catch (error) { failed = true; const detail = networkError(error); checks.push({ name, status: 'fail', detail }); console.error(`FAIL ${name}: ${detail}`); }
}
let netTrack: Track | undefined; let appleTrack: Track | undefined;
await check('Netease real song search', async () => {
  const tracks = await netease.search('Living Florian Bur', 'song');
  netTrack = tracks.find((t) => t.sourceId === '36841028' && t.availability === 'full'); assert.ok(netTrack, 'Public full Living recording was not available');
  assert.ok(tracks.some((t) => t.availability === 'subscription')); assert.equal(netTrack.downloadable, false);
  return { count: tracks.length, id: netTrack.id, artist: netTrack.artist, availability: netTrack.availability, quality: netTrack.quality, artwork: Boolean(netTrack.artwork) };
});
await check('Netease real artist search', async () => {
  const tracks = await netease.search('Florian Bur', 'artist'); assert.ok(tracks.some((t) => t.artist.includes('Florian Bur'))); return { count: tracks.length };
});
await check('Netease real album search', async () => {
  const tracks = await netease.search('Tunes of Fantasy', 'album'); assert.ok(tracks.some((t) => t.album === 'Tunes of Fantasy')); return { count: tracks.length };
});
await check('Apple real official preview search', async () => {
  const tracks = await apple.search('Florian Bur Living', 'song'); appleTrack = tracks.find((t) => t.title === 'Living' && t.artist === 'Florian Bur' && t.previewUrl); assert.ok(appleTrack);
  assert.equal(appleTrack.availability, 'preview'); assert.equal(appleTrack.downloadable, false); return { count: tracks.length, id: appleTrack.id, availability: appleTrack.availability };
});
await check('Apple real artist search', async () => { const tracks = await apple.search('Florian Bur', 'artist'); assert.ok(tracks.length); return { count: tracks.length }; });
await check('Apple real album search', async () => { const tracks = await apple.search('Tunes of Fantasy', 'album'); assert.ok(tracks.length); return { count: tracks.length }; });

async function probe(adapter: SourceAdapter, track: Track | undefined) {
  assert.ok(track, 'No actual search result to resolve');
  const resolved = await adapter.resolve(track); const response = await fetchMedia(resolved.url, track.source, { headers: { Range: 'bytes=0-131071' }, signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 206); const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length > 500);
  const size = Number(response.headers.get('content-range')?.split('/').at(-1));
  let decoded: unknown;
  try { const metadata = await parseBuffer(bytes, { mimeType: response.headers.get('content-type') ?? undefined, size }, { duration: false }); decoded = metadata.format;
    if (track.source === 'netease') { assert.match(metadata.format.codec!, /MPEG/); assert.equal(Math.round(metadata.format.bitrate! / 1000), 320); }
  } catch (error) { if (track.source === 'netease') throw error; decoded = 'Partial MP4 metadata requires the complete file; Electron E2E verifies decoding.'; }
  assert.equal(resolved.track.availability, track.source === 'itunes' ? 'preview' : 'full');
  return { status: response.status, bytes: bytes.length, host: new URL(resolved.url).hostname, availability: resolved.track.availability, decoded };
}
await check('Netease actual audio Range and MP3 metadata', () => probe(netease, netTrack));
await check('Apple actual audio Range', () => probe(apple, appleTrack));

await check('Netease genuine instrumental lyrics marker', async () => {
  const data = await client.get<{ code: number; lrc?: { lyric?: string } }>('https://music.163.com/api/song/lyric?id=36841028&lv=-1&tv=-1');
  assert.equal(data.code, 200);
  const result = lyricsFromLrc(data.lrc?.lyric ?? '', 'netease');
  assert.equal(result.status, 'instrumental');
  assert.deepEqual(result.lines, []);
  return { source: result.source, status: result.status };
});
await check('Netease genuine synchronized vocal lyrics and translations', async () => {
  const data = await client.get<{ code: number; lrc?: { lyric?: string }; tlyric?: { lyric?: string } }>('https://music.163.com/api/song/lyric?id=38592976&lv=-1&tv=-1');
  assert.equal(data.code, 200);
  const result = lyricsFromLrc(data.lrc?.lyric ?? '', 'netease', data.tlyric?.lyric);
  assert.equal(result.status, 'available');
  assert.equal(result.synchronized, true);
  assert.ok(result.lines.length > 10);
  const translations = result.lines.filter((line) => line.translation).length;
  assert.ok(translations > 10);
  return { source: result.source, synchronized: result.synchronized, lines: result.lines.length, translatedLines: translations };
});

try {
  const archive = new ArchiveAdapter(new JsonClient(fetch, { timeoutMs: 5000 })); const tracks = await archive.search('Bach', 'artist');
  checks.push({ name: 'Archive optional source', status: tracks.length ? 'pass' : 'not-tested', detail: { count: tracks.length, note: 'Disabled by default' } });
} catch (error) { checks.push({ name: 'Archive optional source', status: 'not-tested', detail: networkError(error) }); }
checks.push({ name: 'Jamendo', status: 'not-tested', detail: 'No Client ID configured; no fabricated tracks.' });
checks.push({ name: 'QQ Music / Spotify', status: 'not-tested', detail: 'Not implemented; disabled in settings.' });
await mkdir('test-artifacts', { recursive: true });
await writeFile(path.resolve('test-artifacts/online-results.json'), JSON.stringify({ date: new Date().toISOString(), failed, checks }, null, 2));
if (failed) process.exitCode = 1;
