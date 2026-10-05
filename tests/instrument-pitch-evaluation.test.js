import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstrumentPitchEvaluation, classifyInstrumentPitch, instrumentPitchAvailable, instrumentPitchLabel, instrumentPitchCounts, INSTRUMENT_PITCH_TAIL_SECONDS } from '../src/instrument-pitch-evaluation.js';
import { createPitchStream } from '../src/instrument-pitch.js';
import { createOnsetState, detectOnsets } from '../src/instrument-onsets.js';
import { instrumentSession, InstrumentInputGate } from '../src/instrument-input.js';
import { createSession, serializeSession } from '../src/session.js';
import { evaluateSession, summarizeFeedback } from '../src/feedback.js';
import { captureFrameTime, compensatedTime, inputTailSeconds } from '../src/input-timing.js';
import { harness, close } from './audio-harness.js';

const frequency = (midi, cents = 0) => 440 * 2 ** ((midi - 69) / 12 + cents / 1200);
function session(notes, training = {}) {
  return createSession({ bpm: 120, bars: 1, notes,
    training: { goal: 'pitch', countInBars: 0, repetitions: 1, monitor: true, ...training },
    metronome: { enabled: false }, drums: { enabled: false }, band: { bassEnabled: false },
    progression: { enabled: false }, companion: { enabled: false } });
}
const attack = (frame, captureId = 1, sampleRate = 8000) => ({ frame, captureId, sampleRate, id: `${captureId}:${frame}`, time: frame / sampleRate * 1000 });
const reading = (startFrame, endFrame, midi = 69, confidence = 0.99, captureId = 1, sampleRate = 8000) => ({ startFrame, endFrame, frame: (startFrame + endFrame) / 2, frequency: frequency(midi), confidence, captureId, sampleRate });

test('inclusive ±50 cents, octave differences and low confidence have separate consumer-visible classifications', () => {
  for (const cents of [-50, 50, -49.99, 49.99]) assert.equal(classifyInstrumentPitch({ frequency: frequency(40, cents), confidence: 0.85 }, 40).pitchStatus, 'correct');
  for (const cents of [-50.001, 50.001, -100, 100]) assert.equal(classifyInstrumentPitch({ frequency: frequency(40, cents), confidence: 1 }, 40).pitchStatus, 'wrong');
  for (const octaves of [-2, -1, 1, 2]) for (const cents of [-50, 0, 50]) assert.equal(classifyInstrumentPitch({ frequency: frequency(40 + 12 * octaves, cents), confidence: 0.95 }, 40).pitchStatus, 'octave');
  for (const estimate of [null, { frequency: 440, confidence: 0.849999 }, { frequency: null, confidence: 1 }, { frequency: Infinity, confidence: 1 }, { frequency: 440, confidence: NaN }]) {
    assert.deepEqual(classifyInstrumentPitch(estimate, 69), { pitchStatus: 'unidentified', pitchOk: null, pitchCents: null });
  }
});

test('Instrument enables pitch only for a non-overlapping reference, without mutating saved keyboard settings', () => {
  const source = session([{ id: 'a', start: 0, duration: 2, pitch: 40 }, { id: 'b', start: 4, duration: 2, pitch: 45 }]);
  const before = serializeSession(source);
  assert.equal(instrumentPitchAvailable(source), true);
  assert.equal(instrumentSession(source).training.goal, 'pitch');
  assert.equal(serializeSession(source), before);
  assert.equal(instrumentSession(session(source.notes, { goal: 'duration' })).training.goal, 'timing');
  for (const invalid of [session([]), session(source.notes, { evaluation: 'free' }), session([{ id: 'a', start: 0, duration: 4, pitch: 40, offsetMs: 80 }, { id: 'b', start: 4, duration: 4, pitch: 45, offsetMs: -80 }])]) {
    assert.equal(instrumentPitchAvailable(invalid), false);
    assert.equal(instrumentSession(invalid).training.goal, 'timing');
  }
});

