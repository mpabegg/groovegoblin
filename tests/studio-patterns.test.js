import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, patchSession, ticksPerBar, validateSession } from '../src/session.js';
import { GROOVES, loadGroove } from '../src/library.js';
import { parseChordSymbol, chordTimeline } from '../src/progression.js';
import { patternPatch, patternRequirements, generatedPhrasePatch, starterHarmony, hasPreservableMusic, mountStudioPatterns } from '../src/studio-patterns.js';
import { mergeSession } from '../src/studio-state.js';
import { mountStudioNotices } from '../src/studio-notices.js';
import { History } from '../src/history.js';

const chord = { ...parseChordSymbol('Dm7'), startBar: 1, durationBars: 1 };
const musical = overrides => createSession({ bars: 4, bpm: 72, swing: 0.25, swingUnit: 'sixteenth', progression: { enabled: true, cycleBars: 4, chords: [chord] }, ...overrides });
const options = { seed: 17, density: 'medium', syncopation: 'mixed', lengths: 'mixed' };
const invariantKeys = ['bpm', 'bars', 'meter', 'subdivision', 'swing', 'swingUnit', 'loop', 'progression', 'drums', 'band', 'mixer', 'form', 'training', 'metronome', 'companion', 'timbres', 'name'];
function preserved(before, after, except = []) {
  for (const key of invariantKeys) if (!except.includes(key)) assert.deepEqual(after[key], before[key], key);
}

test('4 bars / 72 BPM / chord in bar 2 + Tresillo preserves the session and repeats all four bars', () => {
  const session = musical(); const before = structuredClone(session);
  const patch = patternPatch(session, loadGroove('tresillo'));
  assert.deepEqual(Object.keys(patch), ['notes']);
  const result = patchSession(session, patch);
  preserved(session, result);
  assert.equal(result.notes.length, 12);
  const measure = ticksPerBar(result);
  for (let bar = 0; bar < 4; bar++) assert.deepEqual(result.notes.filter(note => Math.floor(note.start / measure) === bar).map(note => note.start - bar * measure), [0, 6, 12]);
  assert.deepEqual(chordTimeline(result).map(event => event.start), [16]);
  assert.equal(new Set(result.notes.map(note => note.id)).size, result.notes.length);
  assert.deepEqual(session, before);
});

test('a two-bar source repeats into an odd session length without dropping rests or crossing its end', () => {
  const session = musical({ bars: 3 });
  const result = patchSession(session, patternPatch(session, loadGroove('son-clave-3-2')));
  preserved(session, result);
  assert.deepEqual(result.notes.filter(note => note.start >= 32).map(note => note.start - 32), [0, 6, 12]);
  assert.ok(result.notes.every(note => note.start + note.duration <= 48));
});

test('long patterns require explicit expansion; accepting preserves chords and a custom loop', () => {
  const session = createSession({ bars: 1, bpm: 72, progression: { chords: [{ ...chord, startBar: 0 }], enabled: true } });
  const pattern = loadGroove('son-clave-3-2');
  assert.deepEqual(patternRequirements(session, pattern), { expand: true, changeStructure: false });
  assert.throws(() => patternPatch(session, pattern), /ajustar/);
  const result = patchSession(session, patternPatch(session, pattern, { expand: true }));
  preserved(session, result, ['bars', 'loop']);
  assert.equal(result.bars, 2); assert.deepEqual(result.loop, { startBar: 0, endBar: 2 });
  const custom = musical({ bars: 3, loop: { startBar: 1, endBar: 2 } });
  const longer = { ...pattern, bars: 4 };
  assert.deepEqual(patternPatch(custom, longer, { expand: true }).loop, undefined);
});

test('meter and subdivision incompatibilities require explicit changes, preserving all source attacks', () => {
  const session = musical();
  for (const id of ['eighth-triplets', 'seven-eight-223', 'twelve-eight-bell']) {
    const pattern = loadGroove(id);
    assert.equal(patternRequirements(session, pattern).changeStructure, true);
    assert.throws(() => patternPatch(session, pattern), /compasso/);
    const result = patchSession(session, patternPatch(session, pattern, { changeStructure: true }));
    preserved(session, result, ['meter', 'subdivision']);
    assert.deepEqual(result.meter, pattern.meter); assert.equal(result.subdivision, pattern.subdivision);
    assert.deepEqual(result.notes.slice(0, pattern.notes.length).map(({ start, duration }) => [start, duration]), pattern.notes.map(({ start, duration }) => [start, duration]));
  }
});

