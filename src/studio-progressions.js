import { PROGRESSION_KEYS, findKey, getDiatonicChords, parseChordSymbol, chordTimeline } from './progression.js';
import { ticksPerBar, validateSession } from './session.js';
import { mergeSession } from './studio-state.js';

const recipe = (id, label, mode, degrees) => Object.freeze({ id, label, mode, bars: degrees.length, degrees: Object.freeze(degrees.map(value => Object.freeze(value))) });
export const NAMED_PROGRESSIONS = Object.freeze([
  recipe('blues-major', 'Blues maior', 'major', [[1, '7'], [1, '7'], [1, '7'], [1, '7'], [4, '7'], [4, '7'], [1, '7'], [1, '7'], [5, '7'], [4, '7'], [1, '7'], [5, '7']]),
  recipe('blues-minor', 'Blues menor', 'minor', [[1, 'm7'], [1, 'm7'], [1, 'm7'], [1, 'm7'], [4, 'm7'], [4, 'm7'], [1, 'm7'], [1, 'm7'], [6, '7'], [5, '7'], [1, 'm7'], [5, '7']]),
  recipe('ii-v-i', 'ii–V–I', 'major', [[2, 'm7'], [5, '7'], [1, 'maj7']]),
  recipe('i-v-vi-iv', 'I–V–vi–IV', 'major', [[1, ''], [5, ''], [6, 'm'], [4, '']]),
  recipe('i-vi-iv-v', 'I–vi–IV–V', 'major', [[1, ''], [6, 'm'], [4, ''], [5, '']]),
  recipe('vi-iv-i-v', 'vi–IV–I–V', 'major', [[6, 'm'], [4, ''], [1, ''], [5, '']]),
  recipe('i-iv-v', 'I–IV–V', 'major', [[1, ''], [4, ''], [5, '']]),
  recipe('minor-descent', 'i–♭VII–♭VI–V', 'minor', [[1, 'm'], [7, ''], [6, ''], [5, '7']]),
]);