test('disjoint source windows associate with stable attack IDs, never the latest held note or expected pitch', () => {
  const evaluator = new InstrumentPitchEvaluation(); evaluator.start();
  const a = { start: 0, end: 0.1, pitch: null }, b = { start: 0.25, end: 0.35, pitch: null };
  evaluator.attack(attack(800), a); evaluator.attack(attack(2800), b);
  evaluator.pitch(reading(960, 2240, 40)); // Already released; still belongs to a.
  evaluator.pitch(reading(2640, 3920, 69)); // Crosses b: cannot reuse old certainty.
  assert.equal(a.attackId, '1:800'); assert.equal(a.pitchEstimate.frequency, frequency(40)); assert.equal(b.pitchEstimate, null);
  evaluator.pitch(reading(2960, 4240, 52)); assert.equal(b.pitchEstimate.frequency, frequency(52));
  const result = evaluateSession(instrumentSession(session([{ id: 'a', start: 0, duration: 1, pitch: 41 }, { id: 'b', start: 2, duration: 1, pitch: 40 }])), [a, b]);
  assert.deepEqual(result.rows.map(row => row.pitchStatus), ['wrong', 'octave']);
  assert.equal(result.rows[0].onsetMs, 0, 'pitch midpoint never shifts the rhythm attack');
  assert.equal(instrumentPitchLabel(result.rows[0]), 'Nota errada · -100 cents');
  assert.equal(instrumentPitchLabel(result.rows[1]), 'Oitava diferente · +1200 cents');
  assert.match(instrumentPitchCounts(summarizeFeedback(result)), /0 certa\(s\).*1 errada\(s\).*0 não identificada\(s\).*1 com oitava diferente/);
});

test('only the first confident complete post-transient window is chosen, independent of callback order', () => {
  const evaluator = new InstrumentPitchEvaluation(); evaluator.start();
  const attempt = { start: 0, end: 0.1, pitch: null }; evaluator.attack(attack(800), attempt);
  evaluator.pitch(reading(800, 2080)); assert.equal(attempt.pitchEstimate, null, 'transient window rejected');
  evaluator.pitch(reading(960, 2240, 69, 0.8)); assert.equal(attempt.pitchEstimate, null, 'low confidence is unknown, not a guessed expected note');
  evaluator.pitch(reading(1360, 2640, 71)); evaluator.pitch(reading(960, 2240, 70));
  assert.equal(attempt.pitchEstimate.frequency, frequency(70), 'earliest confident full window, not highest confidence or closest expected note');
  evaluator.pitch(reading(2560, 3840, 69)); assert.equal(attempt.pitchEstimate.frequency, frequency(70), 'a later held note cannot replace attack pitch');
  const result = evaluateSession(instrumentSession(session([{ id: 'a', start: 0, duration: 1, pitch: 69 }])), [attempt]);
  assert.equal(result.rows[0].pitchStatus, 'wrong');
});

test('a following attack closes a region even when rejected, invalidating a previously crossing window', () => {
  const evaluator = new InstrumentPitchEvaluation(); evaluator.start();
  const attempt = { start: 0, end: 0.1, pitch: null }; evaluator.attack(attack(800), attempt);
  evaluator.pitch(reading(960, 2240)); assert.ok(attempt.pitchEstimate);
  evaluator.attack(attack(2000), undefined); assert.equal(attempt.pitchEstimate, null);
  evaluator.pitch(reading(960, 2240)); assert.equal(attempt.pitchEstimate, null);
  evaluator.pitch(reading(2160, 3440)); assert.equal(attempt.pitchEstimate, null, 'rejected next attack is not assigned backward');
});

test('exclusive window end may meet the next attack exactly, without overlapping either estimate', () => {
  const evaluator = new InstrumentPitchEvaluation(); evaluator.start();
  const a = { start: 0, end: 0.1, pitch: null }, b = { start: 0.18, end: 0.3, pitch: null };
  evaluator.attack(attack(800), a); evaluator.attack(attack(2240), b);
  evaluator.pitch(reading(960, 2240, 40)); evaluator.pitch(reading(2360, 3640, 45));
  assert.equal(a.pitchEstimate.frequency, frequency(40)); assert.equal(b.pitchEstimate.frequency, frequency(45));
  assert.equal(a.pitchEstimate.endFrame, 2240); assert.equal(b.pitchEstimate.startFrame, 2360);
});

test('stale capture IDs, sample rates, reset, stopped sentinel and old-run callbacks cannot mutate completed attempts', () => {
  const evaluator = new InstrumentPitchEvaluation(); evaluator.start();
  const attempt = { start: 0, end: 0.1, pitch: null }; evaluator.attack(attack(800), attempt);
  evaluator.pitch(reading(960, 2240, 69, 1, 0)); evaluator.pitch(reading(960, 2240, 69, 1, 1, 44100));
  assert.equal(attempt.pitchEstimate, null);
  evaluator.pitch(reading(960, 2240, 69)); evaluator.reset();
  const frozen = JSON.stringify(attempt);
  evaluator.pitch(reading(960, 2240, 71)); assert.equal(JSON.stringify(attempt), frozen);
  evaluator.start(); const next = { start: 0, end: 0.1, pitch: null }; evaluator.attack(attack(4000, 2), next);
  evaluator.pitch(reading(4160, 5440, 71, 1, 1)); assert.equal(next.pitchEstimate, null);
  evaluator.pitch({ stopped: true }); evaluator.pitch(reading(4160, 5440, 71, 1, 2));
  assert.equal(next.pitchEstimate, null); assert.equal(JSON.stringify(attempt), frozen);
});

