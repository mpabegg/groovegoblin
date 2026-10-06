import { createSession } from './session.js';
import { CHORD_QUALITIES, parseChordSymbol } from './progression.js';
import { normalizeInstrumentProfile } from './instrument-profile.js';

export const PUBLIC_EXERCISE_NAME = 'Estudo musical';
export const COURSE_EXPORT_NOTICE = 'Só notas e parâmetros musicais: títulos do curso, vínculos, anotações e materiais ficam de fora.';
const PITCH_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
let privateLookup = () => false;

export function isCourseContent({ entry, session } = {}) {
  const metadata = entry?.metadata;
  return metadata?.courseContent === true || metadata?.study?.origin?.kind === 'course'
    || metadata?.study?.origin?.private === true || privateLookup({ entry, session });
}

/** Bridge legacy course links to sticky metadata before any share/export action. */
export function bindCoursePrivacy(library, courseStorePromise) {
  let store = null;
  let disposed = false;
  let refreshing = false;
  let unsubscribeCourse = () => {};
  const lookup = ({ entry }) => {
    // Unreadable course state cannot establish that legacy content is public.
    if (!store || store.error || store.persistent === false || store.corrupt().length) return true;
    const candidate = entry ?? library.activeEntry();
    if (!candidate) return false;
    return candidate.metadata?.courseContent === true || store.originsOf(candidate.id).length > 0;
  };
  privateLookup = lookup;
  function refresh() {
    if (!store || disposed || refreshing) return;
    refreshing = true;
    try {
      for (const row of library.list()) {
        const entry = library.get(row.id);
        if (entry && entry.metadata.courseContent !== true && store.originsOf(row.id).length) {
          library.updateMetadata(row.id, { courseContent: true });
        }
      }
    } finally { refreshing = false; }
  }
  const unsubscribeLibrary = library.subscribe(refresh);
  Promise.resolve(courseStorePromise).then(value => {
    if (disposed) return;
    store = value;
    unsubscribeCourse = store.subscribe(refresh);
    refresh();
  }).catch(() => { /* Keep conservative sharing while recovery is required. */ });
  return () => {
    disposed = true;
    unsubscribeLibrary();
    unsubscribeCourse();
    if (privateLookup === lookup) privateLookup = () => false;
  };
}

/** No mutation, no provenance fields, and no free text hidden in musical IDs. */
export function shareableSession(session, { privateContent = isCourseContent({ session }) } = {}) {
  if (!privateContent) return structuredClone(session);
  const result = createSession(session);
  result.name = PUBLIC_EXERCISE_NAME;
  result.notes = result.notes.map((note, index) => ({ ...note, id: `note-${index + 1}` }));
  result.form.sections = result.form.sections.map((section, index) => ({ ...section, id: `section-${index + 1}`, name: `Parte ${index + 1}` }));
  result.progression.chords = result.progression.chords.map(chord => {
    const quality = Object.hasOwn(CHORD_QUALITIES, chord.quality) ? chord.quality : '';
    let symbol = `${PITCH_NAMES[chord.root]}${quality}${chord.bass === null ? '' : `/${PITCH_NAMES[chord.bass]}`}`;
    try {
      const parsed = parseChordSymbol(chord.symbol);
      if (parsed.root === chord.root && parsed.quality === quality && parsed.bass === chord.bass) symbol = parsed.symbol;
    } catch { /* Reconstruct free-form text from the actual musical values. */ }
    return { ...chord, symbol, quality,
      roman: /^[IVivb#♭♯0-9°ø+Δm/()-]*$/.test(chord.roman) ? chord.roman : '',
      notes: chord.notes.map(note => ({ midi: note.midi, name: PITCH_NAMES[note.midi % 12] })),
    };
  });
  const studio = session.extensions?.studio;
  result.extensions = {};
  if (studio?.instrument) result.extensions.studio = { instrument: normalizeInstrumentProfile(studio.instrument) };
  if (studio && ['rhythm', 'tab'].includes(studio.phraseView)) {
    result.extensions.studio = { ...result.extensions.studio, phraseView: studio.phraseView };
  }
  if (Number.isInteger(studio?.inputPitch) && studio.inputPitch >= 0 && studio.inputPitch <= 127) {
    result.extensions.studio = { ...result.extensions.studio, inputPitch: studio.inputPitch };
  }
  return createSession(result);
}

export function shareableExercise(entry, { privateContent = isCourseContent({ entry, session: entry.session }) } = {}) {
  if (!privateContent) return structuredClone(entry);
  return {
    id: 'public-exercise',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    session: shareableSession(entry.session, { privateContent: true }),
    // Decisão deliberada do B6: o bloco `study` INTEIRO fica de fora do público.
    // A receita pode carregar texto livre e privado (nome/id de forma autoral ou
    // importada, resumo, campos aninhados de material) — "sempre musical" não é
    // garantia. O que o exercício TOCA está na sessão canônica (notas, cifras e
    // parâmetros), que sai redigida mas musicalmente idêntica; a receita só sai
    // na sincronização autoritativa e no backup privado explícito.
    metadata: { name: PUBLIC_EXERCISE_NAME, tags: [], targetBPM: entry.metadata?.targetBPM ?? null, notes: '', records: [], courseContent: false },
  };
}

export function shareableLibrary(document, { courseStore = null, unknownCourses = false } = {}) {
  const ids = new Set(document.entries.map(entry => entry.id));
  let activeId = document.activeId;
  const entries = document.entries.map((entry, index) => {
    const privateContent = unknownCourses || isCourseContent({ entry, session: entry.session })
      || (courseStore?.originsOf(entry.id).length ?? 0) > 0;
    const exported = shareableExercise(entry, { privateContent });
    if (privateContent) {
      let id = `public-exercise-${index + 1}`;
      while (ids.has(id)) id += '-';
      ids.add(id);
      exported.id = id;
      if (activeId === entry.id) activeId = id;
    }
    return exported;
  });
  return { ...document, entries, activeId };
}

export function shareableAssignment(pkg) {
  if (!pkg.session || !isCourseContent({ session: pkg.session })) return pkg;
  return { ...pkg, title: PUBLIC_EXERCISE_NAME, objective: '', session: shareableSession(pkg.session, { privateContent: true }), reference: null, exercises: [], audio: null };
}
