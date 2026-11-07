import type { AudioEffectsSettings, AudioPreset, Track } from './types';
import { z } from 'zod';

export const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const AUDIO_PRESET_NAMES: Record<AudioPreset, string> = {
  auto: '自动适配', flat: '原声', piano: '钢琴', vocal: '人声', bass: '低音', warm: '温暖', bright: '清亮', night: '夜间', custom: '自定义',
};
const PRESETS: Record<Exclude<AudioPreset, 'auto' | 'custom'>, number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  piano: [-2, -1, 0, 1, 1.5, 1, 0.5, 1, 1.5, 0],
  vocal: [-3, -2, -1, 0, 1, 2.5, 3, 2, 0, -1],
  bass: [4, 4, 3, 1, 0, -1, -1, 0, 0, 0],
  warm: [1, 2, 2, 1, 0, 0, -0.5, -1, -1.5, -2],
  bright: [-1, -1, 0, 0, 0, 1, 2, 2.5, 3, 2],
  night: [-3, -2, -1, 0, 1, 2, 2, 0, -1, -2],
};
export const DEFAULT_AUDIO_EFFECTS: AudioEffectsSettings = { enabled: false, preset: 'auto', bands: [...PRESETS.flat], width: 1, compressor: false, visualizer: true };
export const audioEffectsSchema = z.object({
  enabled: z.boolean(),
  preset: z.enum(['auto', 'flat', 'piano', 'vocal', 'bass', 'warm', 'bright', 'night', 'custom']),
  bands: z.array(z.number().finite().min(-12).max(12)).length(EQ_FREQUENCIES.length),
  width: z.number().finite().min(0).max(1.5),
  compressor: z.boolean(),
  visualizer: z.boolean(),
});

export function restoreAudioEffects(value: unknown): AudioEffectsSettings {
  const parsed = audioEffectsSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_AUDIO_EFFECTS, bands: [...DEFAULT_AUDIO_EFFECTS.bands] };
}

export function adaptivePreset(track: Track | null): Exclude<AudioPreset, 'auto' | 'custom'> {
  if (!track) return 'flat';
  const metadata = `${track.title} ${track.album} ${(track.genres ?? []).join(' ')}`.toLowerCase();
  if (/piano|钢琴|古典|classical/.test(metadata) || /^florian bur$/i.test(track.artist.trim())) return 'piano';
  if (/acoustic|unplugged|原声|不插电|民谣|folk/.test(metadata)) return 'warm';
  if (/electronic|dance|edm|hip.?hop|电子|舞曲|嘻哈/.test(metadata)) return 'bass';
  if (/a.?cappella|vocal|人声|清唱/.test(metadata)) return 'vocal';
  return 'flat';
}

export function effectiveEffects(settings: AudioEffectsSettings, track: Track | null) {
  const preset = settings.preset === 'auto' ? adaptivePreset(track) : settings.preset;
  const bands = preset === 'custom' ? [...settings.bands] : [...PRESETS[preset]];
  return {
    preset, bands: settings.enabled ? bands : [...PRESETS.flat],
    width: settings.enabled ? settings.width : 1,
    compressor: settings.enabled && (settings.compressor || preset === 'night'),
  };
}

export function stereoMatrix(width: number): [number, number, number, number] {
  const bounded = Math.max(0, Math.min(1.5, width));
  return [(1 + bounded) / 2, (1 - bounded) / 2, (1 - bounded) / 2, (1 + bounded) / 2];
}
