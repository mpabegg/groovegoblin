import { sessionTicks, ticksPerBar } from './session.js';
import { musicalDuration } from './studio-bars.js';

import { getInstrumentProfile, formatInstrumentNote } from './instrument-profile.js';

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
  $('write-from-scratch').addEventListener('click', () => { writing = true; render(); $('grid').focus({ preventScroll: true }); });
  function render() {
    const session = host.getSession(); const selection = host.getSelection(); const locked = host.isBusy();
    const note = selection?.kind === 'note' ? session.notes.find(item => item.id === selection.id) : null;
    const chord = selection?.kind === 'chord' ? session.progression.chords[selection.index] : null;
    const kind = note ? 'note' : chord ? 'chord' : null;
    if (kind !== previousKind) {
      for (const detail of $('studio-inspector').querySelectorAll('details')) detail.open = false;
      previousKind = kind;
    }
    const empty = !session.notes.length && !writing;
    $('empty-phrase').hidden = !empty;
    $('phrase-actions').hidden = kind !== null || empty;
    $('selection-text').hidden = kind !== 'note';
    if (note) $('selection-text').textContent = (selection.ids?.length ?? 1) > 1 ? `${selection.ids.length} notas selecionadas · edição conjunta` : `Nota · ${formatInstrumentNote(note.pitch, getInstrumentProfile(session))} · compasso ${Math.floor(note.start / ticksPerBar(session)) + 1}`;
    $('band-starters').hidden = writing || (session.drums.enabled && session.band.bassEnabled && session.progression.enabled && session.progression.chords.length > 0);
    $('note-detail').hidden = !note;
    $('studio-inspector').hidden = empty && !kind;
    for (const field of ['start', 'duration', 'pitch', 'velocity', 'articulation', 'offsetMs']) {
      const input = $(`note-${field}`);
      input.value = note ? field === 'velocity' ? Math.round(note.velocity * 100) : note[field] : '';
      input.disabled = locked || !note;
      input.title = locked ? 'Pare a reprodução antes de editar a nota' : !note ? 'Selecione uma nota para editar' : '';
    }
    $('note-pitch-name').textContent = note ? `Altura: ${formatInstrumentNote(note.pitch, getInstrumentProfile(session))}` : '';
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
