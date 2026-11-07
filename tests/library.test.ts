import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LibraryDatabase } from '../electron/database';
import { LocalLibrary } from '../electron/library';
import { mediaResponse } from '../electron/media';
import { defaults, tempDir, track, writeWav } from './helpers';

test('SQLite restores favorites, playlists, ordered queue, settings and position', async () => {
  const root = await tempDir('restore'); const file = path.join(root, 'library.sqlite');
  let db = await LibraryDatabase.open(file, defaults, true);
  const a = track('local:a'); const b = track('netease:b', { source: 'netease', streamUrl: 'https://temporary.music.126.net/audio.mp3', downloadUrl: 'https://temporary.music.126.net/audio.mp3' });
  db.favorite(a, true); db.recordPlay(b);
  const playlist = db.createPlaylist('First'); db.addToPlaylist(playlist, [a, b, a]); db.reorderPlaylist(playlist, [b.id, a.id]); db.renamePlaylist(playlist, 'Renamed');
  db.setValue('settings', { ...defaults, theme: 'dark' });
  db.setValue('playback', { queue: [b.id, a.id, b.id], currentId: b.id, index: 2, position: 42.5, volume: 0.23, muted: true, mode: 'loop' });
  db.rememberSearch('Living'); db.rememberSearch('Florian Bur'); db.rememberSearch('Living'); db.close();
  assert.equal((await readFile(file)).subarray(0, 16).toString(), 'SQLite format 3\0');
  db = await LibraryDatabase.open(file, defaults, true);
  const snapshot = db.snapshot(); assert.equal(snapshot.settings.theme, 'dark'); assert.equal(snapshot.favorites[0].id, a.id); assert.equal(snapshot.recent[0].id, b.id);
  assert.equal(snapshot.playlists[0].name, 'Renamed'); assert.deepEqual(snapshot.playlists[0].tracks.map((t) => t.id), [b.id, a.id]);
  assert.deepEqual(snapshot.queueTracks.map((t) => t.id), [b.id, a.id, b.id]); assert.equal(snapshot.playback.position, 42.5); assert.equal(snapshot.playback.index, 2);
  assert.deepEqual(snapshot.searchHistory, ['Living', 'Florian Bur']); assert.equal(db.getTrack(b.id)?.streamUrl, undefined); assert.equal(db.getTrack(b.id)?.downloadUrl, undefined);
  db.close();
});
test('invalid playlist reorder is rejected without losing existing order', async () => {
  const root = await tempDir('reorder'); const db = await LibraryDatabase.open(path.join(root, 'db.sqlite'), defaults);
  const playlist = db.createPlaylist('Test'); db.addToPlaylist(playlist, [track('a'), track('b')]);
  assert.throws(() => db.reorderPlaylist(playlist, ['a', 'a'])); assert.throws(() => db.reorderPlaylist(playlist, ['a', 'missing'])); assert.throws(() => db.reorderPlaylist('missing', []));
  assert.deepEqual(db.snapshot().playlists[0].tracks.map((t) => t.id), ['a', 'b']);
  db.removeFromPlaylist(playlist, 'a'); assert.equal(db.snapshot().playlists[0].tracks.length, 1); db.deletePlaylist(playlist); assert.equal(db.snapshot().playlists.length, 0); db.close();
});

test('legacy settings acquire glass defaults without changing saved preferences', async () => {
  const root = await tempDir('legacy-appearance');
  const file = path.join(root, 'library.sqlite');
  let db = await LibraryDatabase.open(file, defaults, true);
  db.setValue('settings', { theme: 'dark', enabledSources: ['itunes'], downloadDir: defaults.downloadDir, closeToTray: false, mediaKeys: false });
  db.close();
  db = await LibraryDatabase.open(file, defaults, true);
  assert.deepEqual(db.settings(), { ...defaults, theme: 'dark', enabledSources: ['itunes'], glassEffects: true, motionEffects: true });
  db.close();
});

