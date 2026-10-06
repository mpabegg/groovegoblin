import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, patchSession } from '../src/session.js';
import { standardInstrumentProfile } from '../src/instrument-profile.js';
import { parseChordSymbol } from '../src/progression.js';
import { readTrackLayout, saveTrackLayout, mountTrackLayout, TRACK_LAYOUT_KEY, COLLAPSIBLE_TRACKS } from '../src/studio-track-layout.js';
import { bandStarterState, bandStarterPatch } from '../src/studio-patterns.js';
import { memoryStorage } from './storage-fixture.js';

const bass = standardInstrumentProfile('bass', 4);
const chord = { ...parseChordSymbol('C'), startBar: 0, durationBars: 1 };

test('layout preference round-trips per track and survives corrupt or missing storage', () => {
  const storage = memoryStorage();
  const fresh = readTrackLayout(storage);
  assert.ok(saveTrackLayout({ drums: 'expanded', bass: 'compact' }, storage));
  assert.deepEqual(readTrackLayout(storage), { drums: 'expanded', bass: 'compact' });
  assert.ok(saveTrackLayout({ drums: 'compact', bass: 'expanded' }, storage));
  assert.deepEqual(readTrackLayout(storage), { drums: 'compact', bass: 'expanded' });
  storage.setItem(TRACK_LAYOUT_KEY, '{not json'); assert.deepEqual(readTrackLayout(storage), fresh);
  storage.setItem(TRACK_LAYOUT_KEY, 'null'); assert.deepEqual(readTrackLayout(storage), fresh);
  storage.setItem(TRACK_LAYOUT_KEY, JSON.stringify({ drums: 'huge', bass: 1 })); assert.deepEqual(readTrackLayout(storage), fresh);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(readTrackLayout(broken), fresh); assert.equal(saveTrackLayout({ drums: 'expanded' }, broken), false);
});

function dom(t) {
  const nodes = new Map();
  class Node {
    constructor() { this.children = []; this.attributes = {}; this.listeners = {}; this.classes = new Set(); this.hidden = false; this.tabIndex = 0; this.inert = false; this.classList = { toggle: (name, value) => { if (value) this.classes.add(name); else this.classes.delete(name); } }; }
    set id(value) { this._id = value; nodes.set(value, this); }
    get id() { return this._id; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    querySelector(selector) { return this.lookup[selector] ?? null; }
  }
  for (const track of ['drums', 'bass']) {
    const row = new Node(); row.id = `track-${track}`; const mixer = new Node(); const lane = new Node();
    if (track === 'drums') lane.id = 'drum-lanes';
    row.lookup = { '.track-inline-mixer': mixer, ...(track === 'drums' ? { '#drum-lanes': lane } : {}) };
  }
  const original = globalThis.document;
  globalThis.document = { getElementById: id => nodes.get(id), createElement: () => new Node() };
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  return nodes;
}

test('toggles expose state, gate drum editing and restore the remembered layout on remount', t => {
  const nodes = dom(t); const storage = memoryStorage();
  saveTrackLayout({ drums: 'compact', bass: 'compact' }, storage);
  let layout = mountTrackLayout(storage);
  const toggle = id => nodes.get(`track-${id}-layout`); const lane = nodes.get('drum-lanes');
  for (const track of COLLAPSIBLE_TRACKS) {
    assert.equal(toggle(track).getAttribute('aria-expanded'), 'false'); assert.equal(toggle(track).getAttribute('aria-controls'), `track-${track}`);
    assert.ok(nodes.get(`track-${track}`).classes.has('track-compact'));
  }
  assert.equal(lane.inert, true); assert.equal(lane.tabIndex, -1);
  toggle('drums').listeners.click();
  assert.equal(toggle('drums').getAttribute('aria-expanded'), 'true'); assert.equal(nodes.get('track-drums').classes.has('track-compact'), false);
  assert.equal(lane.inert, false); assert.equal(lane.tabIndex, 0);
  assert.equal(nodes.get('track-bass').classes.has('track-compact'), true);
  // The drum grid resets its own tab stop on mount; render re-applies the compact gate.
  layout.render(); assert.equal(lane.tabIndex, 0);
  toggle('drums').listeners.click(); lane.tabIndex = 0; layout.render(); assert.equal(lane.tabIndex, -1);
  toggle('bass').listeners.click();
  layout = mountTrackLayout(storage);
  assert.equal(toggle('bass').getAttribute('aria-expanded'), 'true'); assert.equal(toggle('drums').getAttribute('aria-expanded'), 'false');
  assert.equal(layout.isCompact('drums'), true); assert.equal(layout.isCompact('bass'), false);
});

test('bass profile starters complete with drums and chords and never enable the generated bass', () => {
  const ready = { drums: { enabled: true }, progression: { enabled: true, chords: [chord] }, band: { bassEnabled: false } };
  assert.equal(bandStarterState(createSession({ ...ready, extensions: { studio: { instrument: bass } } })).complete, true);
  assert.equal(bandStarterState(createSession(ready)).complete, false);
  assert.equal(bandStarterState(createSession({ ...ready, band: { bassEnabled: true } })).complete, true);
  assert.equal(bandStarterState(createSession({ ...ready, drums: { enabled: false }, extensions: { studio: { instrument: bass } } })).complete, false);

  const empty = createSession({ bars: 3, band: { bassEnabled: false }, mixer: { bass: { muted: true } }, extensions: { studio: { instrument: bass } } });
  for (const full of [false, true]) {
    const { patch } = bandStarterPatch(empty, full); const next = patchSession(empty, patch);
    assert.equal(next.band.bassEnabled, false); assert.equal(next.mixer.bass.muted, true);
    assert.equal(next.drums.enabled, true); assert.equal(next.progression.enabled, true);
    assert.equal(next.progression.chords.length, empty.bars);
    assert.equal(bandStarterState(next).complete, true);
  }
  const existing = createSession({ progression: { enabled: false, chords: [chord] }, band: { bassEnabled: false }, extensions: { studio: { instrument: bass } } });
  const kept = patchSession(existing, bandStarterPatch(existing, true).patch);
  assert.deepEqual(kept.progression.chords, existing.progression.chords); assert.equal(kept.band.bassEnabled, false);

  const guitar = createSession({ band: { bassEnabled: false } });
  assert.equal(patchSession(guitar, bandStarterPatch(guitar, false).patch).band.bassEnabled, true);
  assert.equal(patchSession(guitar, bandStarterPatch(guitar, false).patch).progression.enabled, guitar.progression.enabled);
});
