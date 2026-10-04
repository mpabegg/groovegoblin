import { REPETITIONS } from './feedback.js';

// Projeção pura da avaliação: uma janela por repetição do trecho do loop,
// não por compasso. Os metadados de matched pertencem a cada bloco (uma
// repetição pode conter várias notas); expected e actual recebem cópias
// independentes desses dados. Não recalculamos classificação nem deltas:
// ataque e término continuam independentes, inclusive quando a geometria
// real precisa ser recortada. clamped:true significa que a tentativa
// ultrapassou o FIM da janela. O fim visual é limitado a windowSeconds; uma
// extra inteiramente após a janela fica com start=end=windowSeconds. Onsets
// antecipados podem ser negativos: preservamos esses tempos relativos e
// recortamos só a geometria no render. No modo livre, cada toque vira um
// bloco "free" com o desvio para a subdivisão mais próxima.
// options: {session} (preferido) ou {bpm, bars} para resultados históricos.
export function buildTimelineData(results, options = {}) {
  const { session } = options;
  const bpm = results.bpm ?? session?.bpm ?? options.bpm;
  const bars = results.loopBars ?? (session ? session.loop.endBar - session.loop.startBar : options.bars);
  const barSeconds = results.barSeconds ?? 240 / bpm;
  const windowSeconds = results.repetitionSeconds ?? bars * barSeconds;
  const count = results.repetitions ?? REPETITIONS;
  const repetitions = Array.from({ length: count }, (_, index) => ({
    repetition: index + 1,
    windowSeconds,
    expected: [],
    actual: [],
  }));

  for (const row of results.rows) {
    const repetition = repetitions[row.repetition - 1];
    if (!repetition) continue;
    const offset = (row.repetition - 1) * windowSeconds;
    if (row.kind === 'matched' || row.kind === 'missed') {
      const expected = {
        start: row.expectedStart - offset,
        end: row.expectedEnd - offset,
        noteId: row.noteId,
        missed: row.kind === 'missed',
      };
      if (row.kind === 'matched') copyTiming(row, expected);
      repetition.expected.push(expected);
    }
    if (row.kind === 'matched' || row.kind === 'extra' || row.kind === 'free') {
      const relativeStart = row.actualStart - offset;
      const relativeEnd = row.actualEnd - offset;
      const actual = {
        start: Math.min(relativeStart, windowSeconds),
        end: Math.min(relativeEnd, windowSeconds),
        extra: row.kind === 'extra',
      };
      if (relativeStart > windowSeconds || relativeEnd > windowSeconds) {
        actual.clamped = true;
      }
      if (row.kind === 'matched') {
        actual.noteId = row.noteId;
        copyTiming(row, actual);
      }
      if (row.kind === 'free') {
        actual.free = true;
        actual.onsetMs = row.deviationMs;
        actual.onset = row.onset;
      }
      repetition.actual.push(actual);
    }
  }

  return {
    repetitions,
    toleranceMs: results.toleranceMs,
    matchWindowMs: results.matchWindowMs,
    barSeconds,
    bars,
    startBar: results.startBar ?? session?.loop.startBar ?? 0,
    mode: results.mode ?? 'strict',
  };
}

function copyTiming(row, block) {
  block.onsetMs = row.onsetMs;
  block.endMs = row.endMs;
  block.onset = row.onset;
  block.ending = row.ending;
}

