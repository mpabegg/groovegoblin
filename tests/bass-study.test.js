import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, validateSession, STYLES, DENSITIES } from '../src/session.js';
import { mergeSession } from '../src/studio-state.js';
import { parseChordSymbol } from '../src/progression.js';
import { standardInstrumentProfile, getInstrumentProfile, instrumentTuning } from '../src/instrument-profile.js';
import { generateBass } from '../src/band.js';
import { generatedBassPhrasePatch, studyBassLinePatch, bassPhraseNotes, playablePitch, unperformTick, bassOverlapCount } from '../src/bass-study.js';
import { performTick, ticksPerBar } from '../src/meter.js';
import { prepareArrangement } from '../src/arrangement.js';
import { validPhrase, updateNote } from '../src/model.js';
import { History } from '../src/history.js';
import { BASS_PATTERNS, GUITAR_PATTERNS, loadInstrumentPattern } from '../src/instrument-patterns.js';
import { GROOVES, loadGroove } from '../src/library.js';
import { patternPatch, mountStudioPatterns } from '../src/studio-patterns.js';
import { mountStudioBassStudy } from '../src/studio-bass-study.js';
import { mountStudioNotices } from '../src/studio-notices.js';

const harmony = symbols => symbols.map((symbol, startBar) => ({ ...parseChordSymbol(symbol), startBar, durationBars: 1 }));
const sessionWith = (profile = standardInstrumentProfile('bass'), overrides = {}) => createSession({ bars: 4, bpm: 73, swing: 0.35,
  extensions: { studio: { instrument: profile, generator: { seed: 1, density: 'medium', syncopation: 'mixed', lengths: 'mixed' } } },
  progression: { enabled: true, keyId: 'c-major', cycleBars: 4, chords: harmony(['C','F','G','C']) },
  band: { bassEnabled: true, style: 'rock', density: 'medium' }, ...overrides });
function apply(session, patch) {
  const result = validateSession(mergeSession(session, patch)); assert.equal(result.ok, true, result.error); return result.session;
}
function events(session, channel) {
  const arrangement = prepareArrangement(session); const measure = ticksPerBar(session);
  return Array.from({ length: session.bars }, (_, bar) => arrangement.barEvents(bar).filter(event => event.channel === channel)
    .map(event => ({ ...event, tick: event.tick + bar * measure }))).flat();
}
const near = (a,b) => assert.ok(Math.abs(a-b) < 1e-7, `${a} != ${b}`);

 test('Rock generation follows C/F/G/C, actual bass tunings and keeps everything outside notes', () => {
  const bass4 = standardInstrumentProfile('bass');
  const profiles = [bass4, standardInstrumentProfile('bass',5), { ...bass4, tuning: instrumentTuning(bass4,'drop-d') },
    { ...bass4, tuning: [35,40,45,50], noteNames: 'solfege' }];
  for (const profile of profiles) {
    const session = sessionWith(profile, { notes: [{ id: 'old', start: 0, duration: 1, pitch: 90 }], band: { style: 'rock', density: 'medium', role: 'harmony' } });
    const before = structuredClone(session); const patch = generatedBassPhrasePatch(session, { style: 'rock', density: 'busy' });
    assert.deepEqual(Object.keys(patch), ['notes']); const result = apply(session, patch);
    assert.equal(validPhrase(result.notes,result),true);
    assert.ok(result.notes.every(note => playablePitch(note.pitch,profile)));
    assert.deepEqual([0,16,32,48].map(start => result.notes.find(note => note.start === start).pitch % 12), [0,5,7,0]);
    const { notes: ignored, ...rest } = result; const { notes: old, ...previous } = before; assert.deepEqual(rest,previous);
    assert.deepEqual(session,before);
    assert.notEqual(updateNote(result.notes,result.notes[0].id,{ velocity: 0.5 },result),result.notes);
    const changed = apply(session,{ progression: { chords: harmony(['D','Bb','A','D']) } });
    assert.deepEqual([0,16,32,48].map(start => generatedBassPhrasePatch(changed).notes.find(note => note.start === start).pitch % 12),[2,10,9,2]);
  }
});

