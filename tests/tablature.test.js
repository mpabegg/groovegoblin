import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, patchSession } from '../src/session.js';
import { standardInstrumentProfile, instrumentTuning, formatInstrumentNote } from '../src/instrument-profile.js';
import { phraseView, resolveTabPosition, stringPitch, tabStringPatches, tabFretPatches, octaveToFitPatch, tabDigit, tabStringAtPointer, mountPhraseView } from '../src/tablature.js';
import { editNotes, pasteNotes } from '../src/studio-editing.js';
import { copyBar, duplicateBar, repeatPhraseInNewBars } from '../src/studio-bars.js';
import { mountStudioNoteEditor } from '../src/studio-note-editor.js';
import { History } from '../src/history.js';

const guitar = standardInstrumentProfile();
const source = () => createSession({ bars: 2, notes: [{ id: 'a', start: 0, duration: 2, pitch: 60, string: 3 }, { id: 'b', start: 8, duration: 2, pitch: 59, string: 4 }], extensions: { studio: { phraseView: 'tab' } } });
const apply = (session, patches) => patches && editNotes(session.notes, [...patches.keys()], note => patches.get(note.id), session);

test('physical string numbering, explicit preference and lowest-fret derivation are profile-aware', () => {
  assert.equal(stringPitch(guitar, 3) + 5, 60);
  assert.deepEqual(resolveTabPosition({ pitch: 60, string: 3 }, guitar), { string: 3, fret: 5, playable: true, explicit: true });
  assert.deepEqual(resolveTabPosition({ pitch: 60 }, guitar), { string: 2, fret: 1, playable: true, explicit: false });
  assert.equal(resolveTabPosition({ pitch: 69, string: 6 }, guitar).string, 1);
  for (const strings of [4, 5]) {
    const bass = standardInstrumentProfile('bass', strings);
    assert.equal(stringPitch(bass, strings), bass.tuning[0]);
    assert.equal(stringPitch(bass, 1), bass.tuning.at(-1));
  }
  const old = { pitch: 40, string: 6 };
  assert.deepEqual(resolveTabPosition(old, standardInstrumentProfile('bass', 4)), { string: 2, fret: 2, playable: true, explicit: false });
  assert.deepEqual(resolveTabPosition({ pitch: 40, string: 3 }, standardInstrumentProfile('bass', 4)), { string: 3, fret: 7, playable: true, explicit: true });
  assert.deepEqual(old, { pitch: 40, string: 6 });
  assert.equal(phraseView(createSession()), 'rhythm');
});

test('Drop D recomputes sixth-string E2 to fret 2 without changing chosen string or sounding MIDI', () => {
  const note = { pitch: 40, string: 6 }; const drop = { ...guitar, tuning: [38, ...guitar.tuning.slice(1)] };
  assert.equal(resolveTabPosition(note, guitar).fret, 0);
  assert.deepEqual(resolveTabPosition(note, drop), { string: 6, fret: 2, playable: true, explicit: true });
  assert.deepEqual(note, { pitch: 40, string: 6 });
});

test('grouped string moves preserve pitch, identities, times and durations; impossible moves reject the whole group', () => {
  const session = source(); const history = new History(); history.push(session);
  const patches = tabStringPatches(session.notes, ['a', 'b'], -1, guitar);
  const moved = apply(session, patches);
  assert.deepEqual(moved.map(note => [note.id, note.string, note.pitch, note.start, note.duration]), [['a', 2, 60, 0, 2], ['b', 3, 59, 8, 2]]);
  history.push(patchSession(session, { notes: moved }));
  assert.deepEqual(history.undo(), session); assert.deepEqual(history.redo().notes, moved);
  const blocked = { ...session, notes: [session.notes[0], { ...session.notes[1], pitch: 54 }] };
  assert.equal(tabStringPatches(blocked.notes, ['a', 'b'], -1, guitar), null);
  assert.equal(session.notes[0].string, 3);
  assert.equal(tabStringPatches([{ ...session.notes[0], string: 1, pitch: 64 }], ['a'], -1, guitar), null);
});

