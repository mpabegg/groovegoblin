import { validateSession } from './session.js';
import { mergeSession } from './studio-state.js';
import { getInstrumentProfile, normalizeInstrumentProfile, standardInstrumentProfile, instrumentTuning, instrumentInputPitch, formatInstrumentNote, parseInstrumentNote, getInstrumentClef } from './instrument-profile.js';
import { saveInstrumentPreference } from './studio-session.js';

// Compute and validate the complete edit before submitting one history transaction.
export function instrumentChangePatch(session, value, decision = 'keep') {
  if (decision === 'cancel') return null;
  if (!['keep', 'transpose'].includes(decision)) throw new TypeError('Escolha transpor, manter alturas ou cancelar.');
  const instrument = normalizeInstrumentProfile(value);
  const previous = getInstrumentProfile(session);
  const patch = { extensions: { studio: { instrument } } };
  if (instrument.type !== previous.type) {
    patch.extensions.studio.inputPitch = instrumentInputPitch(instrument);
    patch.timbres = { phrase: instrument.type === 'bass' ? 'electric-bass' : 'clean-guitar' };
    patch.band = { bassEnabled: instrument.type !== 'bass' };
    if (decision === 'transpose') {
      const semitones = instrument.type === 'bass' ? -24 : 24;
      patch.notes = session.notes.map(note => ({ ...note, pitch: note.pitch + semitones }));
    }
  }
  const checked = validateSession(mergeSession(session, patch));
  if (!checked.ok) throw new RangeError(`Instrumento não alterado: ${checked.error} Todas as alturas devem permanecer entre MIDI 0 e 127.`);
  return patch;
}

export function mountStudioInstrument(host) {
  const $ = id => document.getElementById(id);
  const dialog = $('instrument-decision');
  let request = null;
  let previousFocus = null;
  let configSignature = '';
  function reportError(error) {
    $('instrument-profile-status').textContent = error.message;
    if (dialog.open) $('instrument-decision-description').textContent = `${error.message} Escolha Manter alturas ou Cancelar.`;
    host.notify(error.message, true);
  }
  function dismiss() { request = null; dialog.close(); render(); }
  dialog.addEventListener('cancel', () => { request = null; render(); });
  dialog.addEventListener('close', () => { request = null; previousFocus?.focus({ preventScroll: true }); previousFocus = null; });
  dialog.addEventListener('keydown', event => { if (event.key !== 'Escape') event.stopPropagation(); });
  $('instrument-cancel').addEventListener('click', dismiss);
  function commit(profile, decision = 'keep') {
    try {
      $('instrument-profile-status').textContent = '';
      const patch = instrumentChangePatch(host.getSession(), profile, decision);
      if (!host.updateSession(patch, { notice: `${profile.type === 'bass' ? 'Baixo' : 'Guitarra'}: perfil atualizado${decision === 'transpose' ? ' com transposição de duas oitavas' : '; alturas preservadas'}.` })) return false;
      if (!saveInstrumentPreference(profile)) host.notify('Perfil aplicado; não foi possível lembrar a preferência para novas sessões.', true);
      return true;
    } catch (error) { reportError(error); render(); return false; }
  }
  for (const [id, decision] of [['instrument-transpose', 'transpose'], ['instrument-keep', 'keep']]) {
    $(id).addEventListener('click', () => {
      if (!request) return;
      if (request.session !== host.getSession()) { dismiss(); host.notify('Sessão alterada; escolha o instrumento novamente.', true); return; }
      if (commit(request.profile, decision)) dismiss();
    });
  }
  $('studio-instrument').addEventListener('change', event => {
    const session = host.getSession(); const previous = getInstrumentProfile(session);
    if (event.target.value === previous.type) return;
    const profile = { ...standardInstrumentProfile(event.target.value), noteNames: previous.noteNames };
    if (!session.notes.length) { commit(profile); render(); return; }
    request = { session, profile }; previousFocus = event.target;
    $('instrument-decision-description').textContent = `Trocar para ${profile.type === 'bass' ? 'baixo' : 'guitarra'}? Transpor ${profile.type === 'bass' ? 'desce' : 'sobe'} toda a frase duas oitavas, preservando intervalos, ritmo e expressão. Manter alturas conserva todos os números MIDI. O timbre da sua parte muda; volumes e os demais sons são preservados.`;
    dialog.showModal(); $('instrument-cancel').focus({ preventScroll: true });
  });
  $('instrument-strings').addEventListener('change', event => {
    const previous = getInstrumentProfile(host.getSession());
    const profile = { ...standardInstrumentProfile(previous.type, Number(event.target.value)), noteNames: previous.noteNames };
    const preset = $('instrument-tuning').value;
    if (preset !== 'custom') profile.tuning = instrumentTuning(profile, preset);
    commit(profile); render();
  });
  $('instrument-note-names').addEventListener('change', event => { commit({ ...getInstrumentProfile(host.getSession()), noteNames: event.target.value }); render(); });
  $('instrument-tuning').addEventListener('change', event => {
    if (event.target.value === 'custom') { $('instrument-custom').hidden = false; $('instrument-custom').querySelector('input')?.focus(); return; }
    const profile = getInstrumentProfile(host.getSession());
    commit({ ...profile, tuning: instrumentTuning(profile, event.target.value) }); render();
  });
  $('instrument-apply-tuning').addEventListener('click', () => {
    try {
      const profile = getInstrumentProfile(host.getSession());
      const tuning = [...$('instrument-strings-notes').querySelectorAll('input')].map(input => parseInstrumentNote(input.value));
      if (commit({ ...profile, tuning })) render();
    } catch (error) { reportError(error); }
  });
  function render() {
    const profile = getInstrumentProfile(host.getSession());
    if (!request) $('studio-instrument').value = profile.type;
    $('instrument-strings').value = profile.strings;
    $('instrument-strings-label').hidden = profile.type !== 'bass';
    $('instrument-note-names').value = profile.noteNames;
    const clef = getInstrumentClef(profile);
    $('instrument-clef').textContent = `${profile.strings} cordas · ${profile.type === 'bass' ? 'Clave de Fá' : 'Clave de Sol'} 8vb · alturas MIDI soantes`;
    $('track-phrase').dataset.instrument = profile.type;
    $('track-phrase').dataset.clef = `${clef.sign}8vb`;
    $('instrument-drop-d').textContent = profile.type === 'bass' && profile.strings === 5 ? 'Drop D · mantém B0; E1 → D1' : 'Drop D · corda grave em D';
    const signature = JSON.stringify(profile);
    if (signature === configSignature) return;
    configSignature = signature;
    const preset = ['standard', 'drop-d', 'half-down'].find(name => instrumentTuning(profile, name).every((pitch, index) => pitch === profile.tuning[index])) ?? 'custom';
    $('instrument-tuning').value = preset; $('instrument-custom').hidden = preset !== 'custom';
    const strings = $('instrument-strings-notes'); strings.replaceChildren();
    // Inputs run low → high; labels use conventional string numbers, high = 1.
    profile.tuning.forEach((pitch, index) => {
      const label = document.createElement('label'); label.textContent = `Corda ${profile.strings - index}`;
      const input = document.createElement('input'); input.type = 'text'; input.value = formatInstrumentNote(pitch, profile); input.maxLength = 10;
      input.dataset.string = profile.strings - index; input.setAttribute('aria-label', `Afinação da corda ${profile.strings - index}, nota e oitava`);
      label.append(input); strings.append(label);
    });
  }
  return { render };
}