test('generation covers all bars/meters/styles/densities within real 4/5/custom ranges and rejects impossible tuning', () => {
  for (const bars of [1,4,16]) for (const meter of [{ beats: 4, unit: 4 },{ beats: 3, unit: 4 },{ beats: 7, unit: 8 }]) {
    for (const style of STYLES) for (const density of DENSITIES) {
      const session = sessionWith(standardInstrumentProfile('bass',5), { bars, meter, progression: { enabled: false }, band: { style,density } });
      const result = apply(session,generatedBassPhrasePatch(session));
      assert.equal(validPhrase(result.notes,result),true,`${style}/${density}/${bars}`);
      assert.ok(result.notes.every(note => playablePitch(note.pitch,getInstrumentProfile(result))));
      assert.ok(result.notes.some(note => note.start >= (bars-1)*ticksPerBar(result)));
    }
  }
  const impossible = sessionWith({ ...standardInstrumentProfile('bass'), tuning: [124,125,126,127] });
  assert.throws(() => generatedBassPhrasePatch(impossible), /oitava tocável/);
});

test('copy consumer preserves performed attacks, durations, offsets, timbre and dynamics under nonzero swing', () => {
  for (const swing of [0,1/3,0.75]) for (const swingUnit of ['eighth','sixteenth']) for (const style of ['rock','shuffle','jazz','funk','samba']) for (const density of DENSITIES) {
    const session = sessionWith(standardInstrumentProfile('guitar'), { swing,swingUnit, band: { bassEnabled: true,style,density }, timbres: { bass: 'synth-bass' }, drums: { enabled: true, style: 'pop' } });
    const source = events(session,'bass'); const raw = generateBass(session);
    const result = apply(session,studyBassLinePatch(session)); const copy = events(result,'phrase');
    assert.equal(copy.length,source.length); assert.equal(validPhrase(result.notes,result),true);
    for (let index = 0; index < copy.length; index++) {
      const expectedDuration = Math.min(source[index].duration, (source[index+1]?.tick ?? Infinity)-source[index].tick);
      near(copy[index].tick,source[index].tick); near(copy[index].duration,expectedDuration);
      for (const field of ['pitch','offsetMs','velocity','articulation','timbre']) assert.equal(copy[index][field],source[index][field],`${style}/${density}/${field}`);
    }
    for (const channel of ['drums','chords','metronome']) assert.deepEqual(events(result,channel),events(session,channel));
    assert.deepEqual(generateBass(session),raw, 'legacy accompaniment remains unchanged');
    assert.equal(result.swing,session.swing); assert.equal(result.swingUnit,session.swingUnit);
  }
});

test('complementary drums react to the copied phrase while retaining parameters, edits and swing', () => {
  const session = sessionWith(standardInstrumentProfile('guitar'), {
    drums: { enabled: true, style: 'complement', density: 'medium', seed: 1,
      edits: [{ voice: 'snare', start: 1, velocity: 0.33 }, { voice: 'hihat', start: 0, velocity: null }] },
  });
  const result = apply(session, studyBassLinePatch(session));
  const before = events(session, 'drums'); const after = events(result, 'drums');
  assert.deepEqual(result.drums, session.drums);
  assert.equal(result.swing, session.swing); assert.equal(result.swingUnit, session.swingUnit);
  assert.ok(before.some(event => event.instrument === 'hihat' && event.tick % 4 !== 0));
  // A dense copied phrase makes the existing complementary algorithm leave space on offbeats.
  assert.ok(after.filter(event => event.instrument === 'hihat').every(event => event.tick % 4 === 0));
  assert.ok(!after.some(event => event.instrument === 'hihat' && event.tick === 0));
  assert.ok(after.some(event => event.instrument === 'snare' && Math.abs(event.tick - performTick(result, 1)) < 1e-7 && event.velocity === 0.33));
  assert.notDeepEqual(after, before);
});

test('shuffle inverse handles odd meters and both endpoints; microtime survives and no double swing', () => {
  const session = sessionWith(standardInstrumentProfile('bass'),{ meter: { beats: 7,unit: 8 },swing:0.75,band:{style:'shuffle'} });
  for (const tick of [0,1,2,8/3,12,13,14,16.5,55.5,56]) near(performTick(session,unperformTick(session,tick)),tick);
  const source = [{ start:8/3,duration:4/3,pitch:36,velocity:0.7,articulation:'ghost',offsetMs:17 }];
  const copy = bassPhraseNotes(session,source)[0];
  near(performTick(session,copy.start),8/3); near(performTick(session,copy.start+copy.duration),4);
  assert.equal(copy.offsetMs,17);
});

