import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LibraryDatabase } from '../electron/database';
import { LocalLibrary } from '../electron/library';
import { exactLyricMatch, lyricsFromLrc, LyricsService } from '../electron/lyrics';
import { JsonClient } from '../electron/network';
import type { SourceId } from '../shared/types';
import { defaults, tempDir, track, writeWav } from './helpers';

async function setup(request: typeof fetch, enabled: SourceId[] = ['netease']) {
  const root = await tempDir('lyrics');
  const database = await LibraryDatabase.open(path.join(root, 'library.sqlite'), defaults, true);
  const local = new LocalLibrary(database, path.join(root, 'artwork'), () => {});
  return { root, database, local, service: new LyricsService(local, database, new JsonClient(request, { retryDelayMs: 1 }), () => enabled) };
}

test('real LRC parser synchronizes translations and respects offsets', () => {
  const result = lyricsFromLrc('[offset:100]\n[00:01.00]First\n[00:03.00]Second', 'netease', '[00:01.10]第一句\n[00:03.12]第二句');
  assert.equal(result.status, 'available');
  assert.equal(result.synchronized, true);
  assert.deepEqual(result.lines, [
    { timestamp: 1.1, content: 'First', translation: '第一句' },
    { timestamp: 3.1, content: 'Second', translation: '第二句' },
  ]);
});

test('explicit instrumental markers are honest, ordinary lyric text is not misclassified', () => {
  for (const content of ['纯音乐，请欣赏', '纯音乐', 'Instrumental', 'Music only.']) {
    const result = lyricsFromLrc(`[00:00.00]Composer\n[00:10.00]${content}`, 'netease');
    assert.equal(result.status, 'instrumental');
    assert.deepEqual(result.lines, []);
  }
  assert.equal(lyricsFromLrc('[00:00.00]Instrumental dreams tonight', 'netease').status, 'available');
  assert.equal(lyricsFromLrc('[ar:Artist]', 'netease').status, 'missing');
  assert.equal(lyricsFromLrc('', 'local').status, 'missing');
});

test('local matching requires exact title, artist, version and compatible duration', () => {
  const living = track('local:a');
  assert.equal(exactLyricMatch(living, 'Ｌｉｖｉｎｇ', 'Florian Bur', 131), true);
  for (const [title, artist, duration] of [
    ['Living (Live)', 'Florian Bur', 129], ['Living', 'Cover artist', 129],
    ['Living', 'Florian Bur', 140], ['Living', 'Florian Bur', NaN],
    ['Living', 'Florian Bur', 0],
  ] as const) assert.equal(exactLyricMatch(living, title, artist, duration), false);
  assert.equal(exactLyricMatch({ ...living, duration: Infinity }, 'Living', 'Florian Bur', 129), false);
  assert.equal(exactLyricMatch({ ...living, artist: ' Unknown Artist ' }, 'Living', 'Unknown Artist', 129), false);
});

test('local lyrics never send metadata without explicit online matching', async () => {
  let requests = 0;
  const { database, service } = await setup(async () => { requests++; throw new Error('Unexpected network'); });
  try {
    assert.equal((await service.get(track('local:a'))).status, 'missing');
    assert.equal((await service.get(track('local:a'), false, true)).status, 'missing');
    assert.equal(requests, 0);
  } finally { database.close(); }
});

test('local LRC takes priority even when online matching is requested', async () => {
  let requests = 0;
  const { root, local, database, service } = await setup(async () => { requests++; throw new Error('Unexpected network'); });
  try {
    const file = path.join(root, 'song.wav');
    await writeWav(file);
    await writeFile(path.join(root, 'song.lrc'), '[00:00.50]Local verse');
    const song = await local.readTrack(file);
    const result = await service.get(song, true, true);
    assert.equal(result.source, 'local');
    assert.equal(result.lines[0].content, 'Local verse');
    assert.equal(requests, 0);
  } finally { database.close(); }
});

test('full platform lyrics use the genuine track ID, cache and explicit refresh', async () => {
  const urls: string[] = [];
  const { database, service } = await setup(async (input) => {
    urls.push(String(input));
    return Response.json({ code: 200, lrc: { lyric: '[00:01.00]Verse' }, tlyric: { lyric: '[00:01.00]译文' } });
  });
  try {
    const song = track('netease:123', { source: 'netease', sourceId: '123' });
    assert.equal((await service.get(song)).lines[0].translation, '译文');
    await service.get(song);
    assert.equal(urls.length, 1);
    await service.get(song, false, true);
    assert.equal(urls.length, 2);
    assert.equal(new URL(urls[0]).searchParams.get('id'), '123');
  } finally { database.close(); }
});

