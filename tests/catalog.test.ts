import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, groupTracks, playable } from '../shared/catalog';
import { moveItem, nextIndex } from '../shared/queue';
import { parseLyrics } from '../electron/library';
import { track } from './helpers';

test('aggregate the same recording across duration-bucket boundaries', () => {
  const full = track('netease:1', { source: 'netease', duration: 125.2, bitrate: 320000 });
  const preview = track('itunes:2', { source: 'itunes', title: 'LIVING', duration: 124.9, availability: 'preview' });
  const groups = groupTracks([preview, full, full]);
  assert.equal(groups.length, 1); assert.equal(groups[0].track.id, full.id); assert.equal(groups[0].alternatives.length, 2);
});
test('preserve live, instrumental, remaster, cover and longer recordings', () => {
  const values = [track('1'), track('2', { title: 'Living (Live)' }), track('3', { title: 'Living (Instrumental)' }), track('4', { album: 'Live at London' }), track('5', { album: 'Remastered' }), track('6', { artist: 'Another artist' }), track('7', { duration: 160 })];
  assert.equal(groupTracks(values).length, values.length);
});
test('prefer local playback; do not invent a duration for unknown recordings', () => {
  assert.equal(groupTracks([track('n', { source: 'netease' }), track('local:a')])[0].track.id, 'local:a');
  assert.equal(groupTracks([track('a', { duration: 0 }), track('b')]).length, 2);
});
test('permissions are not playable, unverified media can be attempted', () => {
  for (const availability of ['subscription', 'login', 'external', 'unavailable'] as const) assert.equal(playable(track('a', { availability })), false);
  for (const availability of ['full', 'preview', 'unverified'] as const) assert.equal(playable(track('a', { availability })), true);
});
test('format empty and invalid durations safely', () => {
  assert.equal(formatTime(129.8), '2:09'); assert.equal(formatTime(-1), '0:00'); assert.equal(formatTime(NaN), '0:00');
});
test('sequential end stops, list loop wraps, repeat-one affects automatic transitions', () => {
  assert.equal(nextIndex(0, -1, 'order'), -1); assert.equal(nextIndex(3, -1, 'order'), 0);
  assert.equal(nextIndex(3, 2, 'order', true), -1); assert.equal(nextIndex(3, 2, 'loop', true), 0);
  assert.equal(nextIndex(3, 1, 'one', true), 1); assert.equal(nextIndex(3, 1, 'one', false), 2);
});
test('shuffle never immediately repeats with more than one track', () => {
  for (let index = 0; index < 5; index++) for (const random of [0, 0.25, 0.5, 0.99, 1]) assert.notEqual(nextIndex(5, index, 'shuffle', true, () => random), index);
  assert.equal(nextIndex(1, 0, 'shuffle', true), 0);
});
test('reordering is immutable and ignores invalid indices', () => {
  const items = ['a', 'b', 'c']; assert.deepEqual(moveItem(items, 0, 2), ['b', 'c', 'a']); assert.deepEqual(items, ['a', 'b', 'c']);
  assert.deepEqual(moveItem(items, -1, 2), items); assert.deepEqual(moveItem(items, 0, 3), items);
});
test('LRC parsing sorts repeated timestamps and applies offsets', () => {
  const lyrics = parseLyrics('[ti:Test]\n[offset:500]\n[00:02.00]Second\n[00:00.10][00:01.10]First');
  assert.deepEqual(lyrics, [{ timestamp: 0.6, content: 'First' }, { timestamp: 1.6, content: 'First' }, { timestamp: 2.5, content: 'Second' }]);
  assert.equal(parseLyrics('[offset:-2000]\n[00:01.00]Text')[0].timestamp, 0);
  assert.deepEqual(parseLyrics('not synchronized lyrics'), []);
});
