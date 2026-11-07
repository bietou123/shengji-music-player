import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemoteMedia } from '../electron/media';

test('remote playback issues opaque grants only for adapter-authorized media', () => {
  const media = new RemoteMedia();
  const grant = media.authorize('https://m7.music.126.net/song.mp3', 'netease');
  assert.match(grant, /^shengji-media:\/\/stream\/[a-f0-9-]{36}$/);
  assert.equal(grant.includes('music.126.net'), false);
  for (const url of ['https://127.0.0.1/private', 'file:///C:/private.mp3', 'https://music.126.net.evil.org/song', 'https://user:secret@music.126.net/song'])
    assert.throws(() => media.authorize(url, 'netease'));
  assert.throws(() => media.authorize('https://m7.music.126.net/song.mp3', 'local'));
});

test('authorized remote streams forward one Range, HEAD, MIME and CORS safely', async () => {
  const requests: { url: string; method: string | undefined; range: string | null }[] = [];
  const media = new RemoteMedia(async (input, options) => {
    requests.push({ url: String(input), method: options?.method, range: new Headers(options?.headers).get('range') });
    return new Response(options?.method === 'HEAD' ? null : new Uint8Array(16), {
      status: 206, headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '16', 'Content-Range': 'bytes 0-15/100', 'Accept-Ranges': 'bytes', 'Set-Cookie': 'not-forwarded=1' },
    });
  });
  const grant = media.authorize('https://m7.music.126.net/song.mp3', 'netease');
  const response = await media.response(new Request(grant, { headers: { Range: 'bytes=0-15' } }));
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 16);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Content-Range'), 'bytes 0-15/100');
  assert.equal(response.headers.get('Set-Cookie'), null);
  const head = await media.response(new Request(grant, { method: 'HEAD' }));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.deepEqual(requests.map((request) => request.method), ['GET', 'HEAD']);
  assert.equal(requests[0].range, 'bytes=0-15');
});

test('remote grant handler rejects fabricated tokens, methods and multipart ranges', async () => {
  let requests = 0;
  const media = new RemoteMedia(async () => { requests++; return new Response(null); });
  const grant = media.authorize('https://m7.music.126.net/song.mp3', 'netease');
  for (const value of [grant + '?url=https://evil.org', grant.replace('stream', 'other'), 'shengji-media://stream/guessed-token'])
    assert.equal((await media.response(new Request(value))).status, 404);
  assert.equal((await media.response(new Request(grant, { method: 'POST' }))).status, 405);
  for (const range of ['bytes=0-1,4-5', 'items=0-10', 'invalid'])
    assert.equal((await media.response(new Request(grant, { headers: { Range: range } }))).status, 416);
  assert.equal(requests, 0);
});

test('remote playback validates redirects and rejects successful nonaudio bodies', async () => {
  let requests = 0;
  const redirect = new RemoteMedia(async () => {
    requests++;
    return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } });
  });
  assert.equal((await redirect.response(new Request(redirect.authorize('https://m7.music.126.net/song.mp3', 'netease')))).status, 502);
  assert.equal(requests, 1);
  const html = new RemoteMedia(async () => new Response('<html>Not audio</html>', { headers: { 'Content-Type': 'text/html', 'Content-Length': '22' } }));
  const result = await html.response(new Request(html.authorize('https://audio-ssl.itunes.apple.com/audio.m4a', 'itunes')));
  assert.equal(result.status, 502);
  assert.equal(result.headers.get('Content-Length'), null);
});

test('remote grants are bounded and stale grants cannot proxy arbitrary URLs', async () => {
  const media = new RemoteMedia(async () => new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'audio/mpeg' } }));
  const first = media.authorize('https://m7.music.126.net/song.mp3', 'netease');
  let latest = '';
  for (let i = 0; i < 200; i++) latest = media.authorize(`https://m7.music.126.net/${i}.mp3`, 'netease');
  assert.equal((await media.response(new Request(first))).status, 404);
  assert.equal((await media.response(new Request(latest))).status, 200);
});
