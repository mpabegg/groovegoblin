import { GROOVES, loadGroove } from './library.js';
import { generateGroove } from './generator.js';
import { ticksPerBar, validateSession } from './session.js';
import { getDiatonicChords } from './progression.js';
import { mergeSession } from './studio-state.js';
import { getInstrumentProfile } from './instrument-profile.js';
import { INSTRUMENT_PATTERNS, loadInstrumentPattern, resolveInstrumentPatternNotes } from './instrument-patterns.js';

// A silent/disabled chord is still authored music; an empty phrase alone is not an empty session.
export function hasPreservableMusic(session) {
  return session.notes.length > 0 || session.progression.chords.length > 0
    || session.drums.enabled || session.band.bassEnabled || session.form.sections.length > 0;
}

export function patternRequirements(session, pattern) {
  return {
    expand: pattern.bars > session.bars,
    changeStructure: pattern.meter.beats !== session.meter.beats || pattern.meter.unit !== session.meter.unit
      || pattern.subdivision !== session.subdivision,
  };
}

// Repeat complete source bars, including their rests. A final partial repetition stops at the session boundary.
// Incompatible meters/grids require explicit permission; preserve source attacks exactly, without quantization or fusion.
export function patternPatch(session, pattern, { expand = false, changeStructure = false } = {}) {
  const required = patternRequirements(session, pattern);
  if (required.expand && !expand) throw new RangeError('O padrão é maior: escolha ajustar os compassos ou cancelar.');
  if (required.changeStructure && !changeStructure) throw new RangeError('Escolha mudar o compasso e a subdivisão da sessão ou cancelar.');
  const bars = required.expand ? pattern.bars : session.bars;
  const measure = ticksPerBar(required.changeStructure ? pattern : session);
  const span = pattern.bars * measure;
  const limit = bars * measure;
  const notes = [];
  for (let offset = 0, repeat = 0; offset < limit - 1e-8; offset += span, repeat++) {
    for (const note of pattern.notes) {
      const start = offset + note.start;
      if (start >= limit - 1e-8) continue;
      notes.push({ ...note, id: `${note.id}-repeat-${repeat}`, start, duration: Math.min(note.duration, limit - start) });
    }
  }
  const patch = { notes };
  if (required.changeStructure) {
    patch.meter = { ...pattern.meter };
    patch.subdivision = pattern.subdivision;
  }
  if (required.expand) {
    patch.bars = bars;
    // Only a loop that covered the whole session follows an explicitly accepted expansion.
    if (session.loop.startBar === 0 && session.loop.endBar === session.bars) patch.loop = { startBar: 0, endBar: bars };
  }
  if (pattern.instrument) patch.notes = resolveInstrumentPatternNotes(mergeSession(session, patch), pattern, notes);
  if (!hasPreservableMusic(session)) patch.bpm = pattern.bpm;
  return patch;
}

export function generatedPhrasePatch(session, options) {
  const generated = generateGroove({ ...options, bars: session.bars, meter: session.meter, subdivision: session.subdivision });
  return { notes: generated.notes, extensions: { studio: { generator: options } } };
}

export function starterHarmony(session) {
  const diatonic = getDiatonicChords(session.progression.keyId);
  const degrees = [1, 4, 5, 1];
  return Array.from({ length: session.bars }, (_, bar) => ({ ...diatonic[degrees[bar % degrees.length] - 1], startBar: bar, durationBars: 1 }));
}

