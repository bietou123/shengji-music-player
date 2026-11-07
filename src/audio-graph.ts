import { effectiveEffects, EQ_FREQUENCIES, stereoMatrix } from '../shared/audio-effects';
import type { AudioEffectsSettings, Track } from '../shared/types';

export class AudioGraph {
  private context = new AudioContext();
  private preamp = new GainNode(this.context, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  private filters = EQ_FREQUENCIES.map((frequency) => new BiquadFilterNode(this.context, { type: 'peaking', frequency, Q: 1, gain: 0 }));
  private probes = EQ_FREQUENCIES.map((frequency) => new BiquadFilterNode(this.context, { type: 'peaking', frequency, Q: 1, gain: 0 }));
  private compressor = new DynamicsCompressorNode(this.context, { threshold: -24, knee: 24, ratio: 3, attack: 0.012, release: 0.25 });
  private dry = new GainNode(this.context, { gain: 1 });
  private wet = new GainNode(this.context, { gain: 0 });
  private matrix = [1, 0, 0, 1].map((gain) => new GainNode(this.context, { gain, channelCount: 1, channelCountMode: 'explicit' }));
  private analyser = new AnalyserNode(this.context, { fftSize: 2048, smoothingTimeConstant: 0.7, minDecibels: -100, maxDecibels: -15 });
  private frequencies = new Float32Array(this.analyser.frequencyBinCount);
  private waveform = new Float32Array(this.analyser.fftSize);
  private responseFrequencies = Float32Array.from({ length: 512 }, (_, index) => 20 * Math.pow((this.context.sampleRate * 0.49) / 20, index / 511));
  private magnitude = new Float32Array(512);
  private phase = new Float32Array(512);
  private compressionEnabled = false;

  constructor(audio: HTMLAudioElement) {
    const splitter = new ChannelSplitterNode(this.context, { numberOfOutputs: 2 });
    const merger = new ChannelMergerNode(this.context, { numberOfInputs: 2 });
    this.preamp.connect(this.filters[0]);
    this.filters.forEach((filter, index) => { if (index < this.filters.length - 1) filter.connect(this.filters[index + 1]); });
    const last = this.filters.at(-1)!;
    last.connect(this.dry).connect(splitter);
    last.connect(this.compressor).connect(this.wet).connect(splitter);
    for (let i = 0; i < 4; i++) {
      splitter.connect(this.matrix[i], i % 2);
      this.matrix[i].connect(merger, 0, Math.floor(i / 2));
    }
    merger.connect(this.analyser).connect(this.context.destination);
    // Attach once; the same element, graph and effects serve main and mini views.
    this.context.createMediaElementSource(audio).connect(this.preamp);
  }

  async resume(): Promise<void> {
    if (this.context.state === 'suspended') await this.context.resume();
  }

  configure(settings: AudioEffectsSettings, track: Track | null): number {
    const effective = effectiveEffects(settings, track);
    const combined = new Float32Array(512).fill(1);
    effective.bands.forEach((gain, index) => {
      this.probes[index].gain.value = gain;
      this.probes[index].getFrequencyResponse(this.responseFrequencies, this.magnitude, this.phase);
      for (let i = 0; i < combined.length; i++) combined[i] *= this.magnitude[i];
    });
    const boostDb = Math.max(0, 20 * Math.log10(Math.max(...combined)));
    const widthDb = 20 * Math.log10(Math.max(1, effective.width));
    const preampDb = -(boostDb + widthDb + (boostDb + widthDb > 0.01 ? 0.5 : 0));
    const now = this.context.currentTime;
    const ramp = (parameter: AudioParam, value: number, duration = 0.035) => {
      parameter.cancelAndHoldAtTime(now);
      parameter.setTargetAtTime(value, now, duration);
    };
    // Derive headroom from the entire filter cascade, not just its largest band.
    ramp(this.preamp.gain, Math.pow(10, preampDb / 20), 0.02);
    effective.bands.forEach((gain, index) => ramp(this.filters[index].gain, gain));
    stereoMatrix(effective.width).forEach((gain, index) => ramp(this.matrix[index].gain, gain));
    ramp(this.dry.gain, effective.compressor ? 0 : 1);
    ramp(this.wet.gain, effective.compressor ? 1 : 0);
    this.compressionEnabled = effective.compressor;
    return preampDb;
  }

  read() {
    this.analyser.getFloatFrequencyData(this.frequencies);
    this.analyser.getFloatTimeDomainData(this.waveform);
    return { frequencies: this.frequencies, waveform: this.waveform, sampleRate: this.context.sampleRate, compressionDb: this.compressionEnabled ? this.compressor.reduction : 0 };
  }
}
