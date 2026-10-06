import { CHORD_QUALITIES, findKey, getDiatonicChords, chordNowNext } from './progression.js';
import { getInstrumentProfile, formatInstrumentNote } from './instrument-profile.js';
import { generateGuitarVoicing } from './guitar-voicing.js';
import { mountFingeringShapesInFretboard } from './fingering-shapes-controller.js';

const pc = pitch => ((pitch % 12) + 12) % 12;
const NATURAL_INTERVALS = [0, 2, 4, 5, 7, 9, 11];

// Interval spelling, not a guessed major third: sus, diminished and extensions
// retain their actual degree and accidental. Foreign slash bass is explicit.
export function chordToneRoles(chord) {
  const roles = new Map();
  for (const [semitones, degree] of CHORD_QUALITIES[chord.quality] ?? []) {
    const alteration = semitones % 12 - NATURAL_INTERVALS[degree];
    const accidental = alteration < 0 ? '♭'.repeat(-alteration) : '♯'.repeat(alteration);
    const label = degree === 0 ? 'T' : `${accidental}${semitones >= 12 ? degree + 8 : degree + 1}`;
    const pitch = pc(chord.root + semitones);
    if (chord.notes.some(note => pc(note.midi) === pitch)) roles.set(pitch, label);
  }
  const intervalLabels = ['T', '♭2', '2', '♭3', '3', '4', '♭5', '5', '♯5', '6', '♭7', '7'];
  for (const note of chord.notes) {
    const pitch = pc(note.midi);
    if (!roles.has(pitch)) roles.set(pitch, pitch === chord.bass ? 'baixo' : intervalLabels[pc(pitch - chord.root)]);
  }
  return roles;
}

export function fretboardContext(session, selected, events, position, hidden = false) {
  const playing = !hidden && !['idle', 'countin'].includes(position?.mode ?? 'idle');
  const chord = playing ? events.find(event => position.tick >= event.start && position.tick < event.start + event.duration)?.chord : selected;
  if (chord) return { title: `${chord.symbol} · ${playing ? 'tocando' : 'selecionado'}`, roles: chordToneRoles(chord), root: chord.root };
  const key = findKey(session.progression.keyId);
  return { title: `${key.label} · escala${playing ? ' (sem acorde neste trecho)' : ''}`, roles: new Map(getDiatonicChords(key.id).map((value, index) => [value.root, index === 0 ? 'T' : String(index + 1)])), root: key.pitchClass };
}

const svgNode = (tag, attributes = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
};

function drawDiagram(chord, profile, voicing, target) {
  target.replaceChildren();
  const caption = document.createElement('figcaption');
  caption.textContent = `${chord.symbol} · ${voicing.barre ? `pestana na casa ${voicing.barre.fret}` : voicing.frets.includes(0) ? 'posição aberta' : 'sem pestana'} · ${voicing.fingers} dedo${voicing.fingers === 1 ? '' : 's'}`;
  const descriptions = voicing.frets.map((fret, index) => `${6 - index}ª corda ${formatInstrumentNote(profile.tuning[index], profile)}: ${fret < 0 ? 'abafada' : `casa ${fret}, ${formatInstrumentNote(voicing.pitches[index], profile)}`}`);
  const svg = svgNode('svg', { viewBox: '0 0 170 170', role: 'img', 'aria-label': `${chord.symbol}. ${descriptions.join('; ')}. ${voicing.fingers} dedo${voicing.fingers === 1 ? '' : 's'}${voicing.barre ? `; pestana casa ${voicing.barre.fret}` : ''}.` });
  for (let string = 0; string < 6; string++) svg.append(svgNode('line', { x1: 25 + string * 24, x2: 25 + string * 24, y1: 30, y2: 150, class: 'diagram-grid' }));
  for (let fret = 0; fret <= 5; fret++) svg.append(svgNode('line', { x1: 25, x2: 145, y1: 30 + fret * 24, y2: 30 + fret * 24, class: fret === 0 ? 'diagram-nut' : 'diagram-grid' }));
  if (voicing.barre) {
    const { fret, from, to } = voicing.barre;
    svg.append(svgNode('line', { x1: 25 + from * 24, x2: 25 + to * 24, y1: 18 + fret * 24, y2: 18 + fret * 24, class: 'diagram-barre' }));
  }
  voicing.frets.forEach((fret, index) => {
    if (fret > 0) svg.append(svgNode('circle', { cx: 25 + index * 24, cy: 18 + fret * 24, r: 7, class: pc(voicing.pitches[index]) === chord.root ? 'diagram-root' : 'diagram-note' }));
    else { const text = svgNode('text', { x: 25 + index * 24, y: 21, 'text-anchor': 'middle' }); text.textContent = fret < 0 ? '×' : '○'; svg.append(text); }
  });
  const notes = document.createElement('p'); notes.className = 'muted diagram-notes';
  notes.textContent = voicing.pitches.map(pitch => pitch === null ? '×' : formatInstrumentNote(pitch, profile, { octave: false })).join(' · ');
  target.append(caption, svg, notes);
}