export function mountStudioPatterns(host) {
  const $ = id => document.getElementById(id);
  const phraseDialog = $('phrase-tools-dialog');
  const decision = document.createElement('dialog');
  decision.id = 'pattern-decision'; decision.className = 'shortcuts-dialog';
  decision.setAttribute('aria-labelledby', 'pattern-decision-title');
  const title = document.createElement('h2'); title.id = 'pattern-decision-title'; title.textContent = 'Antes de carregar o padrão';
  const explanation = document.createElement('p'); explanation.id = 'pattern-decision-description';
  decision.setAttribute('aria-describedby', explanation.id);
  const apply = document.createElement('button'); apply.id = 'pattern-decision-apply'; apply.type = 'button';
  const cancel = document.createElement('button'); cancel.id = 'pattern-decision-cancel'; cancel.type = 'button'; cancel.textContent = 'Cancelar';
  decision.append(title, explanation, apply, cancel); document.body.append(decision);
  let request = null;
  let previousFocus = null;
  function dismiss() { request = null; decision.close(); }
  cancel.addEventListener('click', dismiss);
  decision.addEventListener('cancel', () => { request = null; });
  decision.addEventListener('close', () => { request = null; previousFocus?.focus({ preventScroll: true }); previousFocus = null; });
  decision.addEventListener('click', event => {
    const box = decision.getBoundingClientRect();
    if (event.target === decision && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dismiss();
  });
  decision.addEventListener('keydown', event => { if (event.key !== 'Escape') event.stopPropagation(); });
  function commit(pattern, consent = {}) {
    const session = host.getSession();
    const patch = patternPatch(session, pattern, consent);
    const checked = validateSession(mergeSession(session, patch));
    if (!checked.ok) {
      explanation.textContent = `Mudança não aplicada: ${checked.error} Os acordes e as seções existentes não foram alterados. Cancele e ajuste esses eventos antes de mudar o compasso.`;
      return false;
    }
    const changes = [`Frase preenchida em ${patch.bars ?? session.bars} compassos`];
    if (patch.bars) changes.push(`${session.bars} → ${patch.bars} compassos`);
    if (patch.meter && (patch.meter.beats !== session.meter.beats || patch.meter.unit !== session.meter.unit)) changes.push(`${session.meter.beats}/${session.meter.unit} → ${patch.meter.beats}/${patch.meter.unit}`);
    if (patch.subdivision !== undefined && patch.subdivision !== session.subdivision) changes.push(`subdivisão ${session.subdivision} → ${patch.subdivision}`);
    if (patch.bpm !== undefined && patch.bpm !== session.bpm) changes.push(`${session.bpm} → ${patch.bpm} BPM`);
    const applied = host.updateSession(patch, { structural: true, notice: `${changes.join('; ')}.` });
    if (applied) phraseDialog.close();
    return applied;
  }
  apply.addEventListener('click', () => {
    if (!request || host.isBusy()) return;
    if (request.session !== host.getSession()) { dismiss(); host.notify('Sessão alterada; escolha o padrão novamente.'); return; }
    const { pattern, requirements } = request;
    if (commit(pattern, requirements)) dismiss();
  });
  const filter = document.createElement('select'); filter.id = 'pattern-instrument-filter'; filter.setAttribute('aria-label', 'Filtrar padrões por instrumento');
  for (const [value, label] of [['rhythm', 'Ritmo'], ['guitar', 'Guitarra'], ['bass', 'Baixo']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; filter.append(option);
  }
  $('groove-library').before(filter);
  const catalog = [...GROOVES, ...INSTRUMENT_PATTERNS];
  function populate(category) {
    filter.value = category;
    const entries = category === 'rhythm' ? GROOVES : INSTRUMENT_PATTERNS.filter(item => item.instrument === category);
    for (const id of ['groove-library', 'empty-pattern']) {
      $(id).replaceChildren();
      for (const entry of entries) {
        const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.name; $(id).append(option);
      }
    }
    describe(entries[0].id);
  }
  filter.addEventListener('change', () => populate(filter.value));
  // Reset on every library opening, not only at mount or when a profile is first selected.
  phraseDialog.addEventListener('toggle', () => { if (phraseDialog.open) populate(getInstrumentProfile(host.getSession()).type); });
  for (const id of ['open-pattern', 'open-phrase-tools']) $(id).addEventListener('click', () => populate(getInstrumentProfile(host.getSession()).type));
  function describe(value) {
    const groove = catalog.find(item => item.id === value);
    $('groove-library').value = $('empty-pattern').value = value;
    $('groove-description').textContent = $('empty-pattern-description').textContent = groove?.description ?? '';
    $('groove-details').replaceChildren();
    if (groove) {
      const detail = document.createElement('p'); detail.textContent = groove.durationNote; $('groove-details').append(detail);
      for (const source of groove.sources) { const link = document.createElement('a'); link.href = source.url; link.textContent = source.title; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('groove-details').append(link); }
    }
    host.renderControls();
  }
  for (const id of ['groove-library', 'empty-pattern']) $(id).addEventListener('change', event => describe(event.target.value));
  function load() {
    if (host.isBusy()) return;
    const id = $('groove-library').value;
    const pattern = GROOVES.some(item => item.id === id) ? loadGroove(id) : loadInstrumentPattern(id);
    const session = host.getSession(); const requirements = patternRequirements(session, pattern);
    if (!requirements.expand && !requirements.changeStructure) { commit(pattern); return; }
    request = { session, pattern, requirements }; previousFocus = document.activeElement;
    explanation.textContent = [requirements.expand ? `O padrão tem ${pattern.bars} compassos; sua sessão tem ${session.bars}. Ajustar amplia a sessão sem apagar acordes ou seções.` : '', requirements.changeStructure ? `Mudar a sessão para ${pattern.meter.beats}/${pattern.meter.unit}, subdivisão ${pattern.subdivision}? Atualmente: ${session.meter.beats}/${session.meter.unit}, subdivisão ${session.subdivision}. Essa escolha mantém todos os ataques do padrão e as posições/durações dos acordes em compassos; não quantiza nem funde notas. BPM e swing existentes são preservados, exceto o BPM sugerido numa sessão sem conteúdo musical.` : ''].filter(Boolean).join(' ');
    apply.textContent = [requirements.expand ? `Ajustar para ${pattern.bars} compassos` : '', requirements.changeStructure ? `Mudar para ${pattern.meter.beats}/${pattern.meter.unit} · subdivisão ${pattern.subdivision}` : ''].filter(Boolean).join(' e ');
    decision.showModal(); cancel.focus({ preventScroll: true });
  }
  for (const id of ['load-groove', 'start-pattern']) $(id).addEventListener('click', load);
  function generate(variation) {
    if (host.isBusy()) return;
    const session = host.getSession();
    const options = { ...session.extensions.studio.generator, seed: variation ? crypto.getRandomValues(new Uint32Array(1))[0] : Number($('seed').value) };
    try {
      if (host.updateSession(generatedPhrasePatch(session, options), { structural: true, notice: `Frase gerada em ${session.bars} compassos.` })) phraseDialog.close();
    } catch (error) { host.notify(error.message, true); }
  }
  $('generate').addEventListener('click', () => generate(false));
  for (const id of ['variation', 'generate-phrase', 'empty-generate']) $(id).addEventListener('click', () => generate(true));
  function startBand(full) {
    if (host.isBusy()) return;
    const session = host.getSession(); const created = full && !session.progression.chords.length;
    const patch = { drums: { enabled: true, style: 'pop', density: 'medium', seed: 1 }, band: { bassEnabled: true, style: 'pop', density: 'medium', role: 'solo', mode: 'steady' }, mixer: { drums: { muted: false }, bass: { muted: false } } };
    if (full) {
      patch.progression = created ? { enabled: true, cycleBars: session.bars, chords: starterHarmony(session) } : { enabled: true };
      patch.mixer.chords = { muted: false };
    }
    host.updateSession(patch, { notice: full ? created ? `Banda Pop ligada; ${session.bars} ${session.bars === 1 ? 'acorde criado' : 'acordes criados'}, um por compasso.` : 'Banda Pop e acordes ligados; progressão preservada.' : 'Bateria e baixo Pop ligados.' });
  }
  $('start-band').addEventListener('click', () => startBand(false));
  $('start-full-band').addEventListener('click', () => startBand(true));
  populate(getInstrumentProfile(host.getSession()).type);
}