test('fret edits retain group strings/durations, clipboard and every bar operation retain optional metadata', () => {
  const session = source(); const notes = apply(session, tabFretPatches(session.notes, ['a', 'b'], 12, guitar));
  assert.deepEqual(notes.map(note => [note.id, note.string, note.pitch, note.start, note.duration]), [['a', 3, 67, 0, 2], ['b', 4, 62, 8, 2]]);
  assert.equal(tabFretPatches(session.notes, ['a', 'b'], 25, guitar), null);
  const pasted = pasteNotes([], notes, 16, session);
  assert.deepEqual(pasted.notes.map(note => [note.string, note.pitch, note.start, note.duration]), [[3, 67, 16, 2], [4, 62, 24, 2]]);
  assert.ok(pasted.ids.every(id => !session.notes.some(note => note.id === id)));
  assert.equal(pasteNotes(session.notes, notes, 0, session), null);
  const mixed = createSession({ bars: 2, notes: [session.notes[0], { ...session.notes[1], string: undefined }].map(note => { if (note.string === undefined) { const { string, ...missing } = note; return missing; } return note; }) });
  for (const patch of [copyBar(mixed, 0, 1).patch, duplicateBar(mixed, 0).patch, repeatPhraseInNewBars(patchSession(mixed, { bars: 4 }), mixed).patch]) {
    const added = patch.notes.filter(note => !mixed.notes.some(original => original.id === note.id));
    assert.ok(added.length >= 2);
    assert.equal(added[0].string, 3); assert.equal(Object.hasOwn(added[1], 'string'), false);
  }
  assert.equal(editNotes(session.notes, ['a', 'b'], { duration: 9 }, session), session.notes);
});

test('out-of-range notes fit by nearest whole octaves only, without deleting notes or changing IDs/durations', () => {
  const session = createSession({ notes: [{ id: 'low', start: 0, duration: 2, pitch: 0 }, { id: 'high', start: 4, duration: 2, pitch: 127, string: 1 }] });
  assert.ok(session.notes.every(note => !resolveTabPosition(note, guitar).playable));
  const fitted = editNotes(session.notes, ['low', 'high'], note => octaveToFitPatch(note, guitar), session);
  assert.deepEqual(fitted.map(note => [note.id, note.pitch, note.duration]), [['low', 48, 2], ['high', 79, 2]]);
  assert.equal(Object.hasOwn(fitted[0], 'string'), false);
  assert.equal(fitted[1].string, 1);
  assert.ok(fitted.every(note => resolveTabPosition(note, guitar).playable));
  for (let pitch = 0; pitch <= 127; pitch += 1) {
    const note = { pitch }; const patch = octaveToFitPatch(note, guitar);
    assert.equal(Math.abs((patch.pitch ?? pitch) - pitch) % 12, 0);
    assert.ok(resolveTabPosition({ ...note, ...patch }, guitar).playable);
  }
});

test('two-digit frets combine only within 600 ms and the same editor selection scope', () => {
  assert.equal(tabDigit(tabDigit(null, 1, 100, 'a'), 0, 700, 'a').fret, 10);
  assert.equal(tabDigit(tabDigit(null, 2, 100, 'a'), 4, 699, 'a').fret, 24);
  assert.equal(tabDigit(tabDigit(null, 2, 100, 'a'), 5, 200, 'a').fret, 5);
  assert.equal(tabDigit(tabDigit(null, 1, 100, 'a'), 2, 701, 'a').fret, 2);
  assert.equal(tabDigit(tabDigit(null, 1, 100, 'a'), 2, 200, 'b').fret, 2);
});

function dom(t) {
  const nodes = new Map();
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.hidden = false; this.style = { setProperty: (name, value) => { this.style[name] = value; } }; this.classList = { toggle: (name, value) => { this.attributes[name] = value; } }; }
    set id(value) { this._id = value; nodes.set(value, this); }
    get id() { return this._id; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    insertBefore(child, anchor) { this.children.splice(this.children.indexOf(anchor), 0, child); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]).filter(child => child.tag === 'button'); }
    getBoundingClientRect() { return { top: 0, left: 0, width: 320, height: 168 }; }
    focus() {}
    closest(selector) { return selector === '.note' && this.dataset.id ? this : null; }
  }
  for (const id of ['creation-duration', 'grid', 'phrase-view', 'tab-strings', 'tab-string-labels', 'track-phrase']) { const node = new Node('div'); node.id = id; }
  const original = globalThis.document;
  globalThis.document = { getElementById: id => nodes.get(id), createElement: tag => new Node(tag), querySelector: () => null };
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  return { nodes, Node };
}

