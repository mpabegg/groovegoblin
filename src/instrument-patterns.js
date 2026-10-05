import { chordTimeline, getDiatonicChords } from './progression.js';
import { getInstrumentProfile } from './instrument-profile.js';
import { completeNote } from './model.js';
import { foldGeneratedPitch, encodePerformedNote } from './bass-study.js';

const pulse = (step, degree = 1) => Array.from({ length: 16 / step }, (_, index) => [index * step, step, degree]);
function recipe(instrument, id, name, description, events, { subdivision = 4, performed = false } = {}) {
  const notes = events.map(([start, duration, degree = 1, articulation = 'normal', velocity = 0.8], index) => Object.freeze({
    id: `${instrument}-${id}-${index}`, start, duration, degree, articulation, velocity,
  }));
  return Object.freeze({ id: `${instrument}-${id}`, instrument, name, description, bars: 1, bpm: 90,
    meter: Object.freeze({ beats: 4, unit: 4 }), subdivision, performed, notes: Object.freeze(notes), sources: Object.freeze([]),
    durationNote: instrument === 'bass'
      ? 'Graus relativos ao acorde no instante do ataque; sem acorde ativo, usa a tônica e os graus da tonalidade atual. Oitava mais próxima tocável nas casas 0–24; pausas e swing da sessão preservados.'
      : 'Estudo rítmico monofônico para tocar com a faixa de acordes; alturas seguem a tônica do acorde (ou do tom sem acorde ativo), na afinação atual.',
  });
}

export const BASS_PATTERNS = Object.freeze([
  recipe('bass', 'root-quarters', 'Tônica em semínimas', 'Pratique pulso e sustentação uniforme da tônica a cada troca de acorde.', pulse(4)),
  recipe('bass', 'root-fifth', 'Tônica e quinta', 'Pratique alternar tônica e quinta respeitando a qualidade de cada acorde.', [[0,4,1],[4,4,5],[8,4,1],[12,4,5]]),
  recipe('bass', 'octave-eighths', 'Oitavas em colcheias', 'Pratique saltos de oitava com ataques regulares e cordas abafadas.', pulse(2).map((event,index) => [event[0],event[1],index % 2 ? 8 : 1])),
  recipe('bass', 'walking-four', 'Walking de quatro notas', 'Pratique condução em semínimas com tônica, terça, quinta e sétima do acorde.', [[0,4,1],[4,4,3],[8,4,5],[12,4,7]]),
  recipe('bass', 'rock-eighths', 'Rock em colcheias', 'Pratique colcheias constantes na tônica, acentuando os tempos fortes.', pulse(2).map(event => [...event,'normal',event[0] % 4 ? 0.65 : 0.9])),
  recipe('bass', 'funk-rests', 'Funk: semicolcheias e pausas', 'Pratique síncopes, pausas e notas fantasma sem perder o pulso.', [[0,1,1,'accent',0.9],[3,1,8],[6,1,1],[7,1,1,'ghost',0.35],[10,1,5],[13,1,7],[15,1,1,'ghost',0.35]]),
  recipe('bass', 'reggae-one-drop', 'Reggae one-drop', 'Pratique deixar o primeiro tempo livre e apoiar a tônica no terceiro.', [[4,2,5],[8,4,1,'accent',0.9],[14,2,5]]),
  recipe('bass', 'bossa', 'Bossa: tônica e quinta', 'Pratique a antecipação do segundo apoio com tônica e quinta.', [[0,6,1],[6,2,5],[8,6,5],[14,2,1]]),
  recipe('bass', 'samba', 'Samba: apoio e antecipação', 'Pratique o apoio na quinta e as antecipações leves de semicolcheia.', [[0,2,1],[3,1,1,'ghost',0.4],[4,4,5,'accent',0.9],[8,2,1],[11,1,1,'ghost',0.4],[12,4,5,'accent',0.9]]),
  recipe('bass', 'baiao', 'Baião: tônica e quinta', 'Pratique a célula pontuada e o salto à quinta sem apressar a antecipação.', [[0,3,1],[3,5,5],[8,3,1],[11,5,5]]),
]);
export const GUITAR_PATTERNS = Object.freeze([
  recipe('guitar', 'down-quarters', 'Quatro batidas para baixo', 'Pratique quatro palhetadas para baixo alinhadas aos tempos.', pulse(4)),
  recipe('guitar', 'alternating-eighths', 'Colcheias alternadas', 'Pratique alternar baixo/cima mantendo o movimento da mão.', pulse(2)),
  recipe('guitar', 'syncopated-pop', 'Pop com síncope', 'Pratique sustentar antecipações e manter a mão em movimento nas pausas.', [[0,2],[4,2],[6,4],[10,2],[12,4]]),
  recipe('guitar', 'funk-ghost', 'Funk com notas fantasma', 'Pratique semicolcheias com abafamentos leves entre os acentos.', pulse(1).map(event => [...event,event[0] % 4 === 0 ? 'accent' : 'ghost',event[0] % 4 === 0 ? 0.9 : 0.35])),
  recipe('guitar', 'offbeat-reggae', 'Reggae no contratempo', 'Pratique palhetadas curtas no contratempo e silêncio nos tempos.', [[2,1,1,'staccato'],[6,1,1,'staccato'],[10,1,1,'staccato'],[14,1,1,'staccato']]),
  recipe('guitar', 'bossa', 'Bossa: síncopes de acordes', 'Pratique os apoios e antecipações da levada com a faixa de acordes.', [[0,2],[6,2],[10,2],[12,2]]),
  recipe('guitar', 'baiao', 'Baião: palhetada pontuada', 'Pratique acentos da célula de baião com movimento contínuo da mão.', [[0,3],[3,3],[6,2],[8,3],[11,3],[14,2]]),
  recipe('guitar', 'shuffle', 'Shuffle em tercinas', 'Pratique o balanço longo-curto da tercina sem aplicar swing duas vezes.', Array.from({ length: 4 }, (_,index) => [[index*4,8/3],[index*4+8/3,4/3]]).flat(), { subdivision: 3, performed: true }),
]);
export const INSTRUMENT_PATTERNS = Object.freeze([...GUITAR_PATTERNS, ...BASS_PATTERNS]);