test('previews, disabled and unimplemented sources do not claim synchronized lyrics', async () => {
  let requests = 0;
  const { database, service } = await setup(async () => { requests++; throw new Error('Unexpected network'); }, []);
  try {
    for (const song of [
      track('itunes:a', { source: 'itunes', availability: 'preview' }),
      track('netease:a', { source: 'netease', sourceId: '123' }),
      track('qq:a', { source: 'qq' }),
    ]) assert.equal((await service.get(song)).status, 'unsupported');
    assert.equal(requests, 0);
  } finally { database.close(); }
});

test('explicit local match persists for offline use, without uploading paths or audio', async () => {
  const urls: string[] = [];
  const { root, database, local, service } = await setup(async (input) => {
    const url = String(input);
    urls.push(url);
    return Response.json(url.includes('/search/')
      ? { code: 200, result: { songs: [{ id: 36841028, name: 'Living', artists: [{ name: 'Florian Bur' }], duration: 129000 }] } }
      : { code: 200, lrc: { lyric: '[00:00.00]纯音乐，请欣赏' } });
  });
  const song = track('local:a', { filePath: path.join(root, 'private', 'song.mp3') });
  const result = await service.get(song, true);
  assert.equal(result.status, 'instrumental');
  assert.equal(result.source, 'netease');
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => !url.includes('private') && !url.includes('filePath')));
  assert.equal((await service.get(song)).status, 'instrumental');
  database.close();
  const reopened = await LibraryDatabase.open(path.join(root, 'library.sqlite'), defaults, true);
  try {
    const offline = new LyricsService(local, reopened, new JsonClient(async () => { throw new Error('Offline'); }), () => []);
    assert.equal((await offline.get(song)).status, 'instrumental');
    assert.equal((await offline.get({ ...song, title: 'Different song' })).status, 'missing');
  } finally { reopened.close(); }
});

test('same-name live versions are rejected and an honest 404 stays unmatched', async () => {
  const urls: string[] = [];
  const { database, service } = await setup(async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/search/')) return Response.json({ code: 200, result: { songs: [{ id: 1, name: 'Living (Live)', artists: [{ name: 'Florian Bur' }], duration: 129000 }] } });
    return new Response(null, { status: 404 });
  });
  try {
    const result = await service.get(track('local:a'), true);
    assert.equal(result.status, 'unmatched');
    assert.deepEqual(result.lines, []);
    assert.equal(urls.length, 2);
    assert.ok(urls.every((url) => !url.includes('/song/lyric')));
  } finally { database.close(); }
});

test('LRCLIB synchronized and plain lyrics retain their real synchronization state', async () => {
  for (const synchronized of [true, false]) {
    const { database, service } = await setup(async () => Response.json({
      trackName: 'Living', artistName: 'Florian Bur', duration: 129, instrumental: false,
      syncedLyrics: synchronized ? '[00:01.00]Verse' : null, plainLyrics: synchronized ? null : 'Verse\nAnother line',
    }), []);
    try {
      const result = await service.get(track('local:a'), true);
      assert.equal(result.status, 'available');
      assert.equal(result.source, 'lrclib');
      assert.equal(result.synchronized, synchronized);
      assert.equal(result.lines[0].content, 'Verse');
    } finally { database.close(); }
  }
});

test('lyrics response with wrong metadata cannot attach to a local song', async () => {
  const { database, service } = await setup(async () => Response.json({
    trackName: 'Living (Cover)', artistName: 'Florian Bur', duration: 129, instrumental: false, syncedLyrics: '[00:00.00]Not this song',
  }), []);
  try { assert.equal((await service.get(track('local:a'), true)).status, 'unmatched'); }
  finally { database.close(); }
});

test('network failures surface for retry instead of invented lyrics', async () => {
  let requests = 0;
  const { database, service } = await setup(async () => { requests++; return new Response(null, { status: 503 }); }, []);
  try {
    await assert.rejects(service.get(track('local:a'), true), /HTTP 503/);
    assert.equal(requests, 2);
    assert.equal((await service.get(track('local:a'))).status, 'missing');
  } finally { database.close(); }
});