test('accepted structural changes stay valid at minimum / maximum bar counts without losing source attacks', () => {
  for (const bars of [1, 16]) for (const meter of [{ beats: 1, unit: 16 }, { beats: 16, unit: 2 }]) {
    const session = createSession({ bars, meter, subdivision: 1, bpm: 72, drums: { enabled: true } });
    const pattern = loadGroove('eighth-triplets');
    const result = patchSession(session, patternPatch(session, pattern, { changeStructure: true }));
    preserved(session, result, ['meter', 'subdivision']);
    assert.equal(validateSession(result).ok, true);
    assert.equal(result.notes.length, 12 * bars);
    assert.equal(new Set(result.notes.map(note => note.start)).size, result.notes.length);
    assert.ok(result.notes.every(note => note.duration > 0 && note.start + note.duration <= bars * ticksPerBar(result) + 1e-8));
  }
});

test('fractional-beat chords incompatible with a newly authorized meter are rejected, never snapped or discarded', () => {
  const session = musical({ progression: { enabled: true, cycleBars: 4, chords: [{ ...chord, startBar: 0.25, durationBars: 0.25 }] } });
  const before = structuredClone(session);
  const patch = patternPatch(session, loadGroove('seven-eight-223'), { changeStructure: true });
  assert.equal(validateSession(mergeSession(session, patch)).ok, false);
  assert.deepEqual(session, before);
});

test('every library pattern preserves populated-session invariants after explicit required choices', () => {
  for (const groove of GROOVES) {
    const session = musical(); const pattern = loadGroove(groove.id);
    const result = patchSession(session, patternPatch(session, pattern, { changeStructure: true, expand: true }));
    preserved(session, result, ['meter', 'subdivision']);
    assert.equal(validateSession(result).ok, true, groove.id);
  }
});

test('suggested BPM is allowed only without any preservable musical content', () => {
  const empty = createSession({ bars: 4, bpm: 72 }); const pattern = loadGroove('tresillo');
  assert.equal(hasPreservableMusic(empty), false);
  assert.equal(patternPatch(empty, pattern).bpm, 100);
  const sources = [
    { notes: [{ id: 'own', start: 0, duration: 4 }] },
    { progression: { enabled: false, chords: [chord], cycleBars: 4 } },
    { drums: { enabled: true }, mixer: { drums: { muted: true } } },
    { band: { bassEnabled: true }, mixer: { bass: { muted: true } } },
    { form: { sections: [{ id: 'a', name: 'A', kind: 'A', startBar: 0, endBar: 1, repeats: 1 }] } },
  ];
  for (const source of sources) {
    const session = createSession({ bars: 4, bpm: 72, ...source });
    assert.equal(hasPreservableMusic(session), true);
    assert.equal(Object.hasOwn(patternPatch(session, pattern), 'bpm'), false);
  }
});

test('generation preserves timing, music outside the phrase, and exact seed reproducibility', () => {
  for (const meter of [{ beats: 4, unit: 4 }, { beats: 7, unit: 8 }]) for (const bars of [4, 16]) {
    const session = musical({ bars, meter, subdivision: 3 });
    const patch = generatedPhrasePatch(session, options);
    const result = validateSession(mergeSession(session, patch));
    assert.equal(result.ok, true);
    preserved(session, result.session);
    assert.deepEqual(generatedPhrasePatch(session, options), patch);
    assert.ok(result.session.notes.some(note => note.start >= (bars - 1) * ticksPerBar(session)));
  }
});

test('full-band starter creates exactly one chord per bar, including a single bar', () => {
  for (const bars of [1, 2, 3, 4, 16]) {
    const session = createSession({ bars }); const chords = starterHarmony(session);
    assert.equal(chords.length, bars);
    assert.deepEqual(chords.map(item => [item.startBar, item.durationBars]), Array.from({ length: bars }, (_, bar) => [bar, 1]));
    const result = patchSession(session, { progression: { enabled: true, cycleBars: bars, chords } });
    assert.equal(chordTimeline(result).length, bars);
  }
});

