import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSession, validateSession, patchSession, serializeSession, parseSession, encodeSessionLink, decodeSessionLink, loadSession, saveSession, MAX_DRUM_EDITS, drumEditStructureError } from '../src/session.js';
import { generateDrums } from '../src/drums.js';
import { prepareArrangement } from '../src/arrangement.js';
import { compileBarPlan } from '../src/form.js';
import { drumHitPatch, drumRowVoice } from '../src/studio-drum-editing.js';
import { duplicateBar } from '../src/studio-bars.js';
import { readSessionLibrary, SESSION_LIBRARY_KEY } from '../src/studio-state.js';
import { History } from '../src/history.js';
import { mountStudioDrums } from '../src/studio-drums.js';
import { playbackEditPolicy } from '../src/studio-editing.js';
import { renderSession } from '../src/audio.js';
import { audioContext } from './audio-harness.js';

const store = (initial = {}) => { const values = new Map(Object.entries(initial)); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; };
const hitAt = (session, voice, start) => generateDrums(session).hits.find(hit => hit.instrument === voice && Math.abs(hit.start - start) < 1e-8);
const edit = (session, voice, start, velocity) => patchSession(session, drumHitPatch(session, voice, start, velocity));
const base = () => createSession({ bars: 2, drums: { enabled: true, style: 'pop', density: 'sparse', seed: 42 }, metronome: { enabled: false } });

for (const fixture of JSON.parse(readFileSync(new URL('./fixtures/session-v2-arrangements.json', import.meta.url), 'utf8'))) {
  test(`v3 ${fixture.name} migration preserves recorded pre-edit arrangement output on every entry path`, () => {
    const old = structuredClone(fixture.session); old.version = 3;
    let cursor = 0; old.progression.chords = old.progression.chords.map(chord => { const positioned = { ...chord, startBar: cursor }; cursor += chord.durationBars; return positioned; });
    old.progression.cycleBars = cursor || old.bars;
    const envelope = { format: 'groovegoblin-session', version: 3, session: old };
    const db = store({ 'groovegoblin.session.v2': JSON.stringify(old), [SESSION_LIBRARY_KEY]: JSON.stringify([{ id: 'old', savedAt: '2026-10-05T00:00:00Z', session: envelope }]) });
    for (const migrated of [validateSession(old).session, createSession(old), parseSession(JSON.stringify(envelope)), loadSession(db).session, readSessionLibrary(db, parseSession).entries[0].session, decodeSessionLink('#session=' + Buffer.from(JSON.stringify(old)).toString('base64url'))]) {
      assert.deepEqual(migrated.drums.edits, []);
      const arrangement = prepareArrangement(migrated);
      assert.deepEqual(Array.from({ length: migrated.bars }, (_, bar) => arrangement.barEvents(bar, { barIndex: bar })), fixture.events);
    }
    assert.equal(db.getItem('groovegoblin.session.v2'), JSON.stringify(old));
    assert.equal(validateSession({ ...old, drums: { ...old.drums, edits: [] } }).ok, false);
  });
}

test('sparse add/remove/velocity edits affect actual generator output, roundtrip all portable stores and undo restoration', () => {
  const original = base(); const generated = generateDrums(original);
  let session = edit(original, 'kick', 3, 0.63);
  session = edit(session, 'snare', 4, null);
  session = edit(session, 'hihat', 8, 0.17);
  const expected = generated.hits.filter(hit => !(hit.instrument === 'snare' && hit.start === 4)).map(hit => hit.instrument === 'hihat' && hit.start === 8 ? { ...hit, velocity: 0.17 } : hit);
  expected.push({ instrument: 'kick', start: 3, velocity: 0.63 });
  expected.sort((a, b) => a.start - b.start || ['kick', 'snare', 'hihat'].indexOf(a.instrument) - ['kick', 'snare', 'hihat'].indexOf(b.instrument));
  assert.deepEqual(generateDrums(session).hits, expected);
  assert.equal(session.drums.edits.length, 3);
  const db = store(); assert.equal(saveSession(session, db), true);
  db.setItem(SESSION_LIBRARY_KEY, JSON.stringify([{ id: 'edits', savedAt: '2026-10-05T00:00:00Z', session: JSON.parse(serializeSession(session)) }]));
  for (const actual of [parseSession(serializeSession(session)), decodeSessionLink(encodeSessionLink(session)), loadSession(db).session, readSessionLibrary(db, parseSession).entries[0].session]) {
    assert.deepEqual(actual, session); assert.deepEqual(generateDrums(actual).hits, expected);
  }
  const history = new History(); history.push(session); history.push(patchSession(session, { drums: { edits: [] } }));
  assert.deepEqual(generateDrums(history.undo()).hits, expected); assert.deepEqual(generateDrums(history.redo()), generated);
  assert.equal(edit(edit(original, 'kick', 3, 0.8), 'kick', 3, null).drums.edits.length, 0);
  assert.equal(edit(edit(original, 'snare', 4, null), 'snare', 4, hitAt(original, 'snare', 4).velocity).drums.edits.length, 0);
  assert.equal(edit(edit(original, 'hihat', 8, 0.1), 'hihat', 8, hitAt(original, 'hihat', 8).velocity).drums.edits.length, 0);
});

