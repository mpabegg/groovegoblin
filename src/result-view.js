// Tela de resultado de um treino concluído. Reutilizável por qualquer treinador:
//   mountResult(container, host, { comparisons }) -> { show, clear, render, act, focus, visible, model }
// host: getSession(), isBusy(), updateSession(patch, { notice }) -> bool,
//   retry() (treina de novo a frase da sessão), train(snapshot) (treina um
//   exercício à parte), calibrate(), opcional previousResult(key),
//   onVisibility(visible), closed(), resultShown(model).
// owner (capturado no início do treino): { kind: 'session', key } ou
//   { kind: 'exercise', snapshot }; a comparação usa owner + chave estável.
import { resultSummary, noteResults, barAccuracy, worstBar, attackMarks,
  comparisonKey, comparisonEntry, createComparisonMemory, exerciseFingerprint, tempoSuggestion } from './result-summary.js';
import { buildRhythmNotation, notationTickX } from './notation.js';
import { renderPracticeScore } from './studio-score.js';
import { phraseView } from './tablature.js';
import { mergeSession } from './studio-state.js';
import { instrumentPitchLabel } from './instrument-pitch-evaluation.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const RESULT_SYMBOLS = { ok: '✓', early: '‹', late: '›', missed: '×', wrong: '≠', extra: '+' };
export const RESULT_LABELS = { ok: 'no tempo', early: 'adiantada', late: 'atrasada', missed: 'omitida', wrong: 'nota errada', extra: 'ataque extra' };

// Mudou a frase, o andamento ou o trecho avaliado: o resultado deixa de
// descrever o exercício atual e sai de cena.
export function sessionOwner(session) {
  return { kind: 'session', key: JSON.stringify([exerciseFingerprint(session), session.bpm, session.loop.startBar, session.loop.endBar]) };
}

function el(document, tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'className') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

function svgEl(parent, name, attributes = {}, text) {
  const node = parent.ownerDocument.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  parent.append(node);
  return node;
}

