// Biblioteca monofônica em 4/4: 1 tick = semicolcheia.
// As fontes verificam os ATAQUES. BPM e sustentações são escolhas de treino,
// não transcrições de gravações nem reprodução da articulação da percussão.

function freezeGroove(groove) {
  groove.notes.forEach(Object.freeze);
  groove.sources.forEach(Object.freeze);
  Object.freeze(groove.notes);
  Object.freeze(groove.sources);
  return Object.freeze(groove);
}

export const GROOVES = Object.freeze([
  {
    id: 'quarter-pulse',
    name: 'Pulso em semínimas',
    description: 'Exercício próprio: quatro ataques nos tempos 1, 2, 3 e 4. Pratique soltar e atacar novamente sem fundir notas adjacentes.',
    bars: 1,
    bpm: 90,
    notes: [
      { start: 0, duration: 4 },
      { start: 4, duration: 4 },
      { start: 8, duration: 4 },
      { start: 12, duration: 4 },
    ],
    sources: [],
    durationNote: 'Exercício próprio: sustente cada nota por uma semínima (4 ticks); o fim coincide com o próximo ataque, mas são notas distintas.',
  },
  {
    id: 'offbeats',
    name: 'Contratempos de colcheia',
    description: 'Exercício próprio: ataques no “&” de cada tempo, com silêncio no início do compasso. Mantenha o pulso mesmo nas pausas.',
    bars: 1,
    bpm: 90,
    notes: [
      { start: 2, duration: 2 },
      { start: 6, duration: 2 },
      { start: 10, duration: 2 },
      { start: 14, duration: 2 },
    ],
    sources: [],
    durationNote: 'Exercício próprio: sustente cada contratempo por uma colcheia (2 ticks), alternando com pausas de colcheia.',
  },
  {
    id: 'tresillo',
    name: 'Tresillo — 3+3+2',
    description: 'Três ataques em um compasso: 1, “&” do 2 e 4. Agrupamento 3+3+2 em colcheias, conforme a notação Bamboula/Tresillo da Berklee; não são tercinas.',
    bars: 1,
    bpm: 100,
    notes: [
      { start: 0, duration: 4 },
      { start: 6, duration: 4 },
      { start: 12, duration: 4 },
    ],
    sources: [
      { title: 'Berklee PULSE — The Foundational Rhythms of New Orleans (Bamboula/Tresillo)', url: 'https://pulse.berklee.edu/?id=4&lesson=376' },
      { title: 'Berklee PULSE — notação Bamboula/Tresillo', url: 'https://pulse.berklee.edu/content/public/pub_unit_assets/lessons/clave/Bamboula.jpg' },
    ],
    durationNote: 'Durações editoriais: sustente cada ataque por uma semínima (4 ticks), com pausas de 2 ticks após as duas primeiras notas. A fonte comprova os ataques, não estas sustentações nem o BPM sugerido.',
  },
  {
    id: 'cinquillo',
    name: 'Cinquillo — 2+1+2+1+2',
    description: 'Cinco ataques em um compasso: 1, 2, “&” do 2, “&” do 3 e 4. A notação da Berklee mostra o padrão sincopado associado à contradanza e ao danzón.',
    bars: 1,
    bpm: 90,
    notes: [
      { start: 0, duration: 2 },
      { start: 4, duration: 2 },
      { start: 6, duration: 2 },
      { start: 10, duration: 2 },
      { start: 12, duration: 2 },
    ],
    sources: [
      { title: 'Berklee PULSE — The Foundational Rhythms of New Orleans (Cinquillo)', url: 'https://pulse.berklee.edu/?id=4&lesson=376' },
      { title: 'Berklee PULSE — notação Cinquillo', url: 'https://pulse.berklee.edu/content/public/pub_unit_assets/lessons/clave/Cinquillo.jpg' },
    ],
    durationNote: 'Durações editoriais: todos os ataques duram uma colcheia (2 ticks). Notas adjacentes continuam separadas; os intervalos restantes são pausas. A fonte comprova os ataques, não estas sustentações nem o BPM sugerido.',
  },
  {
    id: 'son-clave-3-2',
    name: 'Son clave 3–2',
    description: 'Dois compassos: lado de três ataques em 1, “&” do 2 e 4; lado de dois ataques em 2 e 3. Uma única linha rítmica, não uma bateria completa.',
    bars: 2,
    bpm: 100,
    notes: [
      { start: 0, duration: 2 },
      { start: 6, duration: 2 },
      { start: 12, duration: 2 },
      { start: 20, duration: 2 },
      { start: 24, duration: 2 },
    ],
    sources: [
      { title: 'Berklee PULSE — The Clave (son 3–2 e 2–3)', url: 'https://pulse.berklee.edu/?id=4&lesson=14' },
      { title: 'Berklee PULSE — notação Son Clave 3–2', url: 'https://pulse.berklee.edu/content/public/pub_unit_assets/lessons/clave/Son-Clave.jpg' },
    ],
    durationNote: 'Durações editoriais: sustente cada ataque por uma colcheia (2 ticks) e respeite as pausas até o próximo ataque, inclusive entre compassos. A fonte comprova os ataques, não estas sustentações nem o BPM sugerido.',
  },
  {
    id: 'son-clave-2-3',
    name: 'Son clave 2–3',
    description: 'Dois compassos na direção inversa: ataques em 2 e 3, depois em 1, “&” do 2 e 4. O diagrama da Berklee mostra explicitamente essa ordem.',
    bars: 2,
    bpm: 100,
    notes: [
      { start: 4, duration: 2 },
      { start: 8, duration: 2 },
      { start: 16, duration: 2 },
      { start: 22, duration: 2 },
      { start: 28, duration: 2 },
    ],
    sources: [
      { title: 'Berklee PULSE — The Clave (son 3–2 e 2–3)', url: 'https://pulse.berklee.edu/?id=4&lesson=14' },
      { title: 'Berklee PULSE — diagrama Son Clave 2–3', url: 'https://pulse.berklee.edu/content/public/pub_unit_assets/lessons/lesson5_banded/2_3_son_graphic.png' },
    ],
    durationNote: 'Durações editoriais: sustente cada ataque por uma colcheia (2 ticks). Preserve o silêncio inicial e as pausas entre ataques; não tente imitar o decaimento das claves. A fonte comprova os ataques, não estas sustentações nem o BPM sugerido.',
  },
].map(freezeGroove));

export function loadGroove(id) {
  const groove = GROOVES.find((entry) => entry.id === id);
  if (!groove) throw new RangeError('Groove não encontrado na biblioteca.');
  return {
    notes: groove.notes.map((note, index) => ({
      id: `${groove.id}-${index}`,
      start: note.start,
      duration: note.duration,
    })),
    bpm: groove.bpm,
    bars: groove.bars,
  };
}