function sequence(rate, midiNotes, { start = 0.1, interval = 0.5, length = 0.4, weak = false, noiseOnlyIndex = -1 } = {}) {
  const samples = new Float32Array(Math.ceil(rate * (start + interval * (midiNotes.length - 1) + length + 0.05)));
  let seed = 83;
  for (let n = 0; n < midiNotes.length; n++) {
    const beginning = Math.round((start + n * interval) * rate);
    for (let i = 0; i < length * rate; i++) {
      const time = i / rate, envelope = Math.min(1, time / 0.015) * Math.exp(-time / 1.2);
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      samples[beginning + i] = (seed / 4294967296 * 2 - 1) * (n === noiseOnlyIndex ? 0.3 : 0.001) * envelope;
      if (n !== noiseOnlyIndex) for (const [h, amplitude] of (weak ? [0.025, 0.32, 0.16, 0.05] : [0.3, 0.18, 0.12]).entries()) {
        samples[beginning + i] += amplitude * envelope * Math.sin(2 * Math.PI * (h + 1) * frequency(midiNotes[n]) * time + 0.37 * (h + 1));
      }
    }
  }
  return samples;
}

for (const [instrumentType, notes] of [['guitar', [40, 45, 50, 55]], ['bass', [23, 28, 33, 43]]]) for (const weak of [false, true]) {
  test(`real ${instrumentType} harmonic ${weak ? 'weak-fundamental' : 'plucked'} PCM sequence reaches the report through onset, pitch stream, gate and audio clock`, async t => {
    let finished, evaluator = new InstrumentPitchEvaluation();
    const h = harness(t, { onFinish: (attempts, detail) => { evaluator.reset(); finished = { attempts, result: evaluateSession(detail.session, attempts) }; } });
    h.ctx.getOutputTimestamp = () => ({ contextTime: h.ctx.currentTime - 0.035, performanceTime: h.ctx.currentTime * 1000 });
    const inputLatencySeconds = 0.017, compensationMs = 23, rate = 8000;
    const source = session(notes.map((pitch, i) => ({ id: `n${i}`, start: i * 4, duration: 1, pitch })));
    await h.audio.playSession(instrumentSession(source, { compensationMs }), { mode: 'train', inputTailSeconds: inputTailSeconds({ instrument: true, inputLatencySeconds, compensationMs }) + INSTRUMENT_PITCH_TAIL_SECONDS });
    const gate = new InstrumentInputGate(h.audio); t.after(() => gate.reset()); evaluator.start();
    // Anchor 60 ms + output 35 ms + declared input 17 ms + residual 23 ms.
    const pcm = sequence(rate, notes, { start: 0.135, weak });
    let state = createOnsetState(rate); const stream = createPitchStream(rate); let attacks = 0;
    for (let offset = 0; offset < pcm.length; offset += 160) {
      h.advance((offset + 160) / rate);
      const block = pcm.subarray(offset, offset + 160);
      const detected = detectOnsets(state, block, { instrumentType, refractory: 0.05 }); state = detected.state;
      for (const event of detected.events) {
        const time = captureFrameTime(event.frame, rate, { contextTime: h.ctx.currentTime, performanceTime: performance.now() }, inputLatencySeconds);
        const actual = { ...attack(event.frame, 1, rate), time };
        evaluator.attack(actual, gate.attack(compensatedTime(time, compensationMs))); attacks++;
      }
      stream.push(block, offset, pitch => evaluator.pitch({ ...pitch, captureId: 1, sampleRate: rate }));
    }
    h.advance(2.6);
    assert.equal(attacks, 4, 'no false harmonic/ramp/release attacks'); assert.ok(finished);
    assert.equal(finished.attempts.length, 4);
    assert.deepEqual(finished.result.rows.map(row => row.pitchStatus), ['correct', 'correct', 'correct', 'correct']);
    const summary = summarizeFeedback(finished.result);
    assert.equal(summary.pitchCorrect, 4); assert.equal(summary.attackOk, 4); assert.equal(summary.missed, 0); assert.equal(summary.extra, 0);
    for (let i = 0; i < 4; i++) close(finished.attempts[i].start, i * 0.5, 0.01);
    assert.equal(h.ctx.sources.length, 0, 'no instrument monitor copies or extra capture');
  });
}

