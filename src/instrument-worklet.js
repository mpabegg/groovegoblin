import { createOnsetState, detectOnsets, selectInputSample } from './instrument-onsets.js';

class InstrumentOnsets extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.state = createOnsetState(sampleRate);
    this.settings = { channel: 'sum', sensitivity: 1, refractory: 0.05, ...options.processorOptions };
    this.samples = new Float32Array(128);
    this.lastMeter = -Infinity;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'settings') Object.assign(this.settings, data.settings);
    };
  }
  process(inputs, outputs) {
    const channels = inputs[0];
    const size = channels[0]?.length ?? outputs[0]?.[0]?.length ?? 128;
    if (this.samples.length !== size) this.samples = new Float32Array(size);
    for (let i = 0; i < size; i++) this.samples[i] = selectInputSample(channels, i, this.settings.channel);
    const detected = detectOnsets(this.state, this.samples, { ...this.settings, frame: currentFrame });
    this.state = detected.state;
    if (detected.events.length || currentFrame - this.lastMeter >= sampleRate / 30) {
      this.port.postMessage({ events: detected.events, level: detected.level, channels: channels.length });
      this.lastMeter = currentFrame;
    }
    // Silent output keeps the graph processing; microphone is NEVER monitored.
    return true;
  }
}
registerProcessor('instrument-onsets', InstrumentOnsets);
