import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, ticksPerBar } from '../src/session.js';
import { completeNote } from '../src/model.js';
import { PROGRESSION_KEYS, parseChordSymbol, chordTimeline } from '../src/progression.js';
import { NAMED_PROGRESSIONS, namedProgression, namedProgressionPatch } from '../src/studio-progressions.js';
import { chordToneRoles, fretboardContext } from '../src/studio-fretboard.js';

const expected = [
  ['blues-major', 12, ['C7', 'C7', 'C7', 'C7', 'F7', 'F7', 'C7', 'C7', 'G7', 'F7', 'C7', 'G7']],
  ['blues-minor', 12, ['Cm7', 'Cm7', 'Cm7', 'Cm7', 'Fm7', 'Fm7', 'Cm7', 'Cm7', 'Ab7', 'G7', 'Cm7', 'G7']],
  ['ii-v-i', 3, ['Dm7', 'G7', 'Cmaj7']],
  ['i-v-vi-iv', 4, ['C', 'G', 'Am', 'F']],
  ['i-vi-iv-v', 4, ['C', 'Am', 'F', 'G']],
  ['vi-iv-i-v', 4, ['Am', 'F', 'C', 'G']],
  ['i-iv-v', 3, ['C', 'F', 'G']],
  ['minor-descent', 4, ['Cm', 'Bb', 'Ab', 'G7']],
];

test('named recipes expose exact lengths, qualities and one chord per bar', () => {
  assert.equal(NAMED_PROGRESSIONS.length, 8);
  for (const [id, bars, symbols] of expected) {
    const progression = namedProgression(id, 'c-major');
    assert.equal(progression.cycleBars, bars); assert.equal(progression.enabled, true);
    assert.deepEqual(progression.chords.map(chord => chord.symbol), symbols);
    assert.deepEqual(progression.chords.map(chord => chord.startBar), Array.from({ length: bars }, (_, i) => i));
    assert.ok(progression.chords.every(chord => chord.durationBars === 1));
    assert.ok(createSession({ bars, loop: { startBar: 0, endBar: bars }, progression }));
  }
});

test('minor templates have literal major-third dominant V7 leading back to tonic in all keys', () => {
  for (const key of PROGRESSION_KEYS.filter(key => key.mode === 'minor')) {
    for (const id of ['blues-minor', 'minor-descent']) {
      const progression = namedProgression(id, key.id); const dominant = progression.chords.at(-1);
      assert.equal(dominant.root, (key.pitchClass + 7) % 12);
      assert.equal(dominant.quality, '7'); assert.equal(dominant.function, 'dominant');
      const tones = dominant.notes.map(note => note.midi % 12);
      assert.ok(tones.includes((key.pitchClass + 11) % 12));
      assert.ok(!tones.includes((key.pitchClass + 10) % 12));
      assert.equal(progression.chords[0].root, key.pitchClass);
      assert.ok(progression.chords.every(chord => chord.source !== 'diatonic'));
    }
  }
});

test('mismatch needs explicit consent; resizing up preserves all phrase/drum/form data atomically', () => {
  const session = createSession({ bars: 4, loop: { startBar: 1, endBar: 4 }, notes: [completeNote({ id: 'kept', start: 4, duration: 2, pitch: 52 })], drums: { edits: [{ voice: 'kick', start: 2, velocity: null }] }, form: { sections: [{ id: 'a', name: 'A', startBar: 0, endBar: 4, repeats: 1, kind: 'A' }] } });
  const before = structuredClone(session);
  assert.ok(namedProgressionPatch(session, 'blues-major', 'exact').error);
  const result = namedProgressionPatch(session, 'blues-major', 'resize');
  assert.ok(result.patch); assert.equal(result.patch.bars, 12);
  assert.deepEqual(result.patch.loop, { startBar: 1, endBar: 12 });
  const next = createSession({ ...session, ...result.patch });
  assert.deepEqual(next.notes, session.notes); assert.deepEqual(next.drums, session.drums); assert.deepEqual(next.form, session.form);
  assert.equal(next.progression.chords.length, 12); assert.deepEqual(session, before);
});

