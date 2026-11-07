import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMedia, httpsUrl, JsonClient, networkError, validateMediaUrl } from '../electron/network';
import { isOpenLicense } from '../electron/sources';

test('JSON cache, TTL=0 refresh and in-flight request coalescing', async () => {
  let calls = 0; const client = new JsonClient(async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return Response.json({ value: calls }); });
  const values = await Promise.all([client.get('https://example.org/test'), client.get('https://example.org/test')]); assert.deepEqual(values, [{ value: 1 }, { value: 1 }]); assert.equal(calls, 1);
  await client.get('https://example.org/test'); assert.equal(calls, 1); await client.get('https://example.org/test', 0); assert.equal(calls, 2);
});
test('retry a transient network/5xx error once with bounded attempts', async () => {
  for (const error of [new TypeError('fetch failed'), Object.assign(new Error('Timeout'), { name: 'TimeoutError' }), new Response(null, { status: 503 })]) {
    let calls = 0; const client = new JsonClient(async () => { calls++; if (calls === 1) { if (error instanceof Response) return error; throw error; } return Response.json({ ok: true }); }, { retryDelayMs: 1 });
    assert.deepEqual(await client.get('https://example.org/test'), { ok: true }); assert.equal(calls, 2);
  }
});
test('do not retry authorization or rate-limit responses', async () => {
  for (const status of [401, 403, 429]) { let calls = 0; const client = new JsonClient(async () => { calls++; return new Response(null, { status }); }, { retryDelayMs: 1 }); await assert.rejects(client.get('https://example.org/test'), new RegExp(`HTTP ${status}`)); assert.equal(calls, 1); }
});
test('failed platform JSON is never cached; a single-source retry can recover', async () => {
  let calls = 0; const client = new JsonClient(async () => Response.json({ code: ++calls === 1 ? -462 : 200 }));
  const validate = (data: { code: number }) => { if (data.code !== 200) throw new Error('Platform failure'); };
  await assert.rejects(client.get('https://example.org/test', 180000, validate)); assert.deepEqual(await client.get('https://example.org/test', 180000, validate), { code: 200 }); assert.equal(calls, 2);
});
test('failed fetches are bounded and are not cached', async () => {
  let calls = 0; const client = new JsonClient(async () => { calls++; throw new TypeError('fetch failed'); }, { retryDelayMs: 1 });
  await assert.rejects(client.get('https://example.org/test')); await assert.rejects(client.get('https://example.org/test')); assert.equal(calls, 4);
});
test('reject oversized and invalid JSON responses', async () => {
  const oversized = new JsonClient(async () => new Response('{}', { headers: { 'Content-Length': '15000001' } })); await assert.rejects(oversized.get('https://example.org/test'), /响应过大/);
  const invalid = new JsonClient(async () => new Response('not json')); await assert.rejects(invalid.get('https://example.org/test'), SyntaxError);
});
test('media domain authorization rejects lookalikes, credentials, ports and local URLs', () => {
  assert.equal(validateMediaUrl('http://m7.music.126.net/file.mp3', 'netease'), 'https://m7.music.126.net/file.mp3');
  assert.equal(httpsUrl('javascript:alert(1)'), undefined);
  for (const url of ['https://music.126.net.evil.org/a', 'https://evil.org/music.126.net', 'https://user:pass@music.126.net/a', 'https://music.126.net:8080/a', 'file:///C:/a', 'http://127.0.0.1/a']) assert.throws(() => validateMediaUrl(url, 'netease'));
  assert.throws(() => validateMediaUrl('https://audio-ssl.itunes.apple.com/a.m4a', 'netease')); assert.throws(() => validateMediaUrl('https://example.org/a', 'qq'));
});
test('downloads validate every redirect before requesting it', async () => {
  const visited: string[] = []; const request: typeof fetch = async (input) => { visited.push(String(input)); return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } }); };
  await assert.rejects(fetchMedia('https://archive.org/download/audio.mp3', 'archive', {}, request), /域名/); assert.equal(visited.length, 1);
  let calls = 0; const safe = await fetchMedia('https://archive.org/first', 'archive', {}, async () => ++calls === 1 ? new Response(null, { status: 302, headers: { Location: '/second' } }) : new Response('audio'));
  assert.equal(await safe.text(), 'audio'); assert.equal(calls, 2);
});
test('only recognized Creative Commons and public-domain licenses allow downloading', () => {
  for (const url of ['https://creativecommons.org/licenses/by/4.0/', 'http://creativecommons.org/licenses/by-nc-sa/3.0/', 'https://creativecommons.org/publicdomain/zero/1.0/']) assert.equal(isOpenLicense(url), true);
  for (const url of [undefined, 'https://creativecommons.org.evil.org/licenses/by/4.0/', 'https://creativecommons.org/licenses/unknown/', 'https://creativecommons.org/publicdomain/not-a-license/', 'javascript:alert(1)']) assert.equal(isOpenLicense(url), false);
});
test('network errors are suitable for UI, not raw credential-bearing URLs', () => {
  assert.equal(networkError(new TypeError('fetch failed')), '连接失败'); assert.equal(networkError(Object.assign(new Error('x'), { name: 'TimeoutError' })), '请求超时'); assert.equal(networkError(new Error('HTTP 429')), '服务返回 HTTP 429');
});
