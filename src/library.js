import { completeNote } from './model.js';

// Biblioteca monofônica: 1 tick = semicolcheia; compasso 4/4 salvo indicação
// (meter), grade de subdivisão e swing opcionais por groove.
// As fontes verificam os ATAQUES. BPM e sustentações são escolhas de treino,
// não transcrições de gravações nem reprodução da articulação da percussão.
// Exercícios próprios não têm fonte: são estudos de leitura/coordenação.

function freezeGroove(groove) {
  if (groove.meter) Object.freeze(groove.meter);
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
  {
    id: 'swing-eighths',
    name: 'Colcheias com swing',
    description: 'Exercício próprio: colcheias em 4/4 tocadas com swing de tercina (2:1). A grade escrita é reta; o swing desloca cada contratempo para a última tercina do tempo.',
    bars: 1,
    bpm: 110,
    swing: 1 / 3,
    notes: [
      { start: 0, duration: 2 },
      { start: 2, duration: 2 },
      { start: 6, duration: 2 },
      { start: 8, duration: 2 },
      { start: 10, duration: 2 },
      { start: 14, duration: 2 },
    ],
    sources: [],
    durationNote: 'Exercício próprio: cada nota dura uma colcheia escrita; com swing, a primeira colcheia de cada par soa mais longa.',
  },
  {
    id: 'eighth-triplets',
    name: 'Tercinas de colcheia',
    description: 'Exercício próprio: três ataques iguais por tempo (grade de tercinas). Conte “1-tri-na, 2-tri-na” sem acelerar na virada do tempo.',
    bars: 1,
    bpm: 80,
    subdivision: 3,
    notes: Array.from({ length: 12 }, (_, index) => ({ start: (index * 4) / 3, duration: 4 / 3 })),
    sources: [],
    durationNote: 'Exercício próprio: cada nota dura um terço de semínima; notas adjacentes continuam ataques distintos.',
  },
  {
    id: 'three-against-two',
    name: 'Três contra dois (tercinas de semínima)',
    description: 'Exercício próprio: três ataques iguais a cada dois tempos, contra o pulso de semínimas do metrônomo — a polirritmia 3:2 mais comum.',
    bars: 1,
    bpm: 72,
    subdivision: 3,
    notes: Array.from({ length: 6 }, (_, index) => ({ start: (index * 8) / 3, duration: 8 / 3 })),
    sources: [],
    durationNote: 'Exercício próprio: cada nota dura dois terços de tempo; só os ataques 1 e 4 coincidem com o pulso.',
  },
  {
    id: 'seven-eight-223',
    name: '7/8 em 2+2+3',
    description: 'Exercício próprio: um ataque em cada início de grupo do compasso de sete colcheias (2+2+3). O metrônomo acentua os mesmos grupos.',
    bars: 2,
    bpm: 90,
    meter: { beats: 7, unit: 8 },
    subdivision: 2,
    notes: [
      { start: 0, duration: 4 },
      { start: 4, duration: 4 },
      { start: 8, duration: 6 },
      { start: 14, duration: 4 },
      { start: 18, duration: 4 },
      { start: 22, duration: 6 },
    ],
    sources: [],
    durationNote: 'Exercício próprio: dois grupos de semínima e um de semínima pontuada por compasso, sem pausas.',
  },
  {
    id: 'twelve-eight-bell',
    name: 'Sino em 12/8 (x.x.xx.x.x.x)',
    description: 'Exercício próprio sobre o padrão de sete ataques em doze colcheias muito usado em músicas da África Ocidental e afro-cubanas. Sinta quatro pulsos de semínima pontuada.',
    bars: 1,
    bpm: 70,
    meter: { beats: 12, unit: 8 },
    subdivision: 2,
    notes: [0, 2, 4, 5, 7, 9, 11].map(eighth => ({ start: eighth * 2, duration: 2 })),
    sources: [],
    durationNote: 'Exercício próprio: cada ataque dura uma colcheia; posições escritas aqui, sem atribuição a uma gravação ou fonte específica.',
  },
].map(freezeGroove));

export function loadGroove(id) {
  const groove = GROOVES.find((entry) => entry.id === id);
  if (!groove) throw new RangeError('Groove não encontrado na biblioteca.');
  return {
    notes: groove.notes.map((note, index) => completeNote({
      id: `${groove.id}-${index}`,
      ...note,
    })),
    bpm: groove.bpm,
    bars: groove.bars,
    meter: { ...(groove.meter ?? { beats: 4, unit: 4 }) },
    subdivision: groove.subdivision ?? 4,
    swing: groove.swing ?? 0,
    swingUnit: 'eighth',
  };
}