test('single toast expires at 6s / 10s, replaces previous notices, and cannot undo a later history identity', t => {
  const nodes = new Map();
  for (const id of ['studio-toast', 'message', 'replacement-undo', 'toast-close']) nodes.set(id, {
    hidden: true, disabled: false, textContent: '', classList: { toggle() {} },
    listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; },
  });
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => ({ callback, delay }));
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const original = globalThis.document;
  globalThis.document = { getElementById: id => nodes.get(id) };
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  const history = new History(); history.push(musical());
  let undoCalls = 0; let busy = false;
  const notices = mountStudioNotices({ current: () => history.current, canUndo: () => history.canUndo, isBusy: () => busy, undo: () => { undoCalls++; history.undo(); } });
  notices.show('Aviso comum');
  assert.equal(globalThis.setTimeout.mock.calls.at(-1).arguments[1], 6000);
  assert.equal(nodes.get('replacement-undo').hidden, true);
  history.push(patchSession(history.current, { bpm: 80 }));
  const announced = history.current; notices.changed(announced, '72 → 80 BPM.');
  assert.equal(globalThis.setTimeout.mock.calls.at(-1).arguments[1], 10000);
  assert.equal(nodes.get('replacement-undo').hidden, false);
  busy = true; notices.render(); nodes.get('replacement-undo').listeners.click(); assert.equal(undoCalls, 0);
  busy = false;
  history.push(patchSession(history.current, { bpm: 90 }));
  // Even before a render/changed callback the click must check the current identity.
  nodes.get('replacement-undo').listeners.click(); assert.equal(undoCalls, 0);
  notices.changed(history.current); assert.equal(nodes.get('studio-toast').hidden, true);
  notices.changed(history.current, '80 → 90 BPM.');
  nodes.get('replacement-undo').listeners.click(); assert.equal(undoCalls, 1); assert.equal(history.current, announced);
  assert.equal(nodes.get('replacement-undo').hidden, true);
  assert.equal(nodes.get('message').textContent, 'Alteração desfeita.');
  globalThis.setTimeout.mock.calls.at(-1).arguments[0](); assert.equal(nodes.get('studio-toast').hidden, true);
  notices.show('Fechar'); nodes.get('toast-close').listeners.click(); assert.equal(nodes.get('studio-toast').hidden, true);
});

test('pattern dialog cancels without mutation, accepts explicit structural choices, and explains invalid chord positions', t => {
  const nodes = new Map();
  class Node {
    constructor() { this.listeners = {}; this.value = ''; this.open = false; this.children = []; }
    set id(value) { this._id = value; nodes.set(value, this); }
    get id() { return this._id; }
    setAttribute() {}
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100 }; }
  }
  for (const id of ['phrase-tools-dialog', 'groove-library', 'empty-pattern', 'groove-description', 'empty-pattern-description', 'groove-details', 'load-groove', 'start-pattern', 'generate', 'variation', 'generate-phrase', 'empty-generate', 'start-band', 'start-full-band']) {
    const node = new Node(); node.id = id;
  }
  const original = globalThis.document;
  globalThis.document = { getElementById: id => nodes.get(id), createElement: () => new Node(), body: new Node(), activeElement: new Node() };
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  let session = createSession({ bars: 1, bpm: 72, drums: { enabled: true } });
  let edits = 0;
  mountStudioPatterns({
    getSession: () => session, isBusy: () => false, renderControls() {}, notify() {},
    updateSession(patch) { edits++; session = validateSession(mergeSession(session, patch)).session; return true; },
  });
  nodes.get('groove-library').value = 'son-clave-3-2';
  const before = structuredClone(session);
  nodes.get('start-pattern').listeners.click();
  assert.equal(edits, 0); assert.equal(nodes.get('pattern-decision').open, true);
  assert.match(nodes.get('pattern-decision-apply').textContent, /2 compassos/);
  nodes.get('pattern-decision-cancel').listeners.click();
  assert.equal(edits, 0); assert.deepEqual(session, before);
  nodes.get('groove-library').value = 'seven-eight-223';
  nodes.get('start-pattern').listeners.click();
  assert.equal(edits, 0); assert.match(nodes.get('pattern-decision-apply').textContent, /7\/8/);
  nodes.get('pattern-decision-apply').listeners.click();
  assert.equal(edits, 1); assert.equal(session.bars, 2);
  assert.deepEqual(session.meter, { beats: 7, unit: 8 }); assert.equal(session.subdivision, 2); assert.equal(session.bpm, 72);
  session = musical({ progression: { enabled: true, cycleBars: 4, chords: [{ ...chord, startBar: 0.25, durationBars: 0.25 }] } });
  const incompatible = structuredClone(session);
  nodes.get('start-pattern').listeners.click();
  nodes.get('pattern-decision-apply').listeners.click();
  assert.equal(edits, 1); assert.deepEqual(session, incompatible);
  assert.equal(nodes.get('pattern-decision').open, true);
  assert.match(nodes.get('pattern-decision-description').textContent, /Mudança não aplicada/);
  nodes.get('pattern-decision-cancel').listeners.click();
});