test('overlap identity preserves actual auxiliary voice and fractional attacks across density/style changes without doubling upserts', () => {
  const original = createSession({ drums: { enabled: true, style: 'shuffle' } });
  const tick = 8 / 3;
  let session = edit(original, 'hihat', tick, 0.14);
  session = edit(session, 'ride', tick, 0.81);
  assert.equal(drumRowVoice('ride'), 'hihat');
  assert.equal(generateDrums(session).hits.filter(hit => hit.start === tick).length, 2);
  assert.equal(hitAt(session, 'hihat', tick).velocity, 0.14);
  session = edit(session, 'hihat', tick, null);
  assert.equal(hitAt(session, 'hihat', tick), undefined); assert.equal(hitAt(session, 'ride', tick).velocity, 0.81);
  const kept = patchSession(session, { drums: { style: 'jazz', density: 'busy', seed: 923 } });
  assert.deepEqual(kept.drums.edits, session.drums.edits);
  assert.equal(generateDrums(kept).hits.filter(hit => hit.instrument === 'ride' && Math.abs(hit.start - tick) < 1e-8).length, 1);
  assert.equal(hitAt(kept, 'ride', tick).velocity, 0.81);
  assert.equal(hitAt(kept, 'hihat', tick), undefined);
});

test('strict bounded edits reject malformed, duplicate, boundary and legacy data atomically, preserving invalid storage originals', () => {
  const session = base(); const valid = { voice: 'kick', start: 1, velocity: 0.6 };
  const invalidEdits = [null, {}, 'edits', [{ ...valid, extra: true }], [{ voice: 'kick', start: 1 }], [{ ...valid, voice: 'clap' }], [{ ...valid, start: '1' }], ...[-1, 32, Infinity, NaN].map(start => [{ ...valid, start }]), ...[0, 0.049, 1.001, '0.5', false].map(velocity => [{ ...valid, velocity }]), [valid, { ...valid, velocity: null }], [valid, { ...valid, start: 1 + 1e-9 }], Array.from({ length: MAX_DRUM_EDITS + 1 }, (_, index) => ({ ...valid, start: index / 32 }))];
  for (const velocity of [Infinity, NaN]) {
    const invalid = { ...session, drums: { ...session.drums, edits: [{ ...valid, velocity }] } };
    assert.equal(validateSession(invalid).ok, false);
    assert.throws(() => generateDrums(invalid), TypeError);
    assert.equal(saveSession(invalid, store()), false);
  }
  for (const edits of invalidEdits) {
    const invalid = { ...session, drums: { ...session.drums, edits } };
    assert.equal(validateSession(invalid).ok, false, JSON.stringify(edits));
    assert.throws(() => generateDrums(invalid), TypeError);
    assert.throws(() => parseSession(JSON.stringify(invalid)), TypeError);
    const raw = JSON.stringify(invalid); const db = store({ 'groovegoblin.session.v2': raw });
    assert.equal(loadSession(db).recoveryRaw, raw); assert.equal(db.getItem('groovegoblin.session.v2'), raw); assert.equal(saveSession(invalid, db), false);
  }
  for (const version of [2, 3]) assert.equal(validateSession({ version, drums: { edits: [valid] } }).ok, false);
  const maximum = createSession({ bars: 16, meter: { beats: 16, unit: 2 }, drums: { edits: Array.from({ length: MAX_DRUM_EDITS }, (_, index) => ({ ...valid, start: index, velocity: index % 2 ? null : 0.05 })) } });
  assert.equal(parseSession(serializeSession(maximum)).drums.edits.length, MAX_DRUM_EDITS);
  const ordered = createSession({ drums: { edits: [{ ...valid, voice: 'ride' }, { ...valid, voice: 'snare' }, { ...valid, start: 0, velocity: null }] } });
  assert.deepEqual(ordered.drums.edits.map(edit => [edit.start, edit.voice]), [[0, 'kick'], [1, 'snare'], [1, 'ride']]);
});

