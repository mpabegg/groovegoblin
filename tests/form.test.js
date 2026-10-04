import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, validateSession } from '../src/session.js';
import { compileBarPlan, normalizeForm } from '../src/form.js';
import { parseChordSymbol } from '../src/progression.js';
import { close } from './audio-harness.js';

const section = (patch = {}) => ({ id: 'a', name: 'A', kind: 'A', startBar: 0, endBar: 1, repeats: 1, bpm: null, meter: null, density: null, ...patch });
const make = patch => createSession({ bars: 2, bpm: 120, notes: [{ id: 'a', start: 4, duration: 2, pitch: 64, articulation: 'accent' }, { id: 'b', start: 20, duration: 4, pitch: 72 }], metronome: { enabled: false }, ...patch });

test('form is canonical but disabled in old sessions; validation is strict at every boundary', () => {
  const base = make(); assert.deepEqual(base.form, { enabled: false, loop: true, sections: [] });
  for (const bad of [null, [], { enabled: true }, { loop: 'yes' }, { extra: true }, { sections: [section({ repeats: 0 })] }, { sections: [section({ bpm: 301 })] }, { sections: [section({ startBar: 1, endBar: 1 })] }, { sections: [section({ endBar: 3 })] }, { sections: [section({ density: 'loud' })] }, { sections: [section({ meter: { beats: 0, unit: 8 } })] }, { sections: [section({ meter: { beats: 3, unit: 3 } })] }, { sections: [section(), section()] }]) {
    assert.equal(validateSession({ ...base, form: bad }).ok, false, JSON.stringify(bad));
  }
  assert.equal(normalizeForm({ sections: [section({ repeats: 16, bpm: 300, meter: { beats: 16, unit: 16 } })] }, 2).sections[0].repeats, 16);
});

test('ordered sections, source ranges and repeats compile to real bar durations', () => {
  const session = make({ form: { enabled: true, loop: false, sections: [section({ startBar: 1, endBar: 2, repeats: 2, bpm: 60, meter: { beats: 7, unit: 8 } }), section({ id: 'b', bpm: 240 })] } });
  const plan = compileBarPlan(session);
  assert.deepEqual(plan.bars.map(bar => bar.sourceBar), [1, 1, 0]);
  assert.deepEqual(plan.bars.map(bar => bar.sectionRepeat), [1, 2, 1]);
  assert.deepEqual(plan.bars.map(bar => bar.start), [0, 3.5, 7]);
  close(plan.duration, 8); assert.equal(plan.loop, false);
  assert.equal(plan.locate(3.5).index, 1); assert.equal(plan.locate(7).bar.sectionId, 'b');
  assert.equal(plan.locate(8).index, 3); close(plan.timeAt(4), 11.5);
});

test('meter overrides preserve bar-relative note positions, lengths, pitches and articulation', () => {
  const plan = compileBarPlan(make({ form: { enabled: true, sections: [section({ meter: { beats: 3, unit: 8 } })] } }));
  const note = plan.bars[0].events().find(event => event.channel === 'phrase');
  close(note.tick, 1.5); close(note.duration, 0.75);
  assert.equal(note.pitch, 64); assert.equal(note.articulation, 'accent');
  close(note.tick * plan.bars[0].secPerTick, 0.1875);
});