function editor(t, initial) {
  const { nodes, Node } = dom(t); let session = initial; let selection = null; let cursor = 0; let updates = 0; const notices = [];
  const host = { getSession: () => session, getEditorSelection: () => selection, getSelection: () => selection?.id, setEditorSelection: value => { selection = value; }, selectionChanged() {}, auditionNotes() {}, notify: text => notices.push(text), updateSession: patch => { session = patchSession(session, patch); updates++; return true; } };
  const grid = nodes.get('grid');
  mountStudioNoteEditor(grid, host, { renderNotes() {}, focusNote() {}, getCursor: () => cursor, setCursor: value => { cursor = value; }, navigate() {} });
  const key = (value, target = grid, extra = {}) => { let prevented = false; grid.listeners.keydown({ key: value, target, timeStamp: 100, preventDefault: () => { prevented = true; }, ...extra }); return prevented; };
  const block = id => { const node = new Node('div'); node.dataset.id = id; return node; };
  return { nodes, grid, host, key, block, get: () => session, updates: () => updates, notices };
}

test('tab physical-row clicks create current duration/pitch and remember fret separately per string', t => {
  const e = editor(t, createSession({ extensions: { studio: { phraseView: 'tab' } } }));
  const duration = e.nodes.get('creation-duration').children.find(child => child.dataset.duration === 2); duration.listeners.click();
  assert.equal(tabStringAtPointer(e.grid, 70, guitar), 3);
  e.grid.listeners.click({ target: e.grid, clientX: 0, clientY: 70 });
  let note = e.get().notes[0]; assert.deepEqual([note.string, note.pitch, note.duration], [3, 55, 2]);
  e.key('5', e.block(note.id)); note = e.get().notes[0]; assert.deepEqual([note.string, note.pitch, note.duration], [3, 60, 2]);
  e.grid.listeners.click({ target: e.grid, clientX: 80, clientY: 70 });
  assert.deepEqual(e.get().notes.map(item => [item.string, item.pitch, item.duration]), [[3, 60, 2], [3, 60, 2]]);
  e.grid.listeners.click({ target: e.grid, clientX: 160, clientY: 155 });
  assert.deepEqual([e.get().notes[2].string, e.get().notes[2].pitch, e.get().notes[2].duration], [6, 40, 2]);
});

test('actual tab keyboard handles digit pairs, atomic group string moves, time moves and shifted resizing', t => {
  const e = editor(t, source()); const a = e.block('a');
  e.key('a', a, { ctrlKey: true });
  e.key('1', a, { timeStamp: 100 }); e.key('2', a, { timeStamp: 500 });
  assert.deepEqual(e.get().notes.map(note => [note.string, note.pitch, note.duration]), [[3, 67, 2], [4, 62, 2]]);
  const before = e.get(); e.key('ArrowUp', a);
  assert.deepEqual(e.get().notes.map(note => [note.string, note.pitch, note.duration]), [[2, 67, 2], [3, 62, 2]]);
  assert.equal(e.updates(), 3);
  e.key('ArrowRight', a); assert.deepEqual(e.get().notes.map(note => note.start), [1, 9]);
  e.key('ArrowUp', a, { shiftKey: true }); assert.deepEqual(e.get().notes.map(note => note.duration), [6, 6]);
  assert.deepEqual(before.notes.map(note => note.pitch), e.get().notes.map(note => note.pitch));
  e.key('ArrowDown', a, { shiftKey: true }); assert.deepEqual(e.get().notes.map(note => note.duration), [2, 2]);
  e.key('ArrowUp', a); const blocked = e.get(); const count = e.updates(); e.key('ArrowUp', a);
  assert.equal(e.get(), blocked); assert.equal(e.updates(), count); assert.match(e.notices.at(-1), /grupo/);
});

