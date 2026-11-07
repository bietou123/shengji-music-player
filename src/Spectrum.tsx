import { useEffect, useRef } from 'react';
import { player, usePlayer } from './player';

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
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let lastDraw = 0;
    let disposed = false;
    let colors = getComputedStyle(element);
    const running = status === 'playing' && enabled;
    const bars = compact ? 10 : 28;
    const paint = (time = 0) => {
      if (disposed) return;
      if (time && time - lastDraw < 32) return;
      lastDraw = time;
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (!width || !height) return;
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
    };
    const schedule = () => {
      if (!frame && !disposed && running && !motion.matches && element.clientWidth > 0) frame = requestAnimationFrame(tick);
    };
    const tick = (time: number) => { frame = 0; paint(time); schedule(); };
    const repaint = () => { paint(); schedule(); };
    const palette = () => { colors = getComputedStyle(element); repaint(); };
    const resize = new ResizeObserver(repaint);
    resize.observe(element);
    const theme = new MutationObserver(palette);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const changeMotion = () => { cancelAnimationFrame(frame); frame = 0; repaint(); };
    motion.addEventListener('change', changeMotion);
    repaint();
    const timer = setTimeout(() => { if (motion.matches) paint(); }, 350);
    return () => {
      disposed = true;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      resize.disconnect();
      theme.disconnect();
      motion.removeEventListener('change', changeMotion);
    };
  }, [status, enabled, compact, trackId]);
  return <canvas ref={canvas} className={`audio-spectrum ${compact ? 'compact' : ''}`} role="img" aria-label="音频频谱" data-playing={status === 'playing' && enabled} />;
}