test('shrinking refuses note sustains, drum tombstones and form bounds; repeat/cut changes only harmony', () => {
  const basic = createSession({ bars: 12, loop: { startBar: 0, endBar: 12 } });
  const measure = ticksPerBar(basic);
  const variants = [
    createSession({ ...basic, notes: [completeNote({ id: 'tail', start: 2 * measure, duration: 2 * measure, pitch: 52 })] }),
    createSession({ ...basic, drums: { ...basic.drums, edits: [{ voice: 'kick', start: 4 * measure, velocity: null }] } }),
    createSession({ ...basic, form: { sections: [{ id: 'tail', name: 'Final', startBar: 4, endBar: 12, repeats: 1, kind: 'end' }] } }),
  ];
  for (const session of variants) {
    const before = structuredClone(session);
    assert.match(namedProgressionPatch(session, 'ii-v-i', 'resize').error, /Nenhum dado/);
    const { patch } = namedProgressionPatch(session, 'ii-v-i', 'repeat-cut');
    assert.deepEqual(Object.keys(patch), ['progression']);
    assert.equal(patch.progression.cycleBars, 12); assert.equal(patch.progression.chords.length, 12);
    assert.deepEqual(createSession({ ...session, ...patch }).notes, session.notes);
    assert.deepEqual(session, before);
  }
  const short = createSession({ bars: 4, loop: { startBar: 0, endBar: 4 } });
  const cut = namedProgressionPatch(short, 'blues-major', 'repeat-cut');
  assert.equal(cut.patch.progression.chords.length, 4);
  assert.ok(cut.patch.progression.chords.every(chord => chord.startBar + chord.durationBars <= 4));
});

test('fretboard roles describe actual suspended, altered and seventh tones', () => {
  assert.deepEqual([...chordToneRoles(parseChordSymbol('Csus4'))], [[0, 'T'], [5, '4'], [7, '5']]);
  assert.ok(![...chordToneRoles(parseChordSymbol('Csus2')).values()].includes('3'));
  assert.deepEqual([...chordToneRoles(parseChordSymbol('Cm7b5'))], [[0, 'T'], [3, '♭3'], [6, '♭5'], [10, '♭7']]);
  assert.equal(chordToneRoles(parseChordSymbol('C7b9')).get(1), '♭9');
  assert.equal(chordToneRoles(parseChordSymbol('C/D')).get(2), 'baixo');
});

test('fretboard follows audio source position through fractional starts, repeats and silent gaps', () => {
  const chord = { ...parseChordSymbol('Dsus4'), startBar: 0.5, durationBars: 0.5 };
  const session = createSession({ bars: 4, loop: { startBar: 0, endBar: 4 }, progression: { keyId: 'c-major', enabled: true, cycleBars: 2, chords: [chord] } });
  const events = chordTimeline(session); const measure = ticksPerBar(session);
  const selected = parseChordSymbol('Am');
  assert.match(fretboardContext(session, selected, events, { mode: 'idle', tick: 0 }).title, /Am.*selecionado/);
  for (const bar of [0.5, 2.5]) assert.match(fretboardContext(session, selected, events, { mode: 'loop', tick: bar * measure }).title, /Dsus4.*tocando/);
  for (const bar of [0, 1, 2, 3]) {
    const value = fretboardContext(session, selected, events, { mode: 'loop', tick: bar * measure });
    assert.match(value.title, /escala.*sem acorde/);
    assert.deepEqual([...value.roles.keys()], [0, 2, 4, 5, 7, 9, 11]);
  }
  assert.match(fretboardContext(session, null, [], { mode: 'idle', tick: 0 }).title, /escala/);
  assert.match(fretboardContext(session, selected, events, { mode: 'train', tick: 0.5 * measure }, true).title, /Am.*selecionado/);
});