test('size/meter/grid and insert boundary transitions preserve authored semantic positions or reject explicitly', () => {
  let original = createSession({ bars: 3, drums: { enabled: true, style: 'pop', density: 'sparse', edits: [{ voice: 'kick', start: 15, velocity: 0.19 }, { voice: 'snare', start: 16, velocity: null }, { voice: 'hihat', start: 47, velocity: 0.73 }] } });
  assert.throws(() => patchSession(original, { meter: { beats: 3 } }), /Compasso não alterado/);
  assert.throws(() => patchSession(original, { bars: 2 }), /Tamanho não alterado/);
  assert.deepEqual(patchSession(original, { bars: 4 }).drums.edits, original.drums.edits);
  assert.deepEqual(patchSession(original, { subdivision: 3 }).drums.edits, original.drums.edits);
  assert.equal(drumEditStructureError(original, { ...original, meter: { beats: 3, unit: 4 } }).includes('Compasso'), true);
  const duplicated = duplicateBar(original, 0); assert.equal(duplicated.error, undefined);
  const inserted = patchSession(original, duplicated.patch);
  assert.deepEqual(inserted.drums.edits, [{ voice: 'kick', start: 15, velocity: 0.19 }, { voice: 'snare', start: 32, velocity: null }, { voice: 'hihat', start: 63, velocity: 0.73 }]);
  assert.equal(hitAt(inserted, 'kick', 15).velocity, 0.19); assert.equal(hitAt(inserted, 'snare', 32), undefined); assert.equal(hitAt(inserted, 'hihat', 63).velocity, 0.73);
  assert.equal(inserted.drums.edits.filter(edit => edit.start >= 16 && edit.start < 32).length, 0);
  const small = edit(createSession({ meter: { beats: 1, unit: 16 }, subdivision: 3 }), 'snare', 0.99, 0.05);
  assert.equal(hitAt(small, 'snare', 0.99).velocity, 0.05); assert.throws(() => edit(small, 'snare', 1, 0.4), TypeError);
  original = edit(base(), 'kick', 1, 0.42);
  assert.equal(patchSession(original, { bars: 1 }).drums.edits.length, 1);
  assert.equal(playbackEditPolicy(original, edit(original, 'kick', 1, 0.5), { mode: 'loop' }).live, true);
  assert.equal(playbackEditPolicy(original, edit(original, 'kick', 1, 0.5), { pending: true }).stop, true);
});

test('loop and repeated form consumers apply exact add/remove/velocity differences before proportional meter conversion', () => {
  const original = createSession({ bars: 2, loop: { startBar: 1, endBar: 2 }, drums: { enabled: true, style: 'pop', density: 'sparse' }, metronome: { enabled: false } });
  const edited = createSession({ ...original, drums: { ...original.drums, edits: [{ voice: 'kick', start: 19, velocity: 0.29 }, { voice: 'snare', start: 20, velocity: null }, { voice: 'hihat', start: 24, velocity: 0.11 }] } });
  const loop = compileBarPlan(edited).bars[0].events().filter(event => event.kind === 'drum');
  assert.ok(loop.some(event => event.instrument === 'kick' && event.tick === 3 && event.velocity === 0.29));
  assert.ok(!loop.some(event => event.instrument === 'snare' && event.tick === 4));
  assert.ok(loop.some(event => event.instrument === 'hihat' && event.tick === 8 && event.velocity === 0.11));
  const form = createSession({ ...edited, form: { enabled: true, loop: false, sections: [{ id: 'a', kind: 'A', startBar: 1, endBar: 2, repeats: 2, bpm: 60, meter: { beats: 1, unit: 16 }, density: 'busy' }] } });
  const plan = compileBarPlan(form);
  assert.equal(plan.bars.length, 2);
  for (const bar of plan.bars) {
    const events = bar.events().filter(event => event.kind === 'drum');
    assert.ok(events.some(event => event.instrument === 'kick' && event.tick === 3 / 16 && event.velocity === 0.29));
    assert.ok(!events.some(event => event.instrument === 'snare' && event.tick === 4 / 16));
    assert.ok(events.some(event => event.instrument === 'hihat' && event.tick === 8 / 16 && event.velocity === 0.11));
  }
});