test('rhythm duration shortcuts stay unchanged and tab ignores text/dialog/prevented keyboard events', t => {
  const e = editor(t, createSession({ notes: [{ id: 'a', start: 0, duration: 2, pitch: 60 }] })); const a = e.block('a');
  e.grid.listeners.focusin({ target: a }); e.key('4', a); assert.equal(e.get().notes[0].duration, 4);
  e.key('ArrowUp', a); assert.equal(e.get().notes[0].duration, 5);
  e.key('ArrowDown', a, { shiftKey: true }); assert.equal(e.get().notes[0].duration, 1);
  assert.equal(Object.hasOwn(e.get().notes[0], 'string'), false);
  const count = e.updates(); e.key('6', a, { defaultPrevented: true }); assert.equal(e.updates(), count);
  const field = { closest: selector => selector.includes('input') ? {} : a }; e.key('6', field); assert.equal(e.updates(), count);
  globalThis.document.querySelector = () => ({}); e.key('6', a); assert.equal(e.updates(), count);
});

test('the single view selector defaults to rhythm and renders exactly 6/4/5 physical lines, lowest at bottom', t => {
  const { nodes } = dom(t); let session = createSession(); const changes = [];
  const render = mountPhraseView({ getSession: () => session, updateSession: patch => changes.push(patch) });
  render(); assert.equal(nodes.get('phrase-view').value, 'rhythm'); assert.equal(nodes.get('tab-strings').children.length, 0);
  for (const profile of [guitar, standardInstrumentProfile('bass', 4), standardInstrumentProfile('bass', 5)]) {
    session = createSession({ extensions: { studio: { phraseView: 'tab', instrument: profile } } }); render();
    const lines = nodes.get('tab-strings').children;
    assert.equal(lines.length, profile.strings); assert.equal(lines[0].dataset.string, 1); assert.equal(lines.at(-1).dataset.string, profile.strings);
    assert.ok(Number.parseFloat(lines[0].style.top) < Number.parseFloat(lines.at(-1).style.top));
    assert.equal(nodes.get('track-phrase').attributes['phrase-tab'], true);
  }
  nodes.get('phrase-view').value = 'rhythm'; nodes.get('phrase-view').listeners.change();
  assert.deepEqual(changes, [{ extensions: { studio: { phraseView: 'rhythm' } } }]);
});

test('string labels follow every physical line and the current tuning/naming, and leave rhythm view', t => {
  const { nodes } = dom(t); let session;
  const render = mountPhraseView({ getSession: () => session, updateSession() {} });
  const dropD = { ...guitar, tuning: instrumentTuning(guitar, 'drop-d') };
  for (const profile of [guitar, dropD, { ...dropD, noteNames: 'solfege' }, standardInstrumentProfile('bass', 5)]) {
    session = createSession({ extensions: { studio: { phraseView: 'tab', instrument: profile } } }); render();
    const lines = nodes.get('tab-strings').children; const labels = nodes.get('tab-string-labels').children;
    assert.deepEqual(labels.map(label => [label.dataset.string, label.style.top]), lines.map(line => [line.dataset.string, line.style.top]));
    assert.deepEqual(labels.map(label => label.textContent), labels.map(label => formatInstrumentNote(stringPitch(profile, label.dataset.string), profile, { octave: false })));
  }
  session = createSession({ extensions: { studio: { phraseView: 'tab', instrument: guitar } } }); render();
  const standardSixth = nodes.get('tab-string-labels').children.at(-1).textContent;
  session = createSession({ extensions: { studio: { phraseView: 'tab', instrument: dropD } } }); render();
  assert.notEqual(nodes.get('tab-string-labels').children.at(-1).textContent, standardSixth);
  assert.equal(nodes.get('tab-string-labels').children[0].textContent, formatInstrumentNote(guitar.tuning.at(-1), guitar, { octave: false }));
  session = createSession({ extensions: { studio: { phraseView: 'rhythm', instrument: guitar } } }); render();
  assert.equal(nodes.get('tab-string-labels').children.length, 0);
});