test('study transfer keeps unplayable pitches and legacy role, profile+notes+sound undo atomically', () => {
  const session = sessionWith(standardInstrumentProfile('guitar'), { notes: [{ id:'own',start:0,duration:2,pitch:69 }],band:{style:'samba',density:'medium',role:'drums'},timbres:{bass:'upright-bass'} });
  const source = generateBass(session); assert.ok(source.some(note => note.pitch < 28));
  const patch = studyBassLinePatch(session); const result = apply(session,patch);
  assert.deepEqual(result.notes.map(note=>note.pitch),source.map(note=>note.pitch));
  assert.equal(result.band.role,'drums'); assert.equal(result.band.bassEnabled,false); assert.equal(result.timbres.phrase,'upright-bass');
  assert.equal(getInstrumentProfile(result).type,'bass');
  for (const key of ['bpm','bars','progression','drums','mixer','form','training','swing','loop']) assert.deepEqual(result[key],session[key]);
  const history = new History(); history.push(session); history.push(result);
  assert.deepEqual(history.undo(),session); assert.equal(history.canUndo,false); assert.deepEqual(history.redo(),result);
  const jazz = sessionWith(standardInstrumentProfile('guitar'),{band:{style:'jazz',density:'busy'}});
  assert.ok(bassOverlapCount(generateBass(jazz)) > 0); assert.equal(validPhrase(studyBassLinePatch(jazz).notes,jazz),true);
});

test('all instrument patterns resolve degrees independently at each occurrence and preserve legacy Rhythm wrappers', () => {
  assert.equal(BASS_PATTERNS.length,10); assert.equal(GUITAR_PATTERNS.length,8); assert.equal(GROOVES.length,11);
  const profile = standardInstrumentProfile('bass',5); const session = sessionWith(profile);
  for (const recipe of BASS_PATTERNS) {
    assert.ok(recipe.notes.every(note => Number.isInteger(note.degree) && !Object.hasOwn(note,'pitch')));
    const pattern = loadInstrumentPattern(recipe.id); const result = apply(session,patternPatch(session,pattern,{changeStructure:true}));
    assert.equal(validPhrase(result.notes,result),true); assert.ok(result.notes.every(note=>playablePitch(note.pitch,profile)));
    assert.deepEqual(result.progression,session.progression); assert.equal(result.bpm,session.bpm); assert.equal(result.bars,4);
    assert.equal(result.notes.length,recipe.notes.length*4);
    assert.notEqual(pattern.notes,loadInstrumentPattern(recipe.id).notes);
    const original = recipe.notes[0].degree; pattern.notes[0].degree = 8; assert.equal(loadInstrumentPattern(recipe.id).notes[0].degree,original);
  }
  for (const groove of GROOVES) {
    const first = loadGroove(groove.id); const again = loadGroove(groove.id);
    assert.deepEqual(first,again); assert.equal(first.notes.length,groove.notes.length);
    for (let index = 0; index < first.notes.length; index++) {
      near(first.notes[index].start, groove.notes[index].start);
      near(first.notes[index].duration, groove.notes[index].duration);
    }
    assert.equal(validateSession(mergeSession(session,patternPatch(session,first,{changeStructure:true,expand:true}))).ok,true);
  }
});

test('degree root transposition, within-bar changes, minor/altered intervals and explicit key fallback reach arrangement consumer', () => {
  const session = sessionWith(standardInstrumentProfile('bass'), { progression:{keyId:'d-minor',enabled:true,cycleBars:4,chords:harmony(['Dm7','Gm7','Am7b5','Dm7'])} });
  const roots = apply(session,patternPatch(session,loadInstrumentPattern('bass-root-quarters')));
  assert.deepEqual([0,16,32,48].map(tick=>events(roots,'phrase').find(note=>note.tick===tick).pitch%12),[2,7,9,2]);
  const walking = apply(session,patternPatch(session,loadInstrumentPattern('bass-walking-four')));
  assert.deepEqual(walking.notes.filter(note=>note.start>=32 && note.start<48).map(note=>(note.pitch-9+120)%12),[0,3,6,10]);
  const midbar = apply(session,{progression:{chords:[{...parseChordSymbol('D'),startBar:0,durationBars:0.5},{...parseChordSymbol('Eb'),startBar:0.5,durationBars:0.5}],cycleBars:1}});
  const split = apply(midbar,patternPatch(midbar,loadInstrumentPattern('bass-root-quarters')));
  assert.deepEqual(split.notes.slice(0,4).map(note=>note.pitch%12),[2,2,3,3]);
  const fallback = apply(session,{progression:{enabled:false,keyId:'a-minor'}});
  const fallbackNotes = apply(fallback,patternPatch(fallback,loadInstrumentPattern('bass-walking-four'))).notes;
  assert.deepEqual(fallbackNotes.slice(0,4).map(note=>(note.pitch-9+120)%12),[0,3,7,10]);
});

