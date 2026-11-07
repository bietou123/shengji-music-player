import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppleAdapter, JamendoAdapter, NeteaseAdapter, SourceRegistry } from '../electron/sources';
import { JsonClient } from '../electron/network';
import { track } from './helpers';

const song = (id: number, fee = 0) => ({ id, name: 'Living', fee, duration: 129000, artists: [{ name: 'Florian Bur' }], album: { name: 'Tunes of Fantasy' } });
const media = (id: number, overrides = {}) => ({ id, code: 200, url: `https://m7.music.126.net/${id}.mp3`, br: 320000, type: 'mp3', fee: 0, freeTrialInfo: null, ...overrides });
function netClient(options: { artworkFailure?: boolean; mediaFailure?: boolean; artist?: boolean; album?: boolean } = {}) {
  const urls: URL[] = [];
  const client = new JsonClient(async (input) => {
    const url = new URL(String(input)); urls.push(url);
    if (url.pathname === '/api/search/get') return Response.json({ code: 200, result: options.artist ? { artists: [{ id: 100 }, { id: 200 }] } : options.album ? { albums: [{ id: 300 }] } : { songs: [song(1), song(2, 1), song(3), song(4)] } });
    if (url.pathname === '/api/artist/100') return Response.json({ code: 200, hotSongs: [song(1)] });
    if (url.pathname === '/api/artist/200') return Response.json({ code: -462 });
    if (url.pathname === '/api/album/300') return Response.json({ code: 200, album: { songs: [song(1)] } });
    if (url.pathname === '/api/song/detail/') return Response.json(options.artworkFailure ? { code: -462 } : { code: 200, songs: [1, 2, 3, 4].map((id) => ({ ...song(id), album: { name: 'Tunes of Fantasy', picUrl: 'https://p3.music.126.net/cover.jpg' } })) });
    if (url.pathname === '/api/song/enhance/player/url') {
      if (options.mediaFailure) return Response.json({ code: -462 });
      const ids = JSON.parse(url.searchParams.get('ids')!) as number[];
      assert.equal(ids.includes(2), false, 'Paid songs must not be requested');
      return Response.json({ code: 200, data: ids.map((id) => media(id, id === 3 ? { url: null, code: 404 } : id === 4 ? { freeTrialInfo: { start: 0, end: 30000 }, br: 128000 } : {})) });
    }
    throw new Error(`Unexpected test request: ${url.pathname}`);
  });
  return { client, urls };
}