test('glass and motion settings persist independently through SQLite reopen', async () => {
  const root = await tempDir('appearance-restore');
  const file = path.join(root, 'library.sqlite');
  let db = await LibraryDatabase.open(file, defaults, true);
  db.setValue('settings', { ...defaults, glassEffects: false, motionEffects: true });
  db.close();
  db = await LibraryDatabase.open(file, defaults, true);
  assert.equal(db.settings().glassEffects, false);
  assert.equal(db.settings().motionEffects, true);
  db.setValue('settings', { ...db.settings(), glassEffects: true, motionEffects: false });
  db.close();
  db = await LibraryDatabase.open(file, defaults, true);
  assert.equal(db.settings().glassEffects, true);
  assert.equal(db.settings().motionEffects, false);
  db.close();
});
test('removing local library entries cascades but never deletes the audio file', async () => {
  const root = await tempDir('remove'); const file = path.join(root, 'audio.wav'); await writeWav(file);
  const db = await LibraryDatabase.open(path.join(root, 'db.sqlite'), defaults); const a = track('local:a', { filePath: file });
  db.favorite(a, true); db.recordPlay(a); const playlist = db.createPlaylist('Test'); db.addToPlaylist(playlist, [a]);
  db.setValue('playback', { queue: [a.id], currentId: a.id, index: 0, position: 1, volume: 0.65, muted: false, mode: 'order' });
  db.removeLocal(a.id); const snapshot = db.snapshot(); assert.equal(snapshot.localTracks.length, 0); assert.equal(snapshot.favorites.length, 0); assert.equal(snapshot.recent.length, 0);
  assert.equal(snapshot.playlists[0].tracks.length, 0); assert.deepEqual(snapshot.playback.queue, []); assert.equal(snapshot.playback.currentId, null); assert.ok((await stat(file)).isFile()); db.close();
});
test('directory scan reads real tags, embedded cover, WAV duration and local LRC', async () => {
  const root = await tempDir('tags'); const folder = path.join(root, 'music'); const file = path.join(folder, 'wrong filename.wav'); await writeWav(file, 2, true);
  await writeFile(path.join(folder, 'wrong filename.lrc'), '[00:01.00]Lyric'); await writeFile(path.join(folder, 'ignore.txt'), 'No audio');
  const db = await LibraryDatabase.open(path.join(root, 'db.sqlite'), defaults); const library = new LocalLibrary(db, path.join(root, 'artwork'), () => {});
  assert.equal((await library.import([folder])).imported, 1); const a = db.snapshot().localTracks[0];
  assert.equal(a.title, 'Tagged song'); assert.equal(a.artist, 'Test artist'); assert.equal(a.album, 'Test album'); assert.equal(a.duration, 2); assert.equal(a.quality, '无损'); assert.ok(a.artwork?.startsWith('shengji-media://cover/'));
  assert.deepEqual(await library.lyrics(a), [{ timestamp: 1, content: 'Lyric' }]); assert.equal(db.snapshot().folders[0].count, 1);
  assert.equal((await library.import([file, folder])).imported, 1); assert.equal(db.snapshot().localTracks.length, 1);
  const cover = await mediaResponse(new Request(a.artwork!), db, path.join(root, 'artwork')); assert.equal(cover.status, 200); assert.equal((await cover.arrayBuffer()).byteLength > 0, true);
  db.removeFolder(folder); assert.equal(db.snapshot().folders.length, 0); assert.equal(db.snapshot().localTracks.length, 1); db.close();
});
test('import reports corrupt audio and inaccessible paths without inventing tracks', async () => {
  const root = await tempDir('invalid'); const file = path.join(root, 'bad.mp3'); await writeFile(file, 'not audio');
  const db = await LibraryDatabase.open(path.join(root, 'db.sqlite'), defaults); const library = new LocalLibrary(db, path.join(root, 'artwork'), () => {});
  const result = await library.import([file, path.join(root, 'missing')]); assert.equal(result.imported, 0); assert.equal(result.skipped, 1); assert.equal(result.errors.length, 2); assert.equal(db.snapshot().localTracks.length, 0); db.close();
});
test('local media protocol only exposes authorized audio and handles Range/HEAD safely', async () => {
  const root = await tempDir('range'); const file = path.join(root, 'audio.wav'); await writeWav(file);
  const db = await LibraryDatabase.open(path.join(root, 'db.sqlite'), defaults); db.putTracks([track('local:a', { filePath: file }), track('remote', { source: 'netease', filePath: file })]);
  const request = (id: string, headers: HeadersInit = {}, method = 'GET') => new Request(`shengji-media://track/${encodeURIComponent(id)}`, { headers, method });
  const part = await mediaResponse(request('local:a', { Range: 'bytes=0-15' }), db, root); assert.equal(part.status, 206); assert.equal((await part.arrayBuffer()).byteLength, 16); assert.match(part.headers.get('content-range')!, /^bytes 0-15\//);
  const suffix = await mediaResponse(request('local:a', { Range: 'bytes=-8' }), db, root); assert.equal((await suffix.arrayBuffer()).byteLength, 8);
  const head = await mediaResponse(request('local:a', {}, 'HEAD'), db, root); assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const range of ['bytes=99999999-', 'bytes=0-1,4-5', 'items=0-3', 'invalid']) assert.equal((await mediaResponse(request('local:a', { Range: range }), db, root)).status, 416);
  for (const id of ['remote', '../audio.wav', 'C:/Windows/System32/config/SAM', 'missing']) assert.equal((await mediaResponse(request(id), db, root)).status, 404);
  assert.equal((await mediaResponse(request('local:a', {}, 'POST'), db, root)).status, 405); db.close();
});