test('guitar rhythms are playable, include real ghost articulation, and shuffle reaches actual audio timing', () => {
  const session = sessionWith(standardInstrumentProfile('guitar'),{swing:0.6});
  for (const recipe of GUITAR_PATTERNS) {
    const result = apply(session,patternPatch(session,loadInstrumentPattern(recipe.id),{changeStructure:true}));
    assert.equal(validPhrase(result.notes,result),true); assert.equal(result.bpm,session.bpm);
    assert.ok(result.notes.every(note=>playablePitch(note.pitch,getInstrumentProfile(result))));
  }
  const funk = apply(session,patternPatch(session,loadInstrumentPattern('guitar-funk-ghost')));
  assert.ok(events(funk,'phrase').some(note=>note.articulation==='ghost'));
  const shuffle = apply(session,patternPatch(session,loadInstrumentPattern('guitar-shuffle'),{changeStructure:true}));
  const played = events(shuffle,'phrase'); near(played[1].tick,8/3); near(played[1].duration,4/3);
});

function fixture(t) {
  const nodes = new Map();
  class Node {
    constructor() { this.listeners = new Map(); this.children = []; this.value = ''; this.open = false; this.hidden = false; this.dataset = {}; this.classList = { toggle() {} }; }
    set id(value) { this._id=value; nodes.set(value,this); } get id() { return this._id; }
    setAttribute() {} append(...nodes) { this.children.push(...nodes); } prepend(...nodes) { this.children.unshift(...nodes); } before() {}
    insertBefore(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children=[...nodes]; }
    querySelector() { return this.extra ??= new Node(); }
    addEventListener(type,listener) { const listeners=this.listeners.get(type)??[]; listeners.push(listener); this.listeners.set(type,listeners); }
    dispatch(type,event={}) { for (const listener of this.listeners.get(type)??[]) listener({target:this, ...event}); }
    focus() { document.activeElement=this; } showModal() { this.open=true; } close() { this.open=false; this.dispatch('close'); }
    getBoundingClientRect() { return {left:0,top:0,right:100,bottom:100}; }
  }
  for (const id of ['track-phrase','track-bass','phrase-tools-dialog','open-pattern','open-phrase-tools','groove-library','empty-pattern','groove-description','empty-pattern-description','groove-details','load-groove','start-pattern','generate','variation','generate-phrase','empty-generate','start-band','start-full-band','studio-toast','message','replacement-undo','toast-close']) { const node=new Node(); node.id=id; }
  const previous=globalThis.document;
  globalThis.document={ getElementById:id=>nodes.get(id),createElement:()=>new Node(),body:new Node(),activeElement:new Node() };
  t.after(()=>{ if(previous===undefined) delete globalThis.document; else globalThis.document=previous; });
  return nodes;
}

test('UI study/generation confirmation, cancel, stale requests and one undoable host transaction', t => {
  const nodes=fixture(t); let session=sessionWith(standardInstrumentProfile('guitar'),{notes:[{id:'own',start:0,duration:2,pitch:60}],band:{style:'jazz',density:'busy',bassEnabled:true}});
  const history=new History(); history.push(session); let edits=0; const notices=[];
  const host={ getSession:()=>session,isBusy:()=>false,notify:message=>notices.push(message),notifyAction:message=>notices.push(message),updateSession(patch,options){ session=apply(session,patch); history.push(session); edits++; notices.push(options.notice); return true; } };
  const ui=mountStudioBassStudy(host); const before=structuredClone(session);
  nodes.get('study-bass-line').dispatch('click'); assert.equal(edits,0); assert.equal(nodes.get('bass-study-decision').open,true);
  assert.match(nodes.get('bass-study-description').textContent,/sustentações sobrepostas/);
  nodes.get('bass-study-cancel').dispatch('click'); assert.deepEqual(session,before);
  nodes.get('study-bass-line').dispatch('click'); nodes.get('bass-study-apply').dispatch('click');
  assert.equal(edits,1); assert.equal(getInstrumentProfile(session).type,'bass'); assert.match(notices.at(-1),/encurtadas/);
  assert.deepEqual(history.undo(),before); session=history.redo(); ui.render(); assert.equal(nodes.get('study-bass-line').hidden,true); assert.equal(nodes.get('bass-phrase-tools').hidden,false);
  nodes.get('bass-phrase-style').value='rock'; nodes.get('bass-phrase-density').value='sparse';
  const own=session; nodes.get('generate-bass-phrase').dispatch('click'); assert.equal(edits,1);
  nodes.get('bass-study-cancel').dispatch('click'); assert.equal(session,own);
  nodes.get('generate-bass-phrase').dispatch('click'); session=apply(session,{bpm:80}); nodes.get('bass-study-apply').dispatch('click'); assert.equal(edits,1); assert.match(notices.at(-1),/Sessão alterada/);
  nodes.get('generate-bass-phrase').dispatch('click'); nodes.get('bass-study-apply').dispatch('click'); assert.equal(edits,2); assert.equal(session.bpm,80);
});