export function mountStudioFretboard(host) {
  const panel = document.createElement('details'); panel.id = 'studio-fretboard'; panel.className = 'panel studio-fretboard';
  const summary = document.createElement('summary'); summary.textContent = 'Braço';
  const controls = document.createElement('div'); controls.className = 'tool-row';
  const label = document.createElement('label'); label.textContent = 'Casas ';
  const range = document.createElement('select'); range.id = 'fretboard-range'; range.setAttribute('aria-label', 'Região do braço');
  for (const [value, text] of [[0, '0–12'], [12, '12–24']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; range.append(option); }
  label.append(range);
  const context = document.createElement('strong'); context.id = 'fretboard-context';
  // As notas do acorde que vem a seguir entram em contorno tracejado, por cima
  // das marcações de agora — nada do desenho atual sai do lugar.
  const nextLabel = document.createElement('label'); nextLabel.className = 'toggle';
  const nextOverlay = document.createElement('input'); nextOverlay.type = 'checkbox'; nextOverlay.id = 'fretboard-next-overlay';
  nextLabel.append(nextOverlay, ' Notas do próximo acorde (tracejado)');
  controls.append(label, context, nextLabel);
  const scroll = document.createElement('div'); scroll.className = 'fretboard-scroll';
  const table = document.createElement('table'); table.id = 'fretboard-notes'; table.className = 'fretboard-notes'; scroll.append(table);
  const legend = document.createElement('p'); legend.className = 'tool-hint muted'; legend.textContent = 'T = fundamental (destaque forte); 3, 5 e 7 = graus do acorde. ♭/♯, suspensões e extensões mostram os intervalos reais. Sem acorde, a escala do tom. Cordas: aguda em cima, grave embaixo. O contorno tracejado, quando ligado, mostra as notas do próximo acorde na posição do áudio. A forma de dedilhado escolhida em “Formas de dedilhado” entra com contorno próprio sobre estas marcas.';
  panel.append(summary, controls, scroll, legend); document.getElementById('studio-inspector').after(panel);
  const diagram = document.createElement('figure'); diagram.id = 'chord-diagram'; diagram.className = 'chord-diagram'; diagram.hidden = true;
  document.getElementById('chord-inspector').append(diagram);
  let session; let selected; let events = []; let positionValue = { mode: 'idle', tick: 0 }; let hidden = true;
  let boardSignature = ''; let diagramSignature = '';
  // Formas de dedilhado (A3): o editor vive DENTRO deste painel e o destaque da
  // forma escolhida entra na mesma tabela, sem HTML novo no app.
  const shapes = mountFingeringShapesInFretboard({
    panel,
    table,
    repaint: () => { boardSignature = ''; paintBoard(); },
  });
  function paintBoard() {
    if (!session || !panel.open) return;
    const profile = getInstrumentProfile(session);
    const value = fretboardContext(session, selected, events, positionValue, hidden);
    const next = nextOverlay.checked && !hidden ? chordNowNext(session, positionValue.tick ?? 0)?.next?.chord ?? null : null;
    const nextTones = next ? new Set(chordToneRoles(next).keys()) : null;
    shapes.render(profile);
    const signature = JSON.stringify([profile, range.value, value.title, [...value.roles], next?.symbol ?? null, shapes.signature()]);
    if (signature === boardSignature) return;
    boardSignature = signature; context.textContent = value.title; table.replaceChildren(); table.setAttribute('aria-label', `Braço ${profile.type === 'bass' ? 'do baixo' : 'da guitarra'}, ${value.title}, casas ${range.value} a ${Number(range.value) + 12}${next ? `, contorno tracejado nas notas de ${next.symbol}` : ''}`);
    const head = table.createTHead().insertRow(); const corner = document.createElement('th'); corner.textContent = 'Corda'; head.append(corner);
    for (let fret = Number(range.value); fret <= Number(range.value) + 12; fret++) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = fret; head.append(th); }
    const body = table.createTBody();
    for (let index = profile.strings - 1; index >= 0; index--) {
      const row = body.insertRow(); const th = document.createElement('th'); th.scope = 'row'; th.textContent = `${profile.strings - index} · ${formatInstrumentNote(profile.tuning[index], profile)}`; row.append(th);
      for (let fret = Number(range.value); fret <= Number(range.value) + 12; fret++) {
        const pitch = profile.tuning[index] + fret; const cell = row.insertCell(); cell.dataset.string = profile.strings - index; cell.dataset.fret = fret;
        if (pitch > 127) { cell.textContent = '—'; continue; }
        const role = value.roles.get(pc(pitch)); cell.className = role ? pc(pitch) === value.root ? 'fretboard-tone fretboard-root' : 'fretboard-tone' : 'fretboard-other';
        const upcoming = nextTones?.has(pc(pitch)) ?? false;
        if (upcoming) cell.classList.add('fretboard-next');
        const note = document.createElement('span'); note.textContent = formatInstrumentNote(pitch, profile, { octave: false }); cell.append(note);
        if (role) { const degree = document.createElement('small'); degree.textContent = role; cell.append(degree); }
        cell.setAttribute('aria-label', `${formatInstrumentNote(pitch, profile)}, casa ${fret}${role ? `, ${role}` : ', fora da seleção'}${upcoming ? `, também no próximo acorde ${next.symbol}` : ''}`);
      }
    }
    // Destaque da forma de dedilhado (A3): entra depois das notas do acorde, na
    // mesma tabela, sem deslocar nenhuma marca do desenho atual.
    shapes.decorate(table, { profile, root: value.root, from: Number(range.value), to: Number(range.value) + 12 });
  }
  function render(nextSession, nextSelected, nextEvents) {
    session = nextSession; selected = nextSelected; events = nextEvents;
    const profile = getInstrumentProfile(session);
    const signature = JSON.stringify([selected, profile]);
    if (signature !== diagramSignature) {
      diagramSignature = signature;
      const voicing = selected && profile.type === 'guitar' ? generateGuitarVoicing(selected, profile.tuning) : null;
      diagram.hidden = !voicing; if (voicing) drawDiagram(selected, profile, voicing, diagram); else diagram.replaceChildren();
    }
    paintBoard();
  }
  range.addEventListener('change', paintBoard); nextOverlay.addEventListener('change', paintBoard); panel.addEventListener('toggle', paintBoard);
  return { render, position(value, options = {}) { positionValue = value; hidden = options.hidden ?? false; paintBoard(); } };
}
