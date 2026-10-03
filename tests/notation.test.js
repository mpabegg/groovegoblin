import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRhythmNotation } from '../src/notation.js';

// SVG geometry is exercised with the app's real-browser integration smoke.
// These tests verify musical intervals and attacks, independently of the DOM.
const VALUE_TICKS = { whole: 16, half: 8, quarter: 4, eighth: 2, sixteenth: 1 };
const NOTE_ALIGNMENT = { whole: 16, half: 4, quarter: 4, eighth: 2, sixteenth: 1 };
const REST_ALIGNMENT = { whole: 16, half: 8, quarter: 4, eighth: 2, sixteenth: 1 };

function eventsOf(model) {
  return model.measures.flatMap(measure => measure.events);
}

function assertExactPhrase(notes, bars) {
  const model = buildRhythmNotation(notes, bars);
  assert.equal(model.bars, bars);
  assert.equal(model.measures.length, bars);
  let cursor = 0;
  for (const [index, measure] of model.measures.entries()) {
    assert.equal(measure.index, index + 1);
    assert.ok(measure.events.length > 0);
    for (const event of measure.events) {
      assert.equal(event.start, cursor, 'events cover the phrase without gaps or overlaps');
      assert.ok(Number.isInteger(event.duration) && event.duration > 0);
      assert.equal(event.duration, VALUE_TICKS[event.value] * (event.dotted ? 1.5 : 1));
      const alignment = event.kind === 'rest' ? REST_ALIGNMENT : NOTE_ALIGNMENT;
      assert.equal(event.start % alignment[event.value], 0, 'metrical alignment');
      assert.ok(event.start >= index * 16);
      assert.ok(event.start + event.duration <= (index + 1) * 16, 'a symbol cannot cross a barline');
      assert.equal(typeof event.dotted, 'boolean');
      assert.equal(typeof event.tieFromPrevious, 'boolean');
      assert.equal(typeof event.tieToNext, 'boolean');
      for (let tick = event.start; tick < event.start + event.duration; tick += 1) {
        const original = notes.find(note => tick >= note.start && tick < note.start + note.duration);
        assert.equal(event.kind, original ? 'note' : 'rest', `occupancy at tick ${tick}`);
        assert.equal(event.noteId, original ? original.id : null, `identity at tick ${tick}`);
      }
      if (event.kind === 'rest') {
        assert.equal(event.dotted, false, 'rests use only undotted values');
        assert.equal(event.tieFromPrevious, false);
        assert.equal(event.tieToNext, false);
      }
      cursor += event.duration;
    }
  }
  assert.equal(cursor, bars * 16);
  const all = eventsOf(model);
  for (const note of notes) {
    const chain = all.filter(event => event.noteId === note.id);
    assert.ok(chain.length > 0);
    assert.equal(chain[0].start, note.start, 'original attack is preserved');
    assert.equal(chain.at(-1).start + chain.at(-1).duration, note.start + note.duration, 'original release is preserved');
    assert.equal(chain.reduce((sum, event) => sum + event.duration, 0), note.duration);
    for (const [index, event] of chain.entries()) {
      assert.equal(event.tieFromPrevious, index > 0);
      assert.equal(event.tieToNext, index < chain.length - 1);
      if (index > 0) assert.equal(event.start, chain[index - 1].start + chain[index - 1].duration);
    }
    assert.equal(chain.filter(event => !event.tieFromPrevious).length, 1, 'one attack per original note');
  }
  assert.equal(all.filter(event => event.kind === 'note' && !event.tieFromPrevious).length, notes.length);
  return model;
}

for (const bars of [1, 2, 4]) {
  test(`every valid duration and onset is represented exactly in ${bars} bar(s)`, () => {
    for (let duration = 1; duration <= bars * 16; duration += 1) {
      for (let start = 0; start + duration <= bars * 16; start += 1) {
        assertExactPhrase([{ id: 'sustained', start, duration }], bars);
      }
    }
  });

  test(`empty ${bars}-bar phrase has a whole rest in each measure`, () => {
    const model = assertExactPhrase([], bars);
    for (const measure of model.measures) {
      assert.equal(measure.events.length, 1);
      const rest = measure.events[0];
      assert.equal(rest.kind, 'rest');
      assert.equal(rest.value, 'whole');
      assert.equal(rest.duration, 16);
      assert.equal(rest.dotted, false);
    }
  });
}