// Classes para o CSS do app:
// timeline-repetition/title/ruler/bar/stage: seção, título, régua e área comum.
// timeline-reference e timeline-actual: camadas sobrepostas da referência/real.
// timeline-block: intervalo; missing/extra/clamped indicam ausência/sobra/corte.
// timeline-marker: borda temporal; timeline-onset/timeline-ending distinguem
// ATAQUE/TÉRMINO; timeline-marker-label é seu texto sempre visível.
// ok/early/late são aplicadas a CADA marcador, nunca uma pontuação agregada.
// Inline define somente geometria mínima; cores, espessuras e contraste são
// responsabilidade do CSS do app. Sem innerHTML, inclusive para IDs de notas.
// Render DOM não é testado na suíte node: o smoke de integração cobre o DOM.
export function renderTimeline(container, data) {
  const document = container.ownerDocument;
  const fragment = document.createDocumentFragment();

  for (const repetition of data.repetitions) {
    const label = `Repetição ${repetition.repetition}/${data.repetitions.length}`;
    const section = element(document, 'section', 'timeline-repetition');
    section.setAttribute('aria-label', label);
    section.append(element(document, 'h3', 'timeline-title', label));

    const ruler = element(document, 'div', 'timeline-ruler');
    ruler.setAttribute('aria-label', `Régua de ${data.bars} ${data.bars === 1 ? 'compasso' : 'compassos'}`);
    ruler.style.position = 'relative';
    ruler.style.minHeight = '1.5rem';
    for (let bar = 0; bar < data.bars; bar += 1) {
      const mark = element(document, 'span', 'timeline-bar', `Compasso ${(data.startBar ?? 0) + bar + 1}`);
      mark.style.position = 'absolute';
      mark.style.left = `${(bar / data.bars) * 100}%`;
      ruler.append(mark);
    }
    section.append(ruler);

    const stage = element(document, 'div', 'timeline-stage');
    stage.style.position = 'relative';
    stage.style.minHeight = '7rem';
    const reference = element(document, 'div', 'timeline-reference');
    const actual = element(document, 'div', 'timeline-actual');
    reference.setAttribute('aria-label', data.mode === 'free' ? 'Modo livre: sem frase de referência' : 'Notas esperadas (referência)');
    actual.setAttribute('aria-label', 'Notas tocadas');
    for (const layer of [reference, actual]) {
      layer.style.position = 'absolute';
      layer.style.inset = '0';
    }

    for (const block of repetition.expected) {
      const node = interval(document, block, repetition.windowSeconds, false);
      reference.append(node);
      if (block.missed) addMarkers(document, node, block, 'missing');
    }
    for (const block of repetition.actual) {
      const node = interval(document, block, repetition.windowSeconds, true);
      actual.append(node);
      addMarkers(document, node, block, block.extra ? 'extra' : null);
    }
    stage.append(reference, actual);
    section.append(stage);
    fragment.append(section);
  }

  container.replaceChildren(fragment);
}

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function interval(document, block, windowSeconds, actual) {
  const node = element(document, 'div', 'timeline-block');
  const start = Math.max(0, Math.min(block.start, windowSeconds));
  const end = Math.max(start, Math.min(block.end, windowSeconds));
  node.style.position = 'absolute';
  node.style.left = `${(start / windowSeconds) * 100}%`;
  node.style.width = `${((end - start) / windowSeconds) * 100}%`;
  node.style.top = actual ? '0.75rem' : '0.25rem';
  node.style.height = '1.25rem';
  if (block.missed) node.classList.add('missing');
  if (block.extra) node.classList.add('extra');
  if (block.clamped) node.classList.add('clamped');
  if (block.free) node.classList.add('free');
  const kind = actual ? (block.extra ? 'Nota extra' : block.free ? 'Toque livre' : 'Nota tocada') : 'Nota esperada';
  const note = block.noteId === undefined ? '' : ` ${block.noteId}`;
  const missing = block.missed ? ', não tocada' : '';
  const clamped = block.clamped ? ', recortada no fim da repetição' : '';
  const description = `${kind}${note}: ${block.start.toFixed(3)} a ${block.end.toFixed(3)} segundos${missing}${clamped}`;
  node.setAttribute('aria-label', description);
  node.title = description;
  return node;
}

function addMarkers(document, node, block, unmatched) {
  for (const isEnd of block.free ? [false] : [false, true]) {
    const name = isEnd ? 'TÉRMINO' : 'ATAQUE';
    const classification = unmatched ?? (isEnd ? block.ending : block.onset);
    const delta = isEnd ? block.endMs : block.onsetMs;
    const free = block.free ? ' da subdivisão mais próxima' : '';
    const text = unmatched === 'missing' ? 'ausente'
      : unmatched === 'extra' ? 'extra'
        : formatDelta(delta);
    const marker = element(document, 'span', `timeline-marker ${isEnd ? 'timeline-ending' : 'timeline-onset'} ${classification}`);
    marker.style.position = 'absolute';
    marker.style.left = isEnd ? '100%' : '0';
    marker.style.top = isEnd ? '3.5rem' : '1.75rem';
    const status = classification === 'ok' ? 'no tempo'
      : classification === 'early' ? 'antecipado'
        : classification === 'late' ? 'atrasado' : text;
    const note = block.noteId === undefined ? '' : ` da nota ${block.noteId}`;
    const clamped = isEnd && block.clamped ? ', posição recortada no fim da repetição' : '';
    marker.setAttribute('aria-label', `${name}${note}: ${text}${free}, ${status}${clamped}`);
    marker.append(element(document, 'span', 'timeline-marker-label', `${name} ${text}`));
    node.append(marker);
  }
}

function formatDelta(delta) {
  const milliseconds = Math.round(Math.abs(delta));
  const sign = milliseconds === 0 ? '' : delta < 0 ? '−' : '+';
  return `${sign}${milliseconds} ms`;
}