test('real PCM wrong note, octave and noisy unknown cannot be corrected toward the reference', () => {
  const evaluator = new InstrumentPitchEvaluation(); evaluator.start();
  const attempts = [40, 42, 52, 45].map((pitch, index) => ({ start: index * 0.5, end: index * 0.5 + 0.125, pitch: null }));
  const rate = 8000, pcm = sequence(rate, [40, 42, 52, 45], { noiseOnlyIndex: 3 });
  for (let index = 0; index < attempts.length; index++) evaluator.attack(attack(Math.round((0.1 + index * 0.5) * rate)), attempts[index]);
  const stream = createPitchStream(rate);
  for (let offset = 0; offset < pcm.length; offset += 160) stream.push(pcm.subarray(offset, offset + 160), offset, pitch => evaluator.pitch({ ...pitch, captureId: 1, sampleRate: rate }));
  const result = evaluateSession(instrumentSession(session([40, 40, 40, 45].map((pitch, i) => ({ id: `n${i}`, start: i * 4, duration: 1, pitch })))), attempts);
  assert.deepEqual(result.rows.map(row => row.pitchStatus), ['correct', 'wrong', 'octave', 'unidentified']);
  const summary = summarizeFeedback(result);
  assert.equal(summary.pitchCorrect, 1); assert.equal(summary.pitchWrong, 1); assert.equal(summary.pitchOctave, 1); assert.equal(summary.pitchUnidentified, 1);
  assert.equal(summary.pitchChecked, 3); assert.equal(summary.pitchOk, 1);
  assert.equal(instrumentPitchLabel(result.rows[3]), 'Não identificada');
});

test('final attack receives actual PCM pitch after written release and musical end, then late callbacks cannot alter the finished report', async t => {
  const evaluator = new InstrumentPitchEvaluation(); let finished;
  const h = harness(t, { onFinish: (attempts, detail) => { evaluator.reset(); finished = { attempts, result: evaluateSession(detail.session, attempts) }; } });
  const source = session([{ id: 'last', start: 15.92, duration: 0.08, pitch: 40 }]);
  const tail = inputTailSeconds({ instrument: true }) + INSTRUMENT_PITCH_TAIL_SECONDS;
  await h.audio.playSession(instrumentSession(source), { mode: 'train', inputTailSeconds: tail });
  const gate = new InstrumentInputGate(h.audio); t.after(() => gate.reset()); evaluator.start();
  const time = 2050, rate = 8000; h.advance(2.05);
  evaluator.attack(attack(time / 1000 * rate), gate.attack(time));
  h.advance(2.08); assert.equal(h.audio.position.held, false); assert.equal(finished, undefined);
  const stream = createPitchStream(rate), pcm = sequence(rate, [40], { start: 0, length: 0.3 });
  const delivered = [];
  h.advance(2.34); assert.equal(finished, undefined, 'analysis tail remains open');
  stream.push(pcm, time / 1000 * rate, pitch => { const event = { ...pitch, captureId: 1, sampleRate: rate }; delivered.push(event); evaluator.pitch(event); });
  h.advance(2.5); assert.ok(finished);
  assert.equal(finished.attempts.length, 1); assert.equal(finished.result.rows[0].pitchStatus, 'correct');
  close(finished.attempts[0].start, 1.99); close(finished.attempts[0].end, 2);
  const report = JSON.stringify(finished);
  for (const event of delivered) evaluator.pitch({ ...event, frequency: frequency(43), confidence: 1 });
  evaluator.attack(attack(2100 / 1000 * rate), h.audio.press(2100, null, { monitor: false }));
  assert.equal(JSON.stringify(finished), report, 'completed attempts/report detached from capture callbacks');
});

test('keyboard exact MIDI and measured release retain their previous semantics', () => {
  const source = session([{ id: 'a', start: 0, duration: 4, pitch: 69 }]);
  const result = evaluateSession(source, [{ start: 0, end: 0.5, pitch: 81 }]);
  assert.equal(result.rows[0].pitchOk, false); assert.equal(result.rows[0].pitchStatus, undefined);
  assert.equal(result.rows[0].ending, 'ok'); assert.equal(result.instrument, false);
});
