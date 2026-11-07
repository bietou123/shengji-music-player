import type { PlayMode } from './types';

export function nextIndex(length: number, current: number, mode: PlayMode, automatic = false, random = Math.random): number {
  if (!length) return -1;
  if (current < 0 || current >= length) return 0;
  if (automatic && mode === 'one') return current;
  if (mode === 'shuffle' && length > 1) {
    const candidate = Math.floor(Math.max(0, Math.min(0.999999, random())) * (length - 1));
    return candidate >= current ? candidate + 1 : candidate;
  }
  if (current + 1 < length) return current + 1;
  return automatic && mode === 'order' ? -1 : 0;
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return items;
  const result = [...items];
  result.splice(to, 0, result.splice(from, 1)[0]);
  return result;
}
