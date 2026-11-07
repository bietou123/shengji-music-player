import { ChevronDown, RotateCcw } from 'lucide-react';
import { AUDIO_PRESET_NAMES, DEFAULT_AUDIO_EFFECTS, effectiveEffects, EQ_FREQUENCIES } from '../shared/audio-effects';
import type { AudioPreset } from '../shared/types';
import { Cover, IconButton, Modal } from './components';
import { player, usePlayer } from './player';
import { Spectrum } from './Spectrum';

function EffectSwitch({ label, checked, disabled = false, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange(value: boolean): void }) {
  return <label className={`switch ${disabled ? 'disabled' : ''}`} title={label}>
    <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    <span />
  </label>;
}

export function AudioEffectsModal({ onClose }: { onClose(): void }) {
  const { effects, current, status, effectsHeadroom, effectsError } = usePlayer();
  const effective = effectiveEffects({ ...effects, enabled: true }, current);
  const unavailable = Boolean(effectsError);
  return <Modal title="音效" onClose={onClose} className="effects-modal">
    <div className="effects-track">
      <Cover track={current} size={42} />
      <div className="effects-track-meta"><strong title={current?.title}>{current?.title ?? '声迹'}</strong><span>{current?.artist ?? '未选择音乐'}</span></div>
      <span className="effects-state">{effects.enabled ? AUDIO_PRESET_NAMES[effective.preset] : '原始音频'}</span>
      <EffectSwitch label="启用音效" checked={effects.enabled} disabled={unavailable} onChange={(enabled) => player.setAudioEffects({ enabled })} />
    </div>
    {effectsError && <p className="effects-error" role="alert">{effectsError}</p>}
    <div className="effects-preset-row">
      <label htmlFor="audio-preset">音色</label>
      <span className="select-wrap"><select id="audio-preset" aria-label="音色预设" disabled={!effects.enabled || unavailable} value={effects.preset} onChange={(event) => {
        const preset = event.target.value as AudioPreset;
        player.setAudioEffects({ preset, ...(preset === 'custom' ? { bands: effective.bands } : {}) });
      }}>{Object.entries(AUDIO_PRESET_NAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><ChevronDown size={13} /></span>
      {effects.preset === 'auto' && <span className="effects-adapted" aria-label="当前适配音色">{AUDIO_PRESET_NAMES[effective.preset]}</span>}
      <span className="headroom-label tabular" title="按当前均衡器与声场计算的输入增益">输入增益 {effectsHeadroom.toFixed(1)} dB</span>
      <IconButton icon={RotateCcw} label="重置音效" onClick={() => player.setAudioEffects({ ...DEFAULT_AUDIO_EFFECTS, bands: [...DEFAULT_AUDIO_EFFECTS.bands], enabled: effects.enabled, visualizer: effects.visualizer })} />
    </div>
    <div className={`equalizer-editor ${!effects.enabled ? 'disabled' : ''}`}>
      <div className="eq-scale" aria-hidden="true"><span>+12</span><span>0 dB</span><span>-12</span></div>
      <div className="eq-bands">
        {EQ_FREQUENCIES.map((frequency, index) => <label className="eq-band" key={frequency}>
          <output className="tabular">{effective.bands[index] > 0 ? '+' : ''}{effective.bands[index].toFixed(1)}</output>
          <input className="eq-slider" type="range" aria-label={`均衡器 ${frequency} Hz`} aria-valuetext={`${effective.bands[index]} dB`} min={-12} max={12} step={0.5} value={effective.bands[index]} disabled={!effects.enabled || unavailable} onChange={(event) => player.setBand(index, Number(event.target.value))} />
          <span>{frequency >= 1000 ? `${frequency / 1000}k` : frequency}</span>
        </label>)}
      </div>
    </div>
    <div className="effects-controls">
      <div className="stereo-control"><label htmlFor="stereo-width">声场</label><input id="stereo-width" aria-label="立体声宽度" className="range" type="range" min={0} max={1.5} step={0.05} value={effects.width} disabled={!effects.enabled || unavailable} style={{ '--range-progress': `${effects.width / 1.5 * 100}%` } as React.CSSProperties} onChange={(event) => player.setAudioEffects({ width: Number(event.target.value) })} /><output className="tabular">{Math.round(effects.width * 100)}%</output></div>
      <div className="effects-toggle"><span>动态压缩</span><EffectSwitch label="动态压缩" checked={effects.compressor || effective.preset === 'night'} disabled={!effects.enabled || effective.preset === 'night' || unavailable} onChange={(compressor) => player.setAudioEffects({ compressor })} /></div>
      <div className="effects-toggle"><span>频谱动画</span><EffectSwitch label="频谱动画" checked={effects.visualizer} onChange={(visualizer) => player.setAudioEffects({ visualizer })} /></div>
    </div>
    <div className="effects-monitor"><div><span>频谱</span><span>{status === 'playing' ? '播放中' : status === 'loading' ? '加载中' : '已暂停'}</span></div><Spectrum /></div>
  </Modal>;
}
