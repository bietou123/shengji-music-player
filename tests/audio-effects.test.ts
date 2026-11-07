import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { LibraryDatabase } from '../electron/database';
import { adaptivePreset, audioEffectsSchema, DEFAULT_AUDIO_EFFECTS, effectiveEffects, EQ_FREQUENCIES, restoreAudioEffects, stereoMatrix } from '../shared/audio-effects';
import { defaults, tempDir, track } from './helpers';

test('effects validate all ten bands, finite values and bounded stereo width', () => {
  assert.equal(EQ_FREQUENCIES.length, 10);
  assert.deepEqual(audioEffectsSchema.parse(DEFAULT_AUDIO_EFFECTS), DEFAULT_AUDIO_EFFECTS);
  for (const update of [
    { bands: [0] }, { bands: Array(10).fill(12.5) }, { bands: Array(10).fill(NaN) },
    { width: -0.1 }, { width: 1.6 }, { width: Infinity }, { preset: 'unrecognized' }, { enabled: 'yes' },
  ]) assert.equal(audioEffectsSchema.safeParse({ ...DEFAULT_AUDIO_EFFECTS, ...update }).success, false);
  const fallback = restoreAudioEffects(null);
  fallback.bands[0] = 8;
  assert.equal(DEFAULT_AUDIO_EFFECTS.bands[0], 0);
  assert.equal(restoreAudioEffects({}).bands[0], 0);
});

test('automatic adaptation uses known metadata and leaves unknown music flat', () => {
  assert.equal(adaptivePreset(track('local:living')), 'piano');
  const generic = track('local:generic', { title: 'Song', artist: 'An artist', album: 'Album' });
  assert.equal(adaptivePreset(null), 'flat');
  assert.equal(adaptivePreset(generic), 'flat');
  assert.equal(adaptivePreset({ ...generic, genres: ['Classical'] }), 'piano');
  assert.equal(adaptivePreset({ ...generic, genres: ['电子舞曲'] }), 'bass');
  assert.equal(adaptivePreset({ ...generic, genres: ['Folk'] }), 'warm');
  assert.equal(adaptivePreset({ ...generic, title: 'Vocal version' }), 'vocal');
});

test('disabled DSP is an identity path even with an enhanced preset saved', () => {
  const effects = effectiveEffects({ ...DEFAULT_AUDIO_EFFECTS, preset: 'night', width: 1.5, compressor: true }, track('local:a'));
  assert.deepEqual(effects.bands, Array(10).fill(0));
  assert.equal(effects.width, 1);
  assert.equal(effects.compressor, false);
  const enabled = effectiveEffects({ ...DEFAULT_AUDIO_EFFECTS, enabled: true, preset: 'night' }, null);
  assert.equal(enabled.compressor, true);
  assert.ok(enabled.bands.some((gain) => gain !== 0));
});

test('presets and custom bands cannot mutate shared defaults or each other', () => {
  const settings = { ...DEFAULT_AUDIO_EFFECTS, enabled: true };
  const piano = effectiveEffects(settings, track('local:a'));
  piano.bands[0] = 12;
  assert.equal(effectiveEffects(settings, track('local:a')).bands[0], -2);
  const custom = { ...settings, preset: 'custom' as const, bands: Array(10).fill(1) };
  effectiveEffects(custom, null).bands[0] = 7;
  assert.equal(custom.bands[0], 1);
});

test('stereo matrix preserves mono, provides identity and bounds widening', () => {
  assert.deepEqual(stereoMatrix(0), [0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual(stereoMatrix(1), [1, 0, 0, 1]);
  assert.deepEqual(stereoMatrix(1.5), [1.25, -0.25, -0.25, 1.25]);
  assert.deepEqual(stereoMatrix(-10), stereoMatrix(0));
  assert.deepEqual(stereoMatrix(10), stereoMatrix(1.5));
  for (const width of [0, 0.5, 1, 1.5]) {
    const [ll, lr, rl, rr] = stereoMatrix(width);
    assert.equal(ll + lr, 1);
    assert.equal(rl + rr, 1);
  }
});

test('SQLite persists sound settings and safely defaults old or corrupt settings', async () => {
  const file = path.join(await tempDir('effects'), 'library.sqlite');
  let database = await LibraryDatabase.open(file, defaults, true);
  assert.deepEqual(database.snapshot().audioEffects, DEFAULT_AUDIO_EFFECTS);
  const saved = { ...DEFAULT_AUDIO_EFFECTS, enabled: true, preset: 'custom' as const, bands: [-1, 0, 1, 2, 3, 0, 0, -2, 1, 0], width: 1.2, compressor: true, visualizer: false };
  database.setValue('audioEffects', saved);
  database.close();
  database = await LibraryDatabase.open(file, defaults, true);
  assert.deepEqual(database.snapshot().audioEffects, saved);
  database.setValue('audioEffects', { ...saved, bands: [Infinity] });
  assert.deepEqual(database.snapshot().audioEffects, DEFAULT_AUDIO_EFFECTS);
  database.close();
});