function ui(t, initial = base()) {
  const nodes = new Map();
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = {}; this.captured = new Set(); }
    set id(value) { this._id = value; nodes.set(value, this); } get id() { return this._id; }
    append(...children) { for (const child of children) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
    fire(type, props = {}) { const event = { target: this, button: 0, pointerId: 1, clientX: 0, clientY: 60, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...props }; for (const callback of this.listeners[type] ?? []) callback(event); }
    closest(selector) { return this.className?.split(' ').includes(selector.slice(1)) ? this : this.parent?.closest(selector); }
    getBoundingClientRect() { return { left: 0, width: 640 }; }
    focus() { document.activeElement = this; this.fire('focus'); }
    scrollIntoView() {} setPointerCapture(id) { this.captured.add(id); } hasPointerCapture(id) { return this.captured.has(id); } releasePointerCapture(id) { this.captured.delete(id); }
    showModal() { this.open = true; } close() { this.open = false; this.fire('close'); }
  }
  for (const id of ['drum-lanes', 'drum-rows', 'drum-voice-labels', 'restore-generated-drums', 'drum-style', 'drum-seed']) { const node = new Node('div'); node.id = id; }
  nodes.get('drum-lanes').append(nodes.get('drum-rows'));
  const previous = globalThis.document; globalThis.document = { getElementById: id => nodes.get(id), createElement: tag => new Node(tag), body: new Node('body'), activeElement: null };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  let session = initial; let surface; const history = new History(); history.push(session);
  const notices = [];
  const host = { getSession: () => session, notify: message => notices.push(message), updateSession(patch, options = {}) { if (surface.requestChange(patch, options)) return false; session = patchSession(session, patch); history.push(session); surface.render(); return true; } };
  surface = mountStudioDrums(host); surface.render();
  return { nodes, surface, host, history, notices, get session() { return session; }, mark(voice, start) { return nodes.get('drum-rows').children.flatMap(row => row.children).find(mark => mark.dataset.voice === voice && Number(mark.dataset.start) === start); } };
}

test('actual drum surface gestures add, remove and drag intensity once; cancel and right boundary keep session usable', t => {
  const h = ui(t); const lane = h.nodes.get('drum-lanes'); const rows = h.nodes.get('drum-rows');
  lane.fire('pointerdown', { target: rows.children[0], clientX: 60 }); lane.fire('pointerup');
  assert.equal(hitAt(h.session, 'kick', 3).velocity, 0.75);
  const mark = h.mark('kick', 3); lane.fire('pointerdown', { target: mark }); lane.fire('pointerup');
  assert.equal(hitAt(h.session, 'kick', 3), undefined); assert.equal(h.session.drums.edits.length, 0);
  const hit = h.mark('snare', 4); const before = hitAt(h.session, 'snare', 4).velocity;
  lane.fire('pointerdown', { target: hit, clientY: 60 }); lane.fire('pointermove', { clientY: 40 }); lane.fire('pointerup');
  assert.equal(hitAt(h.session, 'snare', 4).velocity, Math.round(Math.min(1, before + 0.2) * 1000) / 1000);
  assert.equal(h.session.drums.edits.length, 1); assert.equal(h.nodes.get('restore-generated-drums').hidden, false);
  const saved = serializeSession(h.session); lane.fire('pointerdown', { target: h.mark('snare', 4) }); lane.fire('pointermove', { clientY: 500 }); lane.fire('pointercancel');
  assert.equal(serializeSession(h.session), saved);
  lane.fire('pointerdown', { target: rows.children[0], clientX: 640 }); lane.fire('pointerup');
  assert.equal(hitAt(h.session, 'kick', 31).velocity, 0.75);
});