for (const [duration, value] of [[3, 'eighth'], [6, 'quarter'], [12, 'half']]) {
  test(`${duration}-tick onset-zero note uses one dotted ${value}`, () => {
    const model = assertExactPhrase([{ id: 'dotted', start: 0, duration }], 1);
    const notes = eventsOf(model).filter(event => event.kind === 'note');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].value, value);
    assert.equal(notes[0].dotted, true);
    assert.equal(notes[0].tieFromPrevious, false);
    assert.equal(notes[0].tieToNext, false);
  });
}

for (const [duration, lengths, values] of [
  [5, [4, 1], ['quarter', 'sixteenth']],
  [7, [6, 1], ['quarter', 'sixteenth']],
  [9, [8, 1], ['half', 'sixteenth']],
]) {
  test(`${duration}-tick note splits into standard values with one continuous tie chain`, () => {
    const model = assertExactPhrase([{ id: 'noncanonical', start: 0, duration }], 1);
    const segments = eventsOf(model).filter(event => event.kind === 'note');
    assert.deepEqual(segments.map(event => event.duration), lengths);
    assert.deepEqual(segments.map(event => event.value), values);
  });
}

test('offbeat duration-six note exposes beat boundaries instead of moving its attack', () => {
  const model = assertExactPhrase([{ id: 'offbeat', start: 3, duration: 6 }], 1);
  const segments = eventsOf(model).filter(event => event.kind === 'note');
  assert.deepEqual(segments.map(event => event.start), [3, 4, 8]);
  assert.deepEqual(segments.map(event => event.duration), [1, 4, 1]);
});

test('an eighth-aligned dotted eighth is preserved away from the downbeat', () => {
  const model = assertExactPhrase([{ id: 'eighth', start: 2, duration: 3 }], 1);
  const segments = eventsOf(model).filter(event => event.kind === 'note');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].value, 'eighth');
  assert.equal(segments[0].dotted, true);
});

test('offbeat sustain across several barlines retains identity and ties every segment', () => {
  const model = assertExactPhrase([{ id: 'across-bars', start: 15, duration: 49 }], 4);
  const segments = eventsOf(model).filter(event => event.kind === 'note');
  assert.deepEqual(segments.map(event => event.start), [15, 16, 32, 48]);
  assert.deepEqual(segments.map(event => event.duration), [1, 16, 16, 16]);
  for (const measure of model.measures.slice(1)) {
    assert.equal(measure.events[0].tieFromPrevious, true);
  }
});

test('different adjacent notes remain separate attacks, including at barlines', () => {
  const notes = [
    { id: 'first', start: 0, duration: 5 },
    { id: 'second', start: 5, duration: 11 },
    { id: 'third', start: 16, duration: 16 },
  ];
  const model = assertExactPhrase(notes, 2);
  const events = eventsOf(model);
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].noteId !== events[index - 1].noteId) {
      assert.equal(events[index - 1].tieToNext, false);
      assert.equal(events[index].tieFromPrevious, false);
    }
  }
});

test('omissions before, between and after notes become aligned, untied rests', () => {
  const notes = [
    { id: 'late', start: 20, duration: 3 },
    { id: 'early', start: 3, duration: 2 },
  ];
  const model = assertExactPhrase(notes, 2);
  const rests = eventsOf(model).filter(event => event.kind === 'rest');
  assert.equal(rests.reduce((sum, rest) => sum + rest.duration, 0), 27);
  assert.equal(rests[0].start, 0);
  assert.equal(rests.at(-1).start + rests.at(-1).duration, 32);
});

test('sparse two-bar eighth-note phrase uses metric rests, ending with eighth plus quarter', () => {
  const notes = [
    { id: 'a', start: 0, duration: 2 },
    { id: 'b', start: 20, duration: 2 },
    { id: 'c', start: 24, duration: 2 },
  ];
  const model = assertExactPhrase(notes, 2);
  const events = eventsOf(model);
  const rests = events.filter(event => event.kind === 'rest');
  assert.deepEqual(rests.map(({ start, duration, value }) => [start, duration, value]), [
    [2, 2, 'eighth'],
    [4, 4, 'quarter'],
    [8, 8, 'half'],
    [16, 4, 'quarter'],
    [22, 2, 'eighth'],
    [26, 2, 'eighth'],
    [28, 4, 'quarter'],
  ]);
  assert.equal(rests.reduce((sum, rest) => sum + rest.duration, 0), 26);
  assert.deepEqual(
    events.filter(event => event.kind === 'note').map(({ noteId, start, duration }) => [noteId, start, duration]),
    [['a', 0, 2], ['b', 20, 2], ['c', 24, 2]],
  );
});