const signed = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.round(Math.abs(value))} ms`;
const percent = ratio => `${Math.round(ratio * 100)}%`;
const range = ({ startBar, endBar }) => endBar - startBar === 1 ? `o compasso ${startBar + 1}` : `os compassos ${startBar + 1}–${endBar}`;

// O resultado é a partitura ANOTADA do treino: cifras, pauta rítmica e
// tablatura. Ritmo/Tablatura é uma preferência de EDIÇÃO da partitura do
// Estúdio/Treinar — no resultado a Tab entra sempre, com o instrumento e as
// cordas já escolhidos, senão o resultado ficaria sem a camada que o usuário
// vê na hora de conferir a execução. O renderizador é o MESMO
// (renderPracticeScore); a vista é só um parâmetro, sem segundo motor.
function scoreViewSession(session) {
  return phraseView(session) === 'tab' ? session : {
    ...session,
    extensions: { ...session.extensions, studio: { ...session.extensions?.studio, phraseView: 'tab' } },
  };
}

function rowText(row, status) {
  const rep = `Repetição ${row.repetition}`;
  if (status === 'missed') return `${rep}: omitida`;
  const pitch = status === 'wrong' ? ` · ${instrumentPitchLabel(row) || 'altura diferente'}` : '';
  return `${rep}: ${signed(row.onsetMs)} · ${RESULT_LABELS[status === 'wrong' ? row.onset : status]}${pitch}`;
}

export function mountResult(container, host, { comparisons = createComparisonMemory() } = {}) {
  const document = container.ownerDocument;
  let model = null;

  function setVisible(visible) {
    container.hidden = !visible;
    host.onVisibility?.(visible);
  }

  function show({ session, results, owner = sessionOwner(host.getSession()), note = '', key = null }) {
    const summary = resultSummary(results, session);
    // A chave estável pode vir do host (biblioteca); o fallback é material,
    // trecho, andamento, repetições, modo, objetivo e origem.
    const identity = key ?? comparisonKey(session, results, owner.kind === 'exercise' ? 'exercise' : 'session');
    const previous = host.previousResult?.(identity) ?? comparisons.previous(identity);
    comparisons.record(identity, comparisonEntry(summary));
    model = { session, results, summary, owner, note, key: identity, previous, repetition: 'all', suggestion: tempoSuggestion(summary, results.bpm) };
    host.resultShown?.(model);
    render();
    return model;
  }

  function clear() {
    model = null;
    container.replaceChildren();
    setVisible(false);
  }

  function stale() {
    return model.owner.kind === 'session' && sessionOwner(host.getSession()).key !== model.owner.key;
  }

  // Ações explícitas: na frase da sessão passam pelo histórico normal (Desfazer);
  // num exercício à parte alteram somente a cópia executada que será treinada,
  // preservando modo e origem do exercício sem tocar nas notas autorais.
  function act(kind) {
    if (!model || host.isBusy?.()) return false;
    const { owner, results, summary } = model;
    const tempo = summary.actions;
    let patch = null, notice = null;
    if (kind === 'slower' || kind === 'faster') {
      const bpm = tempo[kind]; if (bpm === null) return false;
      patch = { bpm }; notice = `Andamento ${results.bpm} → ${bpm} BPM para o próximo treino.`;
    } else if (kind === 'suggest') {
      const suggestion = model.suggestion; if (!suggestion) return false;
      patch = { bpm: suggestion.bpm };
      notice = `Andamento ${results.bpm} → ${suggestion.bpm} BPM pela sugestão do resultado.`;
    } else if (kind === 'loop') {
      const weak = tempo.loop; if (!weak) return false;
      patch = { loop: { startBar: weak.startBar, endBar: weak.endBar } };
      notice = `Loop em ${range(weak)} para treinar o trecho mais fraco.`;
    } else if (kind !== 'retry') return false;
    if (owner.kind === 'exercise') {
      host.train(patch ? mergeSession(owner.snapshot, patch) : owner.snapshot);
      return true;
    }
    if (patch && !host.updateSession(patch, { notice })) return false;
    host.retry();
    return true;
  }

  function renderScore(box) {
    const { session, results, repetition } = model;
    const outcomes = noteResults(results, repetition);
    const score = el(document, 'div', { className: 'rhythm-score result-score', 'aria-label': 'Partitura anotada com o resultado de cada nota, com cifras e tablatura' });
    box.append(score);
    // Sempre com a vista Tab: o resultado é a partitura anotada completa.
    const scoreSession = scoreViewSession(session);
    let systems = [];
    try { systems = renderPracticeScore(score, buildRhythmNotation(scoreSession.notes, scoreSession), scoreSession, { strokes: false }); }
    catch { score.append(el(document, 'p', { className: 'muted', text: 'Partitura indisponível para esta frase.' })); return; }
    // Cada sistema ganha um invólucro do tamanho da própria partitura: a faixa
    // de aproveitamento acompanha as barras desenhadas e a partitura nunca é
    // ampliada além do tamanho de projeto (o caso completo, 4 compassos em
    // tablatura de 6 cordas, precisa caber em 1440x900).
    const holders = systems.map(({ svg }) => {
      const holder = el(document, 'div', { className: 'result-holder' });
      svg.replaceWith(holder); holder.append(svg);
      return holder;
    });
    for (const { svg } of systems) {
      const staffY = Number(svg.dataset.staffY);
      for (const node of svg.querySelectorAll('.rhythm-note, .score-tab-note')) {
        const outcome = outcomes.get(node.dataset.noteId);
        if (!outcome) { node.classList.add('result-outside'); continue; }
        node.classList.add(`result-${outcome.status}`); node.dataset.result = outcome.status;
        const detail = `${RESULT_SYMBOLS[outcome.status]} ${RESULT_LABELS[outcome.status]}${repetition === 'all' && results.repetitions > 1 ? ' (mais frequente)' : ''}. ${outcome.rows.map(row => rowText(row, outcome.status)).join('; ')}.`;
        const title = node.querySelector(':scope > title') ?? svgEl(node, 'title');
        title.textContent = `${title.textContent ? `${title.textContent} ` : ''}Resultado: ${detail}`;
        if (node.hasAttribute('aria-label')) node.setAttribute('aria-label', `${node.getAttribute('aria-label')}. Resultado: ${detail}`);
        if (node.classList.contains('rhythm-note') && node.dataset.tiedFrom !== 'true') {
          const head = node.querySelector('ellipse');
          if (head) svgEl(node, 'text', { class: 'result-symbol', x: head.getAttribute('cx'), y: staffY + 34, 'text-anchor': 'middle', 'aria-hidden': 'true' }, RESULT_SYMBOLS[outcome.status]);
        }
      }
    }
    // Ataques sem nota escrita (extras) e ataques livres ficam nas posições
    // reais medidas, não na grade esperada.
    for (const mark of attackMarks(results, session, repetition)) {
      const system = systems.find(item => mark.tick >= item.system.barOffset * item.system.ticksPerBar
        && mark.tick < (item.system.barOffset + item.system.bars) * item.system.ticksPerBar);
      if (!system) continue;
      const { svg, geometry } = system;
      const staffY = Number(svg.dataset.staffY);
      const x = notationTickX(system.system, geometry, mark.tick);
      const group = svgEl(svg, 'g', { class: `result-mark result-${mark.status}`, 'data-result': mark.status, tabindex: 0, role: 'img' });
      const repetitions = mark.rows.map(row => row.repetition);
      const repText = repetitions.length > 1 ? `repetições ${repetitions.join(' e ')}` : `repetição ${repetitions[0]}`;
      const label = mark.status === 'free'
        ? `Ataque livre, ${repText}: ${mark.rows.map(row => signed(row.deviationMs)).join('; ')} da subdivisão mais próxima`
        : `Ataque extra, ${repText}, compasso ${Math.floor(mark.tick / system.system.ticksPerBar) + 1}`;
      group.setAttribute('aria-label', label);
      svgEl(group, 'title', {}, label);
      svgEl(group, 'line', { x1: x, x2: x, y1: staffY - 24, y2: staffY + 20 });
      svgEl(group, 'text', { x, y: staffY - 28, 'text-anchor': 'middle', 'aria-hidden': 'true' }, mark.status === 'free' ? '•' : RESULT_SYMBOLS.extra);
    }
    if (results.mode === 'free') return;
    const bars = barAccuracy(results, session, repetition), worst = worstBar(bars);
    for (const [index, { system, geometry }] of systems.entries()) {
      const strip = el(document, 'div', { className: 'result-bars', role: 'list', 'aria-label': `Aproveitamento por compasso, compassos ${system.barOffset + 1} a ${system.barOffset + system.bars}` });
      for (const [offset, layout] of geometry.layouts.entries()) {
        const bar = bars.find(entry => entry.bar === system.barOffset + offset);
        const cell = el(document, 'div', { role: 'listitem', className: 'result-bar' });
        cell.style.left = `${(layout.left / geometry.width) * 100}%`; cell.style.width = `${(layout.width / geometry.width) * 100}%`;
        if (!bar || bar.ratio === null) {
          cell.classList.add('result-bar-empty');
          cell.textContent = bar ? '—' : '';
          cell.title = bar ? `Compasso ${bar.bar + 1}: sem notas` : 'Fora do loop';
        } else {
          const isWorst = worst && bar.bar === worst.bar;
          cell.classList.toggle('result-bar-worst', !!isWorst);
          cell.style.setProperty('--ratio', bar.ratio);
          cell.textContent = `${isWorst ? '▼ ' : ''}${percent(bar.ratio)}`;
          cell.title = `Compasso ${bar.bar + 1}: ${bar.ok} de ${bar.total} ataques no tempo${isWorst ? ' · o mais fraco' : ''}`;
          cell.setAttribute('aria-label', cell.title);
        }
        strip.append(cell);
      }
      holders[index]?.append(strip);
    }
  }

  function detailTable() {
    const { session, results, summary } = model;
    const attackOnly = !!results.instrument;
    const pitchColumn = attackOnly && results.goal === 'pitch';
    const details = el(document, 'details', { className: 'result-details' }, el(document, 'summary', { text: 'Detalhes por nota' }));
    if (model.note) details.append(el(document, 'p', { className: 'tool-hint muted', text: model.note }));
    details.append(el(document, 'p', { className: 'tool-hint muted', text: results.mode === 'free'
      ? 'Os desvios indicam distância à subdivisão mais próxima, não erros de interpretação. Negativo = antes; positivo = depois.'
      : `Tolerância automática: ±${Math.round(results.toleranceMs)} ms. Negativo = antes; positivo = depois. Referência ${session.bpm} BPM, ${session.meter.beats}/${session.meter.unit}.` }));
    for (const text of summary.feedback.advice) details.append(el(document, 'p', { text }));
    const headings = ['Repetição / nota', 'Ataque', 'Término', ...(pitchColumn ? ['Altura · ±50 cents'] : [])];
    const body = el(document, 'tbody');
    for (const [index, row] of results.rows.entries()) {
      const line = el(document, 'tr', {}, el(document, 'td', { text: `${row.repetition ?? 1} · ${row.kind === 'extra' ? 'Extra' : row.kind === 'missed' ? 'Omitida' : `Nota ${index + 1}`}` }));
      for (const type of ['onset', 'end']) {
        let text, className;
        if (attackOnly && type === 'end') text = 'Não avaliado';
        else if (row.kind === 'matched') { const value = Math.round(type === 'onset' ? row.onsetMs : row.endMs); text = `${value > 0 ? '+' : ''}${value} ms`; className = Math.abs(value) <= results.toleranceMs ? 'ok' : 'error-timing'; }
        else if (row.kind === 'free') {
          text = type === 'onset' ? `${row.actualStart.toFixed(3)} s · ${Math.round(row.onsetMs) > 0 ? '+' : ''}${Math.round(row.onsetMs)} ms da grade` : `${Math.round((row.actualEnd - row.actualStart) * 1000)} ms sustentados`;
          className = 'free-observation';
        } else { text = row.kind === 'missed' ? 'Omitida' : type === 'onset' ? 'Ataque extra' : `${Math.round((row.actualEnd - row.actualStart) * 1000)} ms`; className = row.kind === 'missed' ? 'missing' : 'extra'; }
        line.append(el(document, 'td', { text, className }));
      }
      if (pitchColumn) line.append(el(document, 'td', { text: instrumentPitchLabel(row), className: row.pitchStatus === 'correct' ? 'ok' : 'free-observation' }));
      body.append(line);
    }
    details.append(el(document, 'div', { className: 'table-scroll' }, el(document, 'table', {},
      el(document, 'thead', {}, el(document, 'tr', {}, ...headings.map(text => el(document, 'th', { text })))), body)));
    return details;
  }

  function render() {
    if (!model) { clear(); return; }
    if (stale()) { clear(); return; }
    const { results, summary, previous } = model;
    const verdict = summary.verdict;
    const busy = !!host.isBusy?.();
    const disclosure = container.querySelector('.result-details')?.open ?? false;
    const focusedAction = document.activeElement && container.contains(document.activeElement) ? document.activeElement.dataset.resultAction ?? null : null;
    container.replaceChildren();

    const heading = el(document, 'h3', { id: 'result-verdict', className: 'result-verdict', tabindex: '-1' });
    if (verdict.kind === 'attacks') heading.append(el(document, 'strong', { text: `${verdict.ok} de ${verdict.expected}` }), ' ataques no tempo');
    else if (verdict.kind === 'free') heading.append(el(document, 'strong', { text: String(verdict.count) }), ` ${verdict.count === 1 ? 'ataque observado' : 'ataques observados'} · execução livre`);
    else heading.textContent = 'Sem notas esperadas no trecho do loop';
    const fragments = el(document, 'ul', { className: 'result-fragments' });
    for (const fragment of summary.fragments) {
      const item = el(document, 'li', { dataset: { fragment: fragment.kind }, text: fragment.text });
      if (fragment.action === 'calibrate') {
        const link = el(document, 'button', { type: 'button', className: 'link-button', text: 'Calibrar', dataset: { resultAction: 'calibrate' } });
        link.addEventListener('click', () => host.calibrate());
        item.append(' · ', link);
      }
      fragments.append(item);
    }
    const head = el(document, 'div', { className: 'result-head' }, heading, fragments);
    if (previous && previous.ok !== null && verdict.kind === 'attacks') {
      head.append(el(document, 'p', { className: 'result-comparison', text: `Tentativa anterior: ${previous.ok} de ${previous.expected}` }));
    }
    const close = el(document, 'button', { type: 'button', className: 'result-close', 'aria-label': 'Fechar resultado e voltar à área de toque', title: 'Fechar resultado', text: '×', dataset: { resultAction: 'close' } });
    close.addEventListener('click', () => { clear(); host.closed?.(); });
    head.append(close);
    container.append(head);

    const tools = el(document, 'div', { className: 'result-tools' });
    if (results.repetitions > 1) {
      const group = el(document, 'div', { className: 'result-repetitions', role: 'group', 'aria-label': 'Repetição exibida na partitura' });
      for (const value of ['all', ...Array.from({ length: results.repetitions }, (_, index) => index + 1)]) {
        const button = el(document, 'button', { type: 'button', text: value === 'all' ? 'Todas' : String(value), 'aria-pressed': String(model.repetition === value), dataset: { resultAction: `rep-${value}` }, 'aria-label': value === 'all' ? 'Todas as repetições: resultado mais frequente de cada nota' : `Repetição ${value}` });
        button.addEventListener('click', () => { model.repetition = value; render(); });
        group.append(button);
      }
      tools.append(group);
    }
    tools.append(el(document, 'p', { className: 'result-legend', 'aria-label': 'Legenda' },
      ...['ok', 'early', 'late', 'missed', ...(results.goal === 'pitch' ? ['wrong'] : []), 'extra'].map(status => el(document, 'span', { className: `result-${status}`, text: `${RESULT_SYMBOLS[status]} ${RESULT_LABELS[status]}` }))));
    container.append(tools);
    renderScore(container);

    const tempo = summary.actions, weak = summary.weak;
    const next = el(document, 'div', { className: 'result-actions', role: 'group', 'aria-label': 'Próximo passo' });
    const action = (kind, text, key, primary = false) => {
      const button = el(document, 'button', { type: 'button', className: primary ? 'primary' : '', dataset: { resultAction: kind }, 'aria-keyshortcuts': key.aria, disabled: busy });
      button.append(text, ' ', el(document, 'kbd', { text: key.label }));
      button.addEventListener('click', () => act(kind));
      next.append(button);
    };
    action('retry', 'Tentar de novo', { label: 'Enter', aria: 'Enter' }, true);
    if (weak) action('loop', `Repetir só ${range(weak)}`, { label: 'L', aria: 'L' });
    if (tempo.slower !== null) action('slower', '10 BPM mais lento', { label: '−', aria: '-' });
    if (tempo.faster !== null) action('faster', '4 BPM mais rápido', { label: '+', aria: '+' });
    container.append(next);
    if (model.suggestion) {
      const suggestion = model.suggestion;
      const line = el(document, 'p', { className: 'result-suggestion', role: 'status', dataset: { suggestion: suggestion.direction } });
      line.append(suggestion.direction === 'up'
        ? `Sugestão: ${percent(suggestion.ratio)} dos ataques no tempo · experimente +${suggestion.delta} BPM (${suggestion.bpm} BPM) no próximo treino. Nada mudou automaticamente.`
        : `Sugestão: ${percent(suggestion.ratio)} dos ataques no tempo · consolide ${suggestion.delta} BPM (${suggestion.bpm} BPM) antes de subir. Nada mudou automaticamente.`);
      if (suggestion.direction === 'down') {
        const apply = el(document, 'button', { type: 'button', dataset: { resultAction: 'suggest' }, disabled: busy, text: `Aplicar sugestão · ${suggestion.bpm} BPM` });
        apply.addEventListener('click', () => act('suggest'));
        line.append(' ', apply);
      }
      container.append(line);
    }
    const details = detailTable(); details.open = disclosure; container.append(details);
    setVisible(true);
    if (focusedAction) container.querySelector(`[data-result-action="${focusedAction}"]`)?.focus({ preventScroll: true });
  }

  return {
    show, clear, render, act,
    focus() { container.querySelector('#result-verdict')?.focus({ preventScroll: true }); },
    get visible() { return !!model && !container.hidden; },
    get model() { return model; },
  };
}