test('native keep/discard/cancel decisions and restoration operate on canonical data and undo history', t => {
  const initial = edit(base(), 'kick', 3, 0.22); const h = ui(t, initial);
  assert.equal(h.host.updateSession({ drums: { style: 'rock' } }), false); assert.equal(h.nodes.get('drum-edit-decision').open, true);
  h.nodes.get('drum-edit-cancel').fire('click'); assert.deepEqual(h.session, initial);
  h.host.updateSession({ drums: { style: 'rock' } }); h.nodes.get('drum-edit-keep').fire('click');
  assert.equal(h.session.drums.style, 'rock'); assert.deepEqual(h.session.drums.edits, initial.drums.edits); assert.equal(hitAt(h.session, 'kick', 3).velocity, 0.22);
  h.host.updateSession({ drums: { seed: 821 } }); h.nodes.get('drum-edit-discard').fire('click');
  assert.equal(h.session.drums.seed, 821); assert.deepEqual(h.session.drums.edits, []); assert.equal(h.nodes.get('restore-generated-drums').hidden, true);
  assert.deepEqual(h.history.undo().drums.edits, initial.drums.edits);
  h.host.updateSession({ drums: { edits: initial.drums.edits } }); const beforeRestore = structuredClone(h.session);
  h.nodes.get('restore-generated-drums').fire('click');
  assert.deepEqual(h.session.drums.edits, []); assert.deepEqual(h.history.undo(), beforeRestore);
});

test('one drum keyboard surface reaches fractional and overlapping voices without native per-hit controls', t => {
  const initial = createSession({ drums: { enabled: true, style: 'shuffle', edits: [{ voice: 'ride', start: 8 / 3, velocity: 0.81 }] } });
  const h = ui(t, initial); const lane = h.nodes.get('drum-lanes');
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowRight']) lane.fire('keydown', { key });
  assert.match(lane.attributes['aria-label'], /hihat/);
  lane.fire('keydown', { key: 'PageDown' }); assert.match(lane.attributes['aria-label'], /ride/);
  lane.fire('keydown', { key: 'ArrowDown', shiftKey: true }); assert.equal(hitAt(h.session, 'ride', 8 / 3).velocity, 0.76);
  lane.fire('keydown', { key: 'Delete' }); assert.equal(hitAt(h.session, 'ride', 8 / 3), undefined); assert.ok(hitAt(h.session, 'hihat', 8 / 3));
  lane.fire('keydown', { key: 'Home' }); lane.fire('keydown', { key: 'ArrowRight' }); lane.fire('keydown', { key: 'Enter' });
  assert.equal(hitAt(h.session, 'hihat', 1).velocity, 0.75);
});

test('offline renderer dispatches actual added/removed sample sources and exact overridden gain', async t => {
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, arrayBuffer: async () => new Uint8Array([['kick', 'snare', 'hihat'].findIndex(name => url.pathname.endsWith(`/${name}.wav`))]).buffer }));
  const original = createSession({ bpm: 120, drums: { enabled: true, style: 'pop', density: 'sparse' }, metronome: { enabled: false } });
  const edited = createSession({ ...original, drums: { ...original.drums, edits: [{ voice: 'snare', start: 4, velocity: null }, { voice: 'kick', start: 6, velocity: 0.23 }, { voice: 'hihat', start: 8, velocity: 0.12 }] } });
  const rendered = await renderSession(edited, { sampleRate: 8000, tailSeconds: 0, contextFactory: audioContext });
  const sampleAt = (instrument, time) => rendered.context.sources.find(source => source.type === 'buffer' && source.buffer.instrument === instrument && Math.abs(source.startTime - time) < 1e-8);
  assert.equal(sampleAt(1, 0.5), undefined); assert.ok(sampleAt(0, 0.75));
  const first = sampleAt(2, 0); const changed = sampleAt(2, 1); assert.ok(first); assert.ok(changed);
  const firstVelocity = hitAt(original, 'hihat', 0).velocity;
  assert.ok(Math.abs(changed.connections[0].gain.events[0].value / first.connections[0].gain.events[0].value - 0.12 / firstVelocity) < 1e-8);
});

test('Space on the drum surface leaves hits unchanged and propagates to the shared transport', t => {
  const h = ui(t); const lane = h.nodes.get('drum-lanes'); const before = serializeSession(h.session);
  let prevented = false; let stopped = false;
  lane.fire('keydown', { key: ' ', code: 'Space', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented, false); assert.equal(stopped, false); assert.equal(serializeSession(h.session), before);
});
