import { createOnsetState, detectOnsets, selectInputSample } from './instrument-onsets.js';

class InstrumentOnsets extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.state = createOnsetState(sampleRate);
    this.settings = { channel: 'sum', sensitivity: 1, refractory: 0.05, ...options.processorOptions };
    this.samples = new Float32Array(128);
    this.pitchSamples = new Float32Array(Math.ceil(sampleRate * 0.02));
    this.pitchWritten = 0;
    this.pitchStartFrame = 0;
    this.lastMeter = -Infinity;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'settings') {
        if (data.settings.channel !== undefined || data.settings.pitchEnabled === false) this.pitchWritten = 0;
        Object.assign(this.settings, data.settings);
      }
    };
  }
  process(inputs, outputs) {
    const channels = inputs[0];
    const size = channels[0]?.length ?? outputs[0]?.[0]?.length ?? 128;
    if (this.samples.length !== size) this.samples = new Float32Array(size);
    for (let i = 0; i < size; i++) this.samples[i] = selectInputSample(channels, i, this.settings.channel);
    const detected = detectOnsets(this.state, this.samples, { ...this.settings, frame: currentFrame });
    this.state = detected.state;
    // Send bounded, ephemeral PCM batches; expensive YIN refinement runs off
    // the real-time audio thread. Channel selection is identical to onsets.
    if (this.settings.pitchEnabled) for (let i = 0; i < size; i++) {
      if (!this.pitchWritten) this.pitchStartFrame = currentFrame + i;
      this.pitchSamples[this.pitchWritten++] = this.samples[i];
      if (this.pitchWritten === this.pitchSamples.length) {
        this.port.postMessage({ type: 'samples', samples: this.pitchSamples, startFrame: this.pitchStartFrame, channel: this.settings.channel }, [this.pitchSamples.buffer]);
        this.pitchSamples = new Float32Array(Math.ceil(sampleRate * 0.02));
        this.pitchWritten = 0;
      }
    }
    if (detected.events.length || currentFrame - this.lastMeter >= sampleRate / 30) {
      this.port.postMessage({ events: detected.events, level: detected.level, channels: channels.length });
      this.lastMeter = currentFrame;
    }
    // Silent output keeps the graph processing; microphone is NEVER monitored.
    return true;
  }
}
registerProcessor('instrument-onsets', InstrumentOnsets);