test('pattern filter defaults at every open, explicit Rhythm retains all fixtures, and loads use current harmony', t => {
  const nodes=fixture(t); let session=sessionWith(standardInstrumentProfile('bass')); let edits=0;
  mountStudioPatterns({getSession:()=>session,isBusy:()=>false,notify(){},renderControls(){},updateSession(patch){session=apply(session,patch);edits++;return true;}});
  const filter=nodes.get('pattern-instrument-filter'); assert.equal(filter.value,'bass'); assert.equal(nodes.get('groove-library').children.length,10);
  filter.value='rhythm'; filter.dispatch('change'); assert.equal(nodes.get('groove-library').children.length,11);
  nodes.get('groove-library').value='tresillo'; nodes.get('load-groove').dispatch('click'); assert.equal(edits,1); assert.equal(session.notes.length,12);
  nodes.get('open-pattern').dispatch('click'); assert.equal(filter.value,'bass');
  nodes.get('groove-library').value='bass-root-quarters'; nodes.get('load-groove').dispatch('click'); assert.equal(edits,2); assert.deepEqual([0,16,32,48].map(start=>session.notes.find(note=>note.start===start).pitch%12),[0,5,7,0]);
  session=apply(session,{extensions:{studio:{instrument:standardInstrumentProfile('guitar')}}});
  nodes.get('open-phrase-tools').dispatch('click'); assert.equal(filter.value,'guitar'); assert.equal(nodes.get('groove-library').children.length,8);
  nodes.get('groove-library').value='guitar-shuffle'; const before=session; nodes.get('load-groove').dispatch('click'); assert.equal(session,before); assert.equal(nodes.get('pattern-decision').open,true);
  nodes.get('pattern-decision-apply').dispatch('click'); assert.equal(session.subdivision,3); assert.equal(session.bpm,73); assert.equal(session.bars,4);
});

test('denied preference storage retains the musical warning and the real history-bound undo action', t => {
  const nodes = fixture(t);
  t.mock.method(globalThis, 'setTimeout', () => ({}));
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem() { throw new Error('denied'); } } });
  t.after(() => { if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else delete globalThis.localStorage; });
  let session = sessionWith(standardInstrumentProfile('guitar'), { notes: [{ id: 'own', start: 0, duration: 2, pitch: 69 }], band: { bassEnabled: true, style: 'jazz', density: 'busy' } });
  const before = structuredClone(session); const history = new History(); history.push(session);
  const notices = mountStudioNotices({ current: () => history.current, canUndo: () => history.canUndo, isBusy: () => false, undo: () => { session = history.undo(); } });
  mountStudioBassStudy({
    getSession: () => session, isBusy: () => false,
    notify: text => notices.show(text),
    notifyAction: (text, actionLabel, action) => notices.show(text, { current: history.current, actionLabel, action }),
    updateSession(patch, options) { session = apply(session, patch); history.push(session); notices.changed(history.current, options.notice); return true; },
  });
  nodes.get('study-bass-line').dispatch('click'); nodes.get('bass-study-apply').dispatch('click');
  assert.match(nodes.get('message').textContent, /encurtadas/);
  assert.match(nodes.get('message').textContent, /Não foi possível lembrar/);
  assert.equal(nodes.get('replacement-undo').hidden, false);
  nodes.get('replacement-undo').dispatch('click');
  assert.deepEqual(session, before); assert.equal(history.canUndo, false);
});