test('meter override clicks use destination denominator beats and gap cycle', () => {
  const session = make({ metronome: { enabled: true, audibleBars: 1, silentBars: 1 }, form: { enabled: true, sections: [section({ meter: { beats: 7, unit: 16 }, repeats: 2 })] } });
  const plan = compileBarPlan(session);
  assert.deepEqual(plan.bars[0].events().filter(event => event.kind === 'click').map(event => event.tick), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(plan.bars[1].events().filter(event => event.kind === 'click').length, 0);
});

test('training and form-disabled arrangement retain the selected source loop', () => {
  const session = make({ loop: { startBar: 1, endBar: 2 }, form: { enabled: true, loop: false, sections: [section({ bpm: 30, repeats: 16 })] } });
  const train = compileBarPlan(session, { training: true });
  const plain = compileBarPlan({ ...session, form: { ...session.form, enabled: false } });
  for (const plan of [train, plain]) { assert.equal(plan.bars.length, 1); assert.equal(plan.bars[0].sourceBar, 1); close(plan.duration, 2); assert.equal(plan.loop, true); }
});

test('intro/break/fill/end cause actual role changes; density and inherited settings are audible events', () => {
  const base = make({ drums: { enabled: true, style: 'pop' }, band: { bassEnabled: true, style: 'pop' }, progression: { enabled: true, chords: [parseChordSymbol('C')] } });
  const events = patch => compileBarPlan({ ...base, form: { enabled: true, loop: true, sections: [section(patch)] } }).bars[0].events();
  const regular = events({});
  assert.ok(regular.some(event => event.channel === 'bass' && event.tick > 0));
  assert.ok(events({ kind: 'intro' }).every(event => event.channel !== 'phrase' && event.tick === 0));
  assert.ok(events({ kind: 'break' }).every(event => event.channel === 'phrase'));
  const ending = events({ kind: 'end' });
  assert.ok(ending.every(event => event.channel === 'phrase' || event.tick === 0));
  assert.deepEqual(events({ kind: 'fill' }).filter(event => event.channel === 'drums' && event.tick >= 12).map(event => event.tick), [12, 13, 14, 15]);
  assert.notDeepEqual(events({ density: 'sparse' }), events({ density: 'busy' }));
  assert.deepEqual(events({ density: null }), regular);
});

test('section bounds contain crossbar sustains and tiny-meter microtiming', () => {
  const source = make({ notes: [{ id: 'long', start: 12, duration: 12, pitch: 60, offsetMs: 80 }] });
  const bar = compileBarPlan({ ...source, form: { enabled: true, loop: false, sections: [section({ meter: { beats: 1, unit: 16 }, bpm: 300 })] } }).bars[0];
  assert.equal(bar.events().filter(event => event.channel === 'phrase').length, 0, 'attack outside finite section is omitted');
  const start = make({ notes: [{ id: 'early', start: 0, duration: 2, offsetMs: -80 }] });
  const early = compileBarPlan({ ...start, form: { enabled: true, loop: false, sections: [section()] } }).bars[0].events()[0];
  close(early.offsetMs, 0);
  const rootLoop = compileBarPlan(start);
  close(rootLoop.at(0).events()[0].offsetMs, -80);
  close(rootLoop.at(2).events({ barIndex: 2 })[0].offsetMs, -80);
  const training = compileBarPlan(start, { training: true });
  close(training.at(0).events()[0].offsetMs, 0);
  close(training.at(2).events({ barIndex: 2 })[0].offsetMs, -80);
});

test('deleting/reordering real sections changes the resulting source audio sequence', () => {
  const a = section(); const b = section({ id: 'b', startBar: 1, endBar: 2 }); const base = make();
  const pitches = sections => compileBarPlan({ ...base, form: { enabled: true, loop: true, sections } }).bars.flatMap(bar => bar.events().filter(event => event.channel === 'phrase').map(event => event.pitch));
  assert.deepEqual(pitches([a, b]), [64, 72]); assert.deepEqual(pitches([b, a]), [72, 64]); assert.deepEqual(pitches([b]), [72]);
});

test('training reference clips only capturable endpoints and omits onsets after final boundary', () => {
  const session = createSession({ bpm: 120, meter: { beats: 3, unit: 16 }, training: { repetitions: 2 }, metronome: { enabled: false },
    notes: [{ id: 'early', start: 0, duration: 1, offsetMs: -80 }, { id: 'late', start: 2.8, duration: 0.2, offsetMs: 80 }] });
  const plan = compileBarPlan(session, { training: true });
  const first = plan.at(0).events({ barIndex: 0 });
  close(first[0].offsetMs, 0); close(first[0].duration * plan.at(0).secPerTick, 0.045);
  assert.equal(first.length, 2, 'positive offset may cross an intermediate loop seam');
  const last = plan.at(1).events({ barIndex: 1 });
  assert.equal(last.length, 1, 'last late attack lies beyond captured training');
  close(last[0].offsetMs, -80); close(last[0].duration, 1);
});
