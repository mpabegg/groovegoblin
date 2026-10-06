import { sessionTicks, ticksPerBar } from './session.js';
import { musicalDuration } from './studio-bars.js';
import { getInstrumentProfile, formatInstrumentNote } from './instrument-profile.js';
import { resolveTabPosition, stringPitch, validTabFret, tabFretPatches, octaveToFitPatch } from './tablature.js';
import { bandStarterState } from './studio-patterns.js';

export function mountStudioInspector(host) {
  const $ = id => document.getElementById(id);
  let writing = false;
  let previousKind = null;
  const presets = [[1, '𝅘𝅥𝅯', 'Semicolcheia'], [2, '♪', 'Colcheia'], [4, '♩', 'Semínima'], [8, '𝅗𝅥', 'Mínima'], [6, '♩·', 'Semínima pontuada'], [16, '𝅝', 'Semibreve'], [3, '♪·', 'Colcheia pontuada'], [12, '𝅗𝅥·', 'Mínima pontuada'], [4 / 3, 'Tercina', 'Tercina de colcheia'], [4 / 5, 'Quintina', 'Quintina'], [4 / 7, 'Septina', 'Septina']];
  for (const [index, [ticks, label, name]] of presets.entries()) {
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'preset'; chip.textContent = label;
    chip.title = name; chip.setAttribute('aria-label', name); chip.dataset.duration = ticks;
    chip.addEventListener('click', () => host.commitNote({ duration: ticks }));
    $(index < 4 ? 'presets' : 'extra-presets').append(chip);
  }
  for (const field of ['start', 'duration', 'pitch', 'velocity', 'articulation', 'offsetMs']) {
    $(`note-${field}`).addEventListener('change', event => {
      const input = event.target;
      if (input.value === '' || !input.checkValidity()) { host.notify('Confira o valor e os limites deste campo.', true); render(); return; }
      host.commitNote({ [field]: field === 'articulation' ? input.value : Number(input.value) / (field === 'velocity' ? 100 : 1) });
    });
  }
  const selectedNotes = () => {
    const selection = host.getSelection(); const ids = selection?.kind === 'note' ? selection.ids ?? [selection.id] : [];
    return host.getSession().notes.filter(note => ids.includes(note.id));
  };
  $('note-string').addEventListener('change', event => {
    const profile = getInstrumentProfile(host.getSession()); const string = Number(event.target.value); const open = stringPitch(profile, string);
    if (open === null || selectedNotes().some(note => !validTabFret(note.pitch - open))) {
      host.notify('O grupo não cabe nessa corda sem mudar alturas. Escolha outra corda ou edite a casa.', true); render(); return;
    }
    host.commitNote({ string });
  });
  $('note-fret').addEventListener('change', event => {
    const input = event.target; const notes = selectedNotes();
    const patches = input.value !== '' && input.checkValidity()
      ? tabFretPatches(notes, notes.map(note => note.id), Number(input.value), getInstrumentProfile(host.getSession())) : null;
    if (!patches) { host.notify('Use uma casa inteira de 0 a 24 dentro da extensão MIDI.', true); render(); return; }
    host.commitNote(note => patches.get(note.id) ?? {});
  });
  $('note-octave-fit').addEventListener('click', () => {
    const profile = getInstrumentProfile(host.getSession());
    host.commitNote(note => octaveToFitPatch(note, profile));
  });
  $('write-from-scratch').addEventListener('click', () => { writing = true; render(); $('grid').focus({ preventScroll: true }); });
  function render() {
    const session = host.getSession(); const selection = host.getSelection(); const locked = host.isBusy();
    const note = selection?.kind === 'note' ? session.notes.find(item => item.id === selection.id) : null;
    const chord = selection?.kind === 'chord' ? session.progression.chords[selection.index] : null;
    const profile = getInstrumentProfile(session);
    const position = note ? resolveTabPosition(note, profile) : null;
    const outOfRange = selectedNotes().some(item => !resolveTabPosition(item, profile).playable);
    const kind = note ? 'note' : chord ? 'chord' : null;
    if (kind !== previousKind) {
      for (const detail of $('studio-inspector').querySelectorAll('details')) detail.open = false;
      previousKind = kind;
    }
    const empty = !session.notes.length && !writing;
    $('empty-phrase').hidden = !empty;
    $('phrase-actions').hidden = kind !== null || empty;
    $('selection-text').hidden = kind !== 'note';
    if (note) $('selection-text').textContent = (selection.ids?.length ?? 1) > 1 ? `${selection.ids.length} notas selecionadas · edição conjunta` : `Nota · ${formatInstrumentNote(note.pitch, profile)} · compasso ${Math.floor(note.start / ticksPerBar(session)) + 1}`;
    const starters = bandStarterState(session);
    $('band-starters').hidden = writing || starters.complete;
    $('start-band').hidden = starters.ownBass;
    $('start-full-band').textContent = starters.ownBass ? 'Ligar bateria e acordes' : 'Ligar banda completa (bateria, baixo e acordes)';
    $('start-full-band').title = starters.ownBass ? 'Liga a bateria padrão e os acordes; o baixo gerado continua desligado porque o baixo é a sua parte. Cria acordes somente se a progressão estiver vazia' : 'Liga bateria e baixo padrão; cria acordes somente se a progressão estiver vazia';
    $('note-detail').hidden = !note;
    $('studio-inspector').hidden = empty && !kind;
    for (const field of ['start', 'duration', 'pitch', 'velocity', 'articulation', 'offsetMs']) {
      const input = $(`note-${field}`);
      input.value = note ? field === 'velocity' ? Math.round(note.velocity * 100) : note[field] : '';
      input.disabled = locked || !note;
      input.title = locked ? 'Pare a reprodução antes de editar a nota' : !note ? 'Selecione uma nota para editar' : '';
    }
    $('note-pitch-name').textContent = note ? `Nota: ${formatInstrumentNote(note.pitch, profile)}` : '';
    $('note-string').replaceChildren();
    for (let string = 1; string <= profile.strings; string += 1) {
      const option = document.createElement('option'); option.value = string; option.textContent = `${string} · ${formatInstrumentNote(stringPitch(profile, string), profile)}`; $('note-string').append(option);
    }
    $('note-string').value = position?.string ?? 1; $('note-string').disabled = locked || !note;
    $('note-fret').value = position?.playable ? position.fret : ''; $('note-fret').disabled = locked || !note;
    $('note-range-warning').hidden = !outOfRange;
    $('note-octave-fit').hidden = !outOfRange; $('note-octave-fit').disabled = locked || !note;
    $('note-start').max = sessionTicks(session); $('note-duration').max = sessionTicks(session);
    $('note-start').step = $('note-duration').step = 'any';
    for (const chip of document.querySelectorAll('#presets button, #extra-presets button')) {
      chip.title = `${chip.getAttribute('aria-label')} · ${musicalDuration(Number(chip.dataset.duration), session)}`;
      chip.disabled = locked || !note;
      chip.setAttribute('aria-pressed', String(!!note && Math.abs(note.duration - Number(chip.dataset.duration)) < 1e-8));
    }
    $('delete').disabled = locked || !note;
    for (const id of ['open-pattern', 'generate-phrase', 'empty-generate', 'start-pattern', 'write-from-scratch', 'start-band', 'start-full-band', 'open-phrase-tools']) $(id).disabled = locked;
    $('empty-pattern').disabled = locked;
    $('transpose-semitones').disabled = locked;
    $('transpose-phrase').disabled = locked || !session.notes.length;
    $('transpose-options').querySelector('summary').title = !session.notes.length ? 'Escreva ou carregue uma frase antes de transpor' : 'Transpor todas as notas da frase';
  }
  return { render, resetEmpty: () => { writing = false; } };
}
