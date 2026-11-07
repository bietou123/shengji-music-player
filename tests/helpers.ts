import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Settings, Track } from '../shared/types';

export const defaults: Settings = { theme: 'light', enabledSources: ['netease', 'itunes'], downloadDir: path.resolve('test-artifacts/downloads'), closeToTray: false, mediaKeys: false, glassEffects: true, motionEffects: true };
export const track = (id: string, overrides: Partial<Track> = {}): Track => ({ id, source: 'local', sourceId: id.replace('local:', ''), title: 'Living', artist: 'Florian Bur', album: 'Tunes of Fantasy', duration: 129, availability: 'full', downloadable: false, ...overrides });

export async function tempDir(label: string): Promise<string> {
  const root = path.resolve('test-artifacts', 'unit');
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, `${label}-`));
}

export async function writeWav(file: string, seconds = 2, tagged = false, amplitude = 0.12, artwork?: Buffer): Promise<void> {
  const samples = Buffer.alloc(16000 * 2 * seconds);
  for (let i = 0; i < samples.length / 2; i++) {
    const time = i / 16000;
    const signal = amplitude * Math.sin(2 * Math.PI * 440 * time) + amplitude / 8 * Math.sin(2 * Math.PI * 880 * time);
    samples.writeInt16LE(Math.round(signal * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples.length, 40);
  let data = Buffer.concat([header, samples]);
  if (tagged) {
    const frame = (name: string, value: Buffer) => {
      const frameHeader = Buffer.alloc(10); frameHeader.write(name); frameHeader.writeUInt32BE(value.length, 4);
      return Buffer.concat([frameHeader, value]);
    };
    const text = (value: string) => Buffer.concat([Buffer.from([0]), Buffer.from(value)]);
    const png = artwork ?? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
    const frames = Buffer.concat([frame('TIT2', text('Tagged song')), frame('TPE1', text('Test artist')), frame('TALB', text('Test album')), frame('APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0'), Buffer.from([3, 0]), png]))]);
    const id3 = Buffer.alloc(10); id3.write('ID3'); id3[3] = 3;
    for (let i = 0; i < 4; i++) id3[6 + i] = frames.length >> (7 * (3 - i)) & 0x7f;
    const chunk = Buffer.concat([id3, frames]);
    const chunkHeader = Buffer.alloc(8); chunkHeader.write('id3 '); chunkHeader.writeUInt32LE(chunk.length, 4);
    data = Buffer.concat([data, chunkHeader, chunk, ...(chunk.length % 2 ? [Buffer.from([0])] : [])]);
    data.writeUInt32LE(data.length - 8, 4);
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}