for (const [start, duration, expected] of [
  [3, 1, [[3, 1, 'sixteenth']]],
  [1, 3, [[1, 1, 'sixteenth'], [2, 2, 'eighth']]],
  [2, 6, [[2, 2, 'eighth'], [4, 4, 'quarter']]],
  [4, 12, [[4, 4, 'quarter'], [8, 8, 'half']]],
  [0, 12, [[0, 8, 'half'], [8, 4, 'quarter']]],
]) {
  test(`${duration}-tick silent interval at tick ${start} uses aligned undotted rests`, () => {
    const end = start + duration;
    const notes = [{ id: 'after', start: end, duration: 32 - end }];
    if (start > 0) notes.unshift({ id: 'before', start: 0, duration: start });
    const model = assertExactPhrase(notes, 2);
    const rests = eventsOf(model).filter(event => event.kind === 'rest');
    assert.deepEqual(rests.map(({ start, duration, value }) => [start, duration, value]), expected);
    assert.equal(rests.reduce((sum, rest) => sum + rest.duration, 0), duration);
  });
}

test('long crossbar silence uses whole-bar rests and preserves sparse dotted notes', () => {
  const notes = [
    { id: 'before', start: 0, duration: 2 },
    { id: 'after', start: 50, duration: 3 },
  ];
  const model = assertExactPhrase(notes, 4);
  const rests = eventsOf(model).filter(event => event.kind === 'rest');
  const gap = rests.filter(event => event.start < 50);
  assert.deepEqual(gap.map(({ start, duration, value }) => [start, duration, value]), [
    [2, 2, 'eighth'],
    [4, 4, 'quarter'],
    [8, 8, 'half'],
    [16, 16, 'whole'],
    [32, 16, 'whole'],
    [48, 2, 'eighth'],
  ]);
  assert.equal(gap.reduce((sum, rest) => sum + rest.duration, 0), 48);
  assert.equal(rests.reduce((sum, rest) => sum + rest.duration, 0), 59);
  const after = eventsOf(model).filter(event => event.noteId === 'after');
  assert.equal(after.length, 1);
  assert.equal(after[0].dotted, true);
});

test('sorting an immutable phrase preserves its original order and objects', () => {
  const late = Object.freeze({ id: 'late', start: 12, duration: 2 });
  const early = Object.freeze({ id: 'early', start: 0, duration: 5 });
  const notes = Object.freeze([late, early]);
  const model = assertExactPhrase(notes, 1);
  assert.equal(eventsOf(model)[0].noteId, 'early');
  assert.equal(notes[0], late);
  assert.equal(notes[1], early);
});

test('invalid phrases and bar counts are rejected before notation is built', () => {
  const invalidPhrases = [
    null, undefined, {}, 'notes',
    [null], [{}],
    [{ id: '', start: 0, duration: 1 }],
    [{ id: 2, start: 0, duration: 1 }],
    [{ id: 'a', start: -1, duration: 1 }],
    [{ id: 'a', start: 0.5, duration: 1 }],
    [{ id: 'a', start: 0, duration: 0 }],
    [{ id: 'a', start: 0, duration: 1.5 }],
    [{ id: 'a', start: 0, duration: NaN }],
    [{ id: 'a', start: Infinity, duration: 1 }],
    [{ id: 'a', start: 16, duration: 1 }],
    [{ id: 'a', start: 15, duration: 2 }],
    [{ id: 'a', start: 0, duration: 4 }, { id: 'b', start: 3, duration: 4 }],
    [{ id: 'same', start: 0, duration: 1 }, { id: 'same', start: 2, duration: 1 }],
  ];
  for (const notes of invalidPhrases) assert.throws(() => buildRhythmNotation(notes, 1), TypeError);
  for (const bars of [0, -1, 3, 8, 1.5, '1', null, NaN]) {
    assert.throws(() => buildRhythmNotation([], bars), TypeError);
  }
});
