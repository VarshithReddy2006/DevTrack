export type AmbientPreset = 'rain' | 'white-noise' | 'lo-fi';

export class AmbientEngine {
  private readonly context = new AudioContext();
  private readonly output = this.context.createGain();
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly effects: AudioNode[] = [];
  private active = false;
  private volume = 0;

  constructor() {
    this.output.gain.value = 0;
    this.output.connect(this.context.destination);
  }

  async play(preset: AmbientPreset, volume: number, active: boolean) {
    this.clearSources();
    this.active = active;
    this.setVolume(volume);
    if (preset === 'lo-fi') {
      this.createChord();
    } else {
      this.createNoise(preset);
    }

    // Unlock the context inside the preset click, even if the timer is idle.
    await this.resume();
  }

  setVolume(volume: number) {
    this.volume = volume;
    this.output.gain.setTargetAtTime(this.active ? volume * 0.18 : 0, this.context.currentTime, 0.02);
  }

  async setActive(active: boolean) {
    this.active = active;
    this.setVolume(this.volume);
    if (active) {
      await this.resume();
    } else if (this.context.state === 'running') {
      await this.context.suspend();
    }
  }

  private async resume() {
    await this.context.resume();
    if (!this.active && this.context.state === 'running') {
      await this.context.suspend();
    }
  }

  stop() {
    this.active = false;
    this.clearSources();
    this.output.disconnect();
    void this.context.close().catch(() => undefined);
  }

  private start(source: AudioScheduledSourceNode) {
    source.start();
    this.sources.push(source);
  }

  private clearSources() {
    for (const source of this.sources.splice(0)) {
      source.stop();
      source.disconnect();
    }
    for (const effect of this.effects.splice(0)) {
      effect.disconnect();
    }
  }

  private createNoise(preset: 'rain' | 'white-noise') {
    const rain = preset === 'rain';
    const { sampleRate } = this.context;
    const buffer = this.context.createBuffer(1, sampleRate * 4, sampleRate);
    const samples = buffer.getChannelData(0);
    let brownNoise = 0;
    for (let index = 0; index < samples.length; index++) {
      const whiteNoise = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
      if (rain) {
        brownNoise = (brownNoise + whiteNoise * 0.04) / 1.04;
        samples[index] = brownNoise * 4;
      } else {
        samples[index] = whiteNoise;
      }
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = this.context.createBiquadFilter();
    filter.type = rain ? 'bandpass' : 'lowpass';
    filter.frequency.value = rain ? 950 : 6500;
    source.connect(filter);
    this.effects.push(filter);

    if (rain) {
      const swell = this.context.createGain();
      swell.gain.value = 0.85;
      filter.connect(swell).connect(this.output);
      this.effects.push(swell);
      this.modulate(swell.gain, 0.31, 0.15);
    } else {
      filter.connect(this.output);
    }
    this.start(source);
  }

  private createChord() {
    const mix = this.context.createGain();
    mix.gain.value = 0.11;
    mix.connect(this.output);
    this.effects.push(mix);

    for (const frequency of [130.81, 164.81, 196, 246.94]) {
      const tone = this.context.createOscillator();
      tone.type = 'sine';
      tone.frequency.value = frequency;
      tone.connect(mix);
      this.modulate(tone.detune, frequency / 600, 4);
      this.start(tone);
    }
  }

  private modulate(parameter: AudioParam, frequency: number, depth: number) {
    const oscillator = this.context.createOscillator();
    oscillator.frequency.value = frequency;
    const gain = this.context.createGain();
    gain.gain.value = depth;
    oscillator.connect(gain);
    gain.connect(parameter);
    this.effects.push(gain);
    this.start(oscillator);
  }
}