test('Netease verifies full/preview/paid/external states and actual bitrate', async () => {
  const { client, urls } = netClient(); const adapter = new NeteaseAdapter(client); const tracks = await adapter.search('Living', 'song');
  assert.deepEqual(tracks.map((t) => t.availability), ['full', 'subscription', 'external', 'preview']);
  assert.equal(tracks[0].bitrate, 320000); assert.equal(tracks[0].quality, '320 kbps'); assert.equal(tracks[3].bitrate, 128000); assert.ok(tracks[0].artwork);
  assert.equal(tracks.every((t) => !t.downloadable && !t.streamUrl && !t.downloadUrl), true);
  const before = urls.length; await assert.rejects(adapter.resolve(tracks[1]), /账号权限/); assert.equal(urls.length, before);
  assert.equal((await adapter.resolve(tracks[0])).track.availability, 'full');
});
test('a failed availability check keeps real catalog results unverified, never full', async () => {
  const { client } = netClient({ mediaFailure: true, artworkFailure: true }); const tracks = await new NeteaseAdapter(client).search('Living', 'song');
  assert.equal(tracks[0].availability, 'unverified'); assert.equal(tracks[0].quality, '待验证'); assert.equal(tracks[0].artwork, undefined); assert.equal(tracks.length, 4);
});
test('artist search uses the actual artist catalog and tolerates a partial artist failure', async () => {
  const { client, urls } = netClient({ artist: true }); const tracks = await new NeteaseAdapter(client).search('Florian Bur', 'artist');
  assert.equal(urls[0].searchParams.get('type'), '100'); assert.ok(urls.some((u) => u.pathname === '/api/artist/100')); assert.equal(tracks.length, 1); assert.equal(tracks[0].artist, 'Florian Bur');
});
test('album search uses the actual album tracklist', async () => {
  const { client, urls } = netClient({ album: true }); const tracks = await new NeteaseAdapter(client).search('Tunes of Fantasy', 'album');
  assert.equal(urls[0].searchParams.get('type'), '10'); assert.ok(urls.some((u) => u.pathname === '/api/album/300')); assert.equal(tracks[0].album, 'Tunes of Fantasy');
});
test('paid or untrusted media cannot be promoted to full playback during resolution', async () => {
  for (const audio of [media(1, { fee: 1 }), media(1, { url: 'https://example.org/private.mp3' })]) {
    const adapter = new NeteaseAdapter(new JsonClient(async () => Response.json({ code: 200, data: [audio] })));
    await assert.rejects(adapter.resolve(track('netease:1', { source: 'netease', sourceId: '1', availability: 'unverified' })));
  }
});
test('Apple official previews remain previews and never claim a guessed bitrate', async () => {
  const urls: URL[] = []; const client = new JsonClient(async (input) => { const url = new URL(String(input)); urls.push(url); return Response.json({ results: [{ kind: 'song', trackId: 20, trackName: 'Living', artistName: 'Florian Bur', collectionName: 'Tunes of Fantasy', trackTimeMillis: 129000, artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100bb.jpg', previewUrl: 'https://audio-ssl.itunes.apple.com/preview.m4a' }] }); });
  const adapter = new AppleAdapter(client); const tracks = await adapter.search('Florian Bur', 'artist'); assert.equal(urls[0].searchParams.get('attribute'), 'artistTerm');
  assert.equal(tracks[0].availability, 'preview'); assert.equal(tracks[0].bitrate, undefined); assert.equal(tracks[0].downloadable, false); assert.match(tracks[0].artwork!, /600x600/);
  assert.equal((await adapter.resolve({ ...tracks[0], availability: 'full' })).track.availability, 'preview');
});
test('registry isolates source failures and marks unimplemented/unconfigured sources honestly', async () => {
  const client = new JsonClient(async (input) => {
    const url = new URL(String(input)); if (url.hostname === 'itunes.apple.com') return new Response(null, { status: 503 });
    return Response.json({ code: 200, result: { songs: [] } });
  }, { retryDelayMs: 1 });
  const registry = new SourceRegistry(client, () => undefined, () => ['netease', 'itunes'], () => false);
  const result = await registry.search({ query: 'Living', kind: 'song', sources: ['netease', 'itunes', 'jamendo'] });
  assert.deepEqual(result.statuses.map((s) => s.status), ['ok', 'error', 'disabled']); assert.deepEqual(result.tracks, []);
  for (const id of ['qq', 'spotify']) assert.equal(registry.descriptors().find((s) => s.id === id)?.implemented, false);
  await assert.rejects(registry.resolve(track('qq:1', { source: 'qq' })), /尚未接入/);
});
test('Jamendo needs a real Client ID and honors download permission and CC license together', async () => {
  const client = new JsonClient(async () => Response.json({ headers: { status: 'success' }, results: [true, false].map((allowed, index) => ({ id: String(index + 1), name: 'Song', artist_name: 'Artist', album_name: 'Album', duration: 120, audio: 'https://prod-1.storage.jamendo.com/audio.mp3', audiodownload: 'https://prod-1.storage.jamendo.com/audio.mp3', audiodownload_allowed: allowed, license_ccurl: 'https://creativecommons.org/licenses/by-nc-sa/3.0/' })) }));
  await assert.rejects(new JamendoAdapter(client, () => undefined).search('Song', 'song'), /Client ID/);
  assert.deepEqual((await new JamendoAdapter(client, () => 'test-client').search('Song', 'song')).map((t) => t.downloadable), [true, false]);
});