// Ciclos pelos 12 tons: uma tríade por fundamental, sem tonalidade única. Os
// três ciclos usam a mesma grafia (lado bemol) para nenhum deles misturar F# e
// Gb; a tonalidade da sessão é mantida, só a harmonia muda.
export const CYCLE_ORDERS = Object.freeze([
  Object.freeze({ id: 'fourths', label: 'Quartas', roots: Object.freeze(['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'B', 'E', 'A', 'D', 'G']) }),
  Object.freeze({ id: 'fifths', label: 'Quintas (inverso)', roots: Object.freeze(['C', 'G', 'D', 'A', 'E', 'B', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F']) }),
  Object.freeze({ id: 'chromatic', label: 'Cromática ascendente', roots: Object.freeze(['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']) }),
]);
export const CYCLE_TRIADS = Object.freeze([
  Object.freeze({ id: 'major', label: 'Maior', quality: '' }),
  Object.freeze({ id: 'minor', label: 'Menor', quality: 'm' }),
  Object.freeze({ id: 'augmented', label: 'Aumentada', quality: 'aug' }),
  Object.freeze({ id: 'diminished', label: 'Diminuta', quality: 'dim' }),
]);
export const CYCLE_BARS_PER_CHORD = Object.freeze([1, 2]);

export const cycleOrderId = order => `cycle-${order}`;
export function findCycleOrder(id) {
  return typeof id === 'string' && id.startsWith('cycle-') ? CYCLE_ORDERS.find(order => cycleOrderId(order.id) === id) ?? null : null;
}

// Rótulo e tamanho antes de aplicar — "2 compassos por acorde + o primeiro
// repetido em 1 compasso = 25 compassos" — para o usuário decidir com o número
// na frente, sem nunca cortar o ciclo em silêncio.
export function cyclePresetLabel(id, options = {}) {
  const order = findCycleOrder(id);
  if (!order) throw new TypeError('Escolha um dos três ciclos pelos 12 tons.');
  const triad = CYCLE_TRIADS.find(value => value.id === options.triad) ?? CYCLE_TRIADS[0];
  const barsPerChord = options.barsPerChord ?? 1;
  const repeatFirst = options.repeatFirst !== false;
  const tail = repeatFirst
    ? `${barsPerChord} ${barsPerChord === 1 ? 'compasso' : 'compassos'} por acorde + o primeiro repetido em 1 compasso`
    : `${barsPerChord} ${barsPerChord === 1 ? 'compasso' : 'compassos'} por acorde, sem acorde final`;
  return `${order.label} · tríades ${triad.label.toLowerCase()} · ${tail} = ${order.roots.length * barsPerChord + (repeatFirst ? 1 : 0)} compassos`;
}

// O ciclo tem 12 acordes e, por padrão, o primeiro repetido no fim. O acorde
// final dura SEMPRE um compasso — 2 compassos por acorde dão 2×12+1 = 25.
export function cycleProgression(keyId, id, { triad = 'major', barsPerChord = 1, repeatFirst = true } = {}) {
  const order = findCycleOrder(id);
  if (!order) throw new TypeError('Escolha um dos três ciclos pelos 12 tons.');
  const chosen = CYCLE_TRIADS.find(value => value.id === triad);
  if (!chosen) throw new TypeError('Escolha tríade maior, menor, aumentada ou diminuta.');
  if (!CYCLE_BARS_PER_CHORD.includes(barsPerChord)) throw new TypeError('Cada acorde do ciclo dura 1 ou 2 compassos.');
  if (typeof repeatFirst !== 'boolean') throw new TypeError('A repetição do primeiro acorde no fim deve ser sim ou não.');
  const chords = order.roots.map((root, index) => ({
    ...parseChordSymbol(`${root}${chosen.quality}`), startBar: index * barsPerChord, durationBars: barsPerChord,
  }));
  if (repeatFirst) chords.push({ ...chords[0], startBar: order.roots.length * barsPerChord, durationBars: 1 });
  return { keyId: findKey(keyId).id, enabled: true, cycleBars: order.roots.length * barsPerChord + (repeatFirst ? 1 : 0), chords };
}

export function namedProgression(id, keyId, options = {}) {
  const inputKey = findKey(keyId);
  if (findCycleOrder(id)) return cycleProgression(inputKey.id, id, options);
  const preset = NAMED_PROGRESSIONS.find(value => value.id === id);
  if (!preset) throw new TypeError('Escolha uma progressão pronta.');
  const key = PROGRESSION_KEYS.find(value => value.pitchClass === inputKey.pitchClass && value.mode === preset.mode);
  const scale = getDiatonicChords(key.id);
  const chords = preset.degrees.map(([degree, quality], index) => {
    const root = scale[degree - 1].notes[0].name;
    const chord = parseChordSymbol(`${root}${quality}`);
    // Authored literal qualities must not be rebuilt as natural-minor v by key edits.
    const roman = preset.mode === 'minor' && degree === 5 ? 'V7' : preset.mode === 'minor' && degree >= 6 ? `♭${degree === 6 ? 'VI' : 'VII'}` : scale[degree - 1].roman;
    return { ...chord, roman, function: degree === 1 || degree === 3 || degree === 6 && preset.mode === 'major' ? 'tonic' : degree === 5 ? 'dominant' : 'subdominant', startBar: index, durationBars: 1 };
  });
  return { keyId: key.id, enabled: true, cycleBars: preset.bars, chords };
}

// Preflight before the canonical patcher (which can otherwise clip phrase notes).
// Resize never drops notes, drum differences or form sections. Repeat/cut only
// replaces harmony, and only after explicit consent in the mismatch dialog.
export function namedProgressionPatch(session, id, choice, options = {}) {
  const progression = namedProgression(id, session.progression.keyId, options);
  const patch = { progression };
  if (choice === 'resize') {
    const bars = progression.cycleBars; const limit = bars * ticksPerBar(session);
    const losses = [];
    if (session.notes.some(note => note.start + note.duration > limit + 1e-8)) losses.push('notas da frase');
    if (session.drums.edits.some(edit => edit.start >= limit - 1e-8)) losses.push('diferenças da bateria');
    if (session.form.sections.some(section => section.endBar > bars || section.startBar >= bars)) losses.push('seções da forma');
    if (losses.length) return { error: `Ajustar para ${bars} compassos removeria ${losses.join(', ')}. Nenhum dado foi alterado. Escolha Repetir/cortar só a progressão ou Cancelar.` };
    patch.bars = bars;
    patch.loop = { ...session.loop, startBar: Math.min(session.loop.startBar, bars - 1), endBar: bars };
  } else if (choice === 'repeat-cut') {
    patch.progression = { ...progression, cycleBars: session.bars, chords: chordTimeline({ ...session, progression }).map(event => ({ ...event.chord, startBar: event.start / ticksPerBar(session), durationBars: event.duration / ticksPerBar(session) })) };
  } else if (choice !== 'exact' || progression.cycleBars !== session.bars) {
    return { error: 'Escolha ajustar a sessão, repetir/cortar a progressão ou cancelar.' };
  }
  const checked = validateSession(mergeSession(session, patch));
  return checked.ok ? { patch } : { error: `Progressão não aplicada: ${checked.error} Nenhum dado foi alterado.` };
}

export function mountNamedProgressions(host) {
  const select = document.getElementById('progression-function');
  const group = document.createElement('optgroup'); group.label = 'Progressões com tamanho próprio';
  for (const preset of NAMED_PROGRESSIONS) {
    const option = document.createElement('option'); option.value = preset.id;
    option.textContent = `${preset.label} · ${preset.bars} compassos · ${preset.mode === 'major' ? 'maior' : 'menor'}`; group.append(option);
  }
  select.append(group);
  document.getElementById('harmony-options-hint').textContent = 'Cadência, turnaround e diatônica livre preenchem a sessão em tempos inteiros, sem mudar seus compassos. Para inserir com pausas, clique na faixa.';
  const hint = document.createElement('p'); hint.id = 'named-progression-hint'; hint.className = 'tool-hint muted';
  hint.textContent = 'Progressões nomeadas usam um acorde por compasso e o modo indicado, mantendo a tônica. Tamanho diferente: escolha ajustar a sessão ou repetir/cortar somente os acordes; Cancelar preserva tudo.';
  document.getElementById('harmony-options').querySelector('.track-popover').append(hint);
  const dialog = document.createElement('dialog'); dialog.id = 'progression-decision'; dialog.className = 'shortcuts-dialog';
  dialog.setAttribute('aria-labelledby', 'progression-decision-title'); dialog.setAttribute('aria-describedby', 'progression-decision-description');
  const title = document.createElement('h2'); title.id = 'progression-decision-title'; title.textContent = 'Tamanho da progressão';
  const description = document.createElement('p'); description.id = 'progression-decision-description';
  const resize = document.createElement('button'); resize.id = 'progression-decision-resize'; resize.type = 'button';
  const repeat = document.createElement('button'); repeat.id = 'progression-decision-repeat'; repeat.type = 'button'; repeat.textContent = 'Repetir/cortar só a progressão';
  const cancel = document.createElement('button'); cancel.id = 'progression-decision-cancel'; cancel.type = 'button'; cancel.textContent = 'Cancelar';
  dialog.append(title, description, resize, repeat, cancel); document.body.append(dialog);
  let request = null; let previousFocus = null;
  function dismiss() { request = null; dialog.close(); }
  function legend(id, options) {
    const preset = NAMED_PROGRESSIONS.find(value => value.id === id);
    return preset ? `${preset.label}: ${preset.bars} compassos` : cyclePresetLabel(id, options);
  }
  function commit(id, choice, options) {
    const result = namedProgressionPatch(host.getSession(), id, choice, options);
    if (result.error) { description.textContent = result.error; host.notify(result.error, true); return false; }
    const previous = host.getEditorSelection(); host.setChordSelection(null);
    const applied = host.updateSession(result.patch, { structural: true, notice: `${legend(id, options)}${choice === 'repeat-cut' ? `; repetida/cortada para ${host.getSession().bars} compassos` : ''}. Frase, bateria e seções preservadas.` });
    if (!applied) { host.setEditorSelection(previous); host.selectionChanged?.(); }
    else document.getElementById('harmony-options').open = false;
    return applied;
  }
  function choose(choice) {
    if (!request || host.isBusy()) return;
    if (request.session !== host.getSession()) { dismiss(); host.notify('Sessão alterada; escolha a progressão novamente.'); return; }
    if (commit(request.id, choice, request.options)) dismiss();
  }
  resize.addEventListener('click', () => choose('resize')); repeat.addEventListener('click', () => choose('repeat-cut')); cancel.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', () => { request = null; });
  dialog.addEventListener('close', () => { request = null; previousFocus?.focus({ preventScroll: true }); previousFocus = null; });
  dialog.addEventListener('keydown', event => { if (event.key !== 'Escape') event.stopPropagation(); });
  dialog.addEventListener('click', event => { const box = dialog.getBoundingClientRect(); if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dismiss(); });
  function generate(id, options = {}) {
    const preset = NAMED_PROGRESSIONS.find(value => value.id === id);
    const cycle = findCycleOrder(id);
    if (!preset && !cycle) return false;
    if (host.isBusy()) return true;
    const session = host.getSession();
    let progression;
    try { progression = namedProgression(id, session.progression.keyId, options); }
    catch (error) { host.notify(error.message, true); return false; }
    if (session.bars === progression.cycleBars) { commit(id, 'exact', options); return true; }
    request = { id, options, session }; previousFocus = document.activeElement;
    const size = `${progression.cycleBars} compassos`;
    description.textContent = preset
      ? `${preset.label}: ${size} em ${findKey(progression.keyId).label}; sua sessão tem ${session.bars}. Ajustar muda o tamanho, o loop e a harmonia no tom indicado, preservando frase, bateria e seções. Repetir/cortar mantém o tamanho e recorta/repete somente a nova harmonia, também no tom indicado. Ambas substituem os acordes existentes em uma alteração que pode ser desfeita.`
      : `${legend(id, options)}; sua sessão tem ${session.bars} compassos. O tom do exercício é mantido: os doze acordes definem a harmonia. Ajustar muda o tamanho, o loop e a harmonia, preservando frase, bateria e seções. Repetir/cortar mantém o tamanho e recorta/repete somente a nova harmonia. Ambas substituem os acordes existentes em uma alteração que pode ser desfeita.`;
    const preflight = namedProgressionPatch(session, id, 'resize', options);
    resize.textContent = `Ajustar sessão para ${progression.cycleBars} compassos`; resize.disabled = !!preflight.error;
    if (preflight.error) description.textContent += ` ${preflight.error}`;
    dialog.showModal(); cancel.focus({ preventScroll: true }); return true;
  }
  const cycleOrder = document.getElementById('cycle-order');
  const cycleTriad = document.getElementById('cycle-triad');
  const cycleBars = document.getElementById('cycle-bars');
  const cycleRepeat = document.getElementById('cycle-repeat-first');
  const cycleStatus = document.getElementById('cycle-status');
  for (const order of CYCLE_ORDERS) {
    const option = document.createElement('option'); option.value = cycleOrderId(order.id);
    option.textContent = `${order.label} · ${order.roots.join(' ')}`; cycleOrder.append(option);
  }
  for (const triad of CYCLE_TRIADS) {
    const option = document.createElement('option'); option.value = triad.id; option.textContent = triad.label; cycleTriad.append(option);
  }
  const cycleOptions = () => ({ triad: cycleTriad.value, barsPerChord: Number(cycleBars.value), repeatFirst: cycleRepeat.checked });
  // O tamanho do ciclo é sempre legível antes de aplicar: 2×12+1 = 25.
  function describeCycle() {
    cycleStatus.textContent = `${cyclePresetLabel(cycleOrder.value, cycleOptions())}. Sua sessão tem ${host.getSession().bars} compassos.`;
  }
  for (const control of [cycleOrder, cycleTriad, cycleBars, cycleRepeat]) control.addEventListener('change', describeCycle);
  document.getElementById('generate-cycle').addEventListener('click', () => {
    if (host.isBusy()) { host.notify('Pare a reprodução antes de aplicar um ciclo.'); return; }
    describeCycle(); generate(cycleOrder.value, cycleOptions());
  });
  describeCycle();
  return { generate, refreshCycleSize: describeCycle };
}
