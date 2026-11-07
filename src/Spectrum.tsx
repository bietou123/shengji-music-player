import { useEffect, useRef } from 'react';
import { player, usePlayer } from './player';
import { visualFrames } from './visual-runtime';

export function Spectrum({ compact = false }: { compact?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const status = usePlayer((state) => state.status);
  const enabled = usePlayer((state) => state.effects.visualizer);
  const trackId = usePlayer((state) => state.current?.id);
  const previous = useRef<{ values: number[]; rms: number; peakHz: number; peakDb: number; compressionDb: number } | null>(null);
  const version = useRef(0);
  useEffect(() => { previous.current = null; }, [trackId]);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    let lastDraw = 0;
    let intersecting = true;
    let colors = getComputedStyle(element);
    const running = status === 'playing' && enabled;
    const bars = compact ? 10 : 28;
    const paint = (time = 0) => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      const visible = intersecting && width > 0 && height > 0 && !element.closest('[inert]') && getComputedStyle(element).visibility !== 'hidden';
      const continuous = visible && running && visualFrames.motion;
      element.dataset.active = String(continuous);
      if (!visible) return false;
      if (time && time - lastDraw < 32) return continuous;
      lastDraw = time;
      const ratio = Math.min(2, devicePixelRatio || 1);
      if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
        element.width = Math.round(width * ratio);
        element.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const signal = running ? player.spectrum() : null;
      if (signal) {
        let peakBin = 0;
        let peakDb = -100;
        for (let i = 1; i < signal.frequencies.length; i++) {
          if (signal.frequencies[i] > peakDb) { peakDb = signal.frequencies[i]; peakBin = i; }
        }
        const binHz = signal.sampleRate / (signal.frequencies.length * 2);
        const values = Array.from({ length: bars }, (_, index) => {
          const from = Math.max(1, Math.floor(45 * Math.pow(400, index / bars) / binHz));
          const to = Math.min(signal.frequencies.length - 1, Math.max(from, Math.ceil(45 * Math.pow(400, (index + 1) / bars) / binHz)));
          let db = -100;
          for (let bin = from; bin <= to; bin++) db = Math.max(db, signal.frequencies[bin]);
          return Math.max(0, Math.min(1, (db + 95) / 70));
        });
        const rms = Math.sqrt(signal.waveform.reduce((sum, value) => sum + value * value, 0) / signal.waveform.length);
        previous.current = { values, rms, peakDb, peakHz: peakBin * binHz, compressionDb: signal.compressionDb };
        element.dataset.frame = String(++version.current);
      }
      const metrics = enabled ? previous.current : null;
      element.dataset.rms = String(metrics?.rms ?? 0);
      element.dataset.peakHz = String(metrics?.peakHz ?? 0);
      element.dataset.peakDb = String(metrics?.peakDb ?? -100);
      element.dataset.compressionDb = String(metrics?.compressionDb ?? 0);
      const gap = compact ? 2 : 3;
      const barWidth = Math.max(1, (width - (bars - 1) * gap) / bars);
      const accent = colors.getPropertyValue('--accent').trim();
      const line = colors.getPropertyValue('--line').trim();
      for (let index = 0; index < bars; index++) {
        const value = metrics?.values[index] ?? 0;
        const barHeight = Math.max(2, value * (height - 2));
        context.fillStyle = value > 0.015 ? accent : line;
        context.globalAlpha = running ? 0.8 : 0.42;
        context.fillRect(index * (barWidth + gap), height - barHeight, barWidth, barHeight);
      }
      context.globalAlpha = 1;
      return continuous;
    };
    const task = visualFrames.add(paint);
    const repaint = () => { lastDraw = 0; task.request(); };
    const palette = () => { colors = getComputedStyle(element); repaint(); };
    const resize = new ResizeObserver(repaint);
    resize.observe(element);
    const theme = new MutationObserver(palette);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const intersection = new IntersectionObserver(([entry]) => { intersecting = entry.isIntersecting; repaint(); });
    intersection.observe(element);
    const unsubscribe = visualFrames.subscribe(() => {
      if (!visualFrames.visible) element.dataset.active = 'false';
      repaint();
    });
    repaint();
    const timer = setTimeout(() => { if (!visualFrames.motion) repaint(); }, 350);
    return () => {
      clearTimeout(timer);
      task.dispose();
      unsubscribe();
      resize.disconnect();
      theme.disconnect();
      intersection.disconnect();
      element.dataset.active = 'false';
    };
  }, [status, enabled, compact, trackId]);
  return <canvas ref={canvas} className={`audio-spectrum ${compact ? 'compact' : ''}`} role="img" aria-label="音频频谱" data-playing={status === 'playing' && enabled} />;
}