export function loadInstrumentPattern(id) {
  const pattern = INSTRUMENT_PATTERNS.find(item => item.id === id);
  if (!pattern) throw new RangeError('Padrão de instrumento não encontrado.');
  return { ...pattern, meter: { ...pattern.meter }, notes: pattern.notes.map(note => ({ ...note })) };
}

function degreeInterval(chord, degree) {
  if (degree === 1) return 0;
  if (degree === 8) return 12;
  const candidates = { 3: [4,3,5,2], 5: [7,6,8], 7: [10,11,9] }[degree];
  if (!candidates) throw new TypeError('Grau de baixo não suportado.');
  const present = candidates.find(interval => chord.notes.some(note => (note.midi - chord.root + 120) % 12 === interval));
  if (present !== undefined) return present;
  // Triads have no written seventh: extend major/minor quality, not an arbitrary fixed pitch.
  if (degree === 7) return chord.quality === 'dim' ? 9 : chord.notes.some(note => (note.midi - chord.root + 120) % 12 === 3) ? 10 : 11;
  return candidates[0];
}

// Resolve AFTER repetition and accepted meter changes: every occurrence sees its own session harmony.
export function resolveInstrumentPatternNotes(session, pattern, notes) {
  const profile = getInstrumentProfile(session);
  const timeline = chordTimeline(session);
  const fallback = getDiatonicChords(session.progression.keyId)[0];
  const nominalLow = pattern.instrument === 'bass' ? profile.tuning[0] : Math.max(profile.tuning[0], 52);
  return notes.map(note => {
    const chord = timeline.find(event => note.start >= event.start - 1e-6 && note.start < event.start + event.duration - 1e-6)?.chord ?? fallback;
    const root = nominalLow + ((chord.root - nominalLow % 12 + 12) % 12);
    const pitch = foldGeneratedPitch(root + degreeInterval(chord, note.degree), profile);
    const timed = pattern.performed ? encodePerformedNote(session, note) : note;
    return completeNote({ ...timed, pitch });
  });
}
