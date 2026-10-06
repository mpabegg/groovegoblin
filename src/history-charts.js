// Gráficos SVG do histórico/Percurso (rodada 4, item 5): dependência zero,
// SVG puro construído no DOM.
//
// Todo gráfico é um `role="img"` com nome acessível e, além disso, RÓTULOS DE
// TEXTO visíveis (eixos, alvo, valores e datas) — a leitura não depende só de
// cor ou de hover. Cada marca tem <title> com data e valor reais.

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'className') node.setAttribute('class', String(value));
    else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function shortDayLabel(dayKey) {
  if (typeof dayKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return '—';
  return `${dayKey.slice(8, 10)}/${dayKey.slice(5, 7)}`;
}

function dateOnlyLabel(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'sem data';
  const date = new Date(ms);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}`;
}

function stampLabel(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'sem data';
  const date = new Date(ms);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()} ${hours}:${minutes}`;
}

function frame({ className, ariaLabel, height, children }) {
  return svgEl('svg', {
    className: `history-chart ${className}`,
    viewBox: `0 0 720 ${height}`,
    width: '720',
    height: String(height),
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': ariaLabel,
  }, [svgEl('title', { text: ariaLabel }), ...children]);
}

function emptyChart(className, text) {
  return frame({
    className: `${className} history-chart-empty`,
    height: 90,
    ariaLabel: text,
    children: [svgEl('text', { x: '16', y: '52', className: 'history-chart-empty-text', text })],
  });
}

// Andamento por treino com a LINHA DO ALVO. Cada ponto é um treino datado; o
// material gerado tem marca própria para não se confundir com o autoral.
export function bpmChart({ points = [], targetBPM = null, bestAuthoredBpm = null } = {}) {
  const list = points.filter(point => typeof point?.bpm === 'number' && Number.isFinite(point.bpm));
  if (list.length === 0) return emptyChart('history-chart-bpm', 'Nenhum treino com BPM registrado.');
  const width = 720;
  const height = 240;
  const left = 58;
  const right = 18;
  const top = 26;
  const bottom = 40;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const values = list.map(point => point.bpm);
  if (typeof targetBPM === 'number' && Number.isFinite(targetBPM)) values.push(targetBPM);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < 10) { const middle = (min + max) / 2; min = Math.floor(middle - 6); max = Math.ceil(middle + 6); }
  else { min = Math.floor(min - 2); max = Math.ceil(max + 2); }
  const xOf = index => left + (list.length <= 1 ? plotWidth / 2 : (index / (list.length - 1)) * plotWidth);
  const yOf = bpm => top + plotHeight - ((bpm - min) / (max - min)) * plotHeight;
  const marks = list.map((point, index) => {
    const cx = xOf(index);
    const cy = yOf(point.bpm);
    const label = `${stampLabel(point.atMs)} · ${point.bpm} BPM · ${point.source === 'generated' ? 'material gerado' : 'material autoral'}`;
    return svgEl('g', { className: `history-mark history-mark-${point.source}` }, [
      svgEl('circle', { cx: String(cx), cy: String(cy), r: '4', className: 'history-mark-dot' }),
      svgEl('title', { text: label }),
      list.length <= 12 ? svgEl('text', { x: String(cx), y: String(Math.max(12, cy - 8)), className: 'history-mark-value', text: String(point.bpm) }) : null,
      svgEl('text', { x: String(cx), y: String(height - 8), className: 'history-chart-axis', text: dateOnlyLabel(point.atMs) }),
    ]);
  });
  const children = [
    svgEl('line', { x1: String(left), y1: String(top), x2: String(left), y2: String(top + plotHeight), className: 'history-chart-axis-line' }),
    svgEl('line', { x1: String(left), y1: String(top + plotHeight), x2: String(width - right), y2: String(top + plotHeight), className: 'history-chart-axis-line' }),
    svgEl('text', { x: '10', y: String(top + 6), className: 'history-chart-label', text: `${max} BPM` }),
    svgEl('text', { x: '10', y: String(top + plotHeight), className: 'history-chart-label', text: `${min} BPM` }),
    svgEl('polyline', {
      className: 'history-chart-line',
      points: list.map((point, index) => `${xOf(index)},${yOf(point.bpm)}`).join(' '),
    }),
    ...marks,
  ];
  if (typeof targetBPM === 'number' && Number.isFinite(targetBPM)) {
    const targetY = yOf(targetBPM);
    children.push(
      svgEl('line', { x1: String(left), y1: String(targetY), x2: String(width - right), y2: String(targetY), className: 'history-chart-target' }),
      svgEl('text', { x: String(left + 6), y: String(Math.max(12, targetY - 6)), className: 'history-chart-target-label', text: `alvo ${targetBPM} BPM` }),
    );
  }
  if (typeof bestAuthoredBpm === 'number' && Number.isFinite(bestAuthoredBpm)) {
    children.push(svgEl('text', { x: String(width - right), y: '14', 'text-anchor': 'end', className: 'history-chart-note', text: `melhor autoral: ${bestAuthoredBpm} BPM` }));
  }
  const ariaLabel = `Andamento por treino: ${list.length} treino(s), de ${Math.min(...list.map(point => point.bpm))} a ${Math.max(...list.map(point => point.bpm))} BPM`
    + (typeof targetBPM === 'number' && Number.isFinite(targetBPM) ? `, alvo ${targetBPM} BPM` : '')
    + (typeof bestAuthoredBpm === 'number' && Number.isFinite(bestAuthoredBpm) ? `, melhor autoral ${bestAuthoredBpm} BPM` : '')
    + '. As datas de cada marca estão na lista de treinos.';
  return frame({ className: 'history-chart-bpm', ariaLabel, height, children });
}

// Aproveitamento por treino (0–100%). Modo livre não tem percentual e aparece
// como marca própria, nunca como 0%.
export function accuracyChart({ points = [] } = {}) {
  const rated = points.filter(point => typeof point?.percent === 'number' && Number.isFinite(point.percent));
  const unrated = points.length - rated.length;
  if (points.length === 0) return emptyChart('history-chart-accuracy', 'Nenhum treino registrado.');
  const width = 720;
  const height = 240;
  const left = 58;
  const right = 18;
  const top = 26;
  const bottom = 40;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const slot = plotWidth / Math.max(1, points.length);
  const barWidth = Math.max(6, Math.min(28, slot * 0.62));
  const yOf = percent => top + plotHeight - (percent / 100) * plotHeight;
  const children = [
    svgEl('line', { x1: String(left), y1: String(top), x2: String(left), y2: String(top + plotHeight), className: 'history-chart-axis-line' }),
    svgEl('line', { x1: String(left), y1: String(top + plotHeight), x2: String(width - right), y2: String(top + plotHeight), className: 'history-chart-axis-line' }),
    svgEl('text', { x: '10', y: String(top + 6), className: 'history-chart-label', text: '100%' }),
    svgEl('text', { x: '14', y: String(top + plotHeight / 2 + 4), className: 'history-chart-label', text: '50%' }),
    svgEl('text', { x: '22', y: String(top + plotHeight), className: 'history-chart-label', text: '0%' }),
  ];
  points.forEach((point, index) => {
    const center = left + slot * (index + 0.5);
    const label = `${stampLabel(point.atMs)} · ${point.source === 'generated' ? 'material gerado' : 'material autoral'}`
      + (typeof point.percent === 'number' ? ` · ${point.percent}%` : ' · sem percentual (modo livre)');
    if (typeof point.percent === 'number') {
      const barHeight = Math.max(3, (point.percent / 100) * plotHeight);
      children.push(svgEl('g', { className: `history-mark history-mark-${point.source}` }, [
        svgEl('rect', {
          x: String(center - barWidth / 2), y: String(top + plotHeight - barHeight),
          width: String(barWidth), height: String(barHeight), rx: '3', className: 'history-chart-bar',
        }),
        svgEl('title', { text: label }),
        points.length <= 12 ? svgEl('text', { x: String(center), y: String(Math.max(12, top + plotHeight - barHeight - 6)), 'text-anchor': 'middle', className: 'history-mark-value', text: `${point.percent}%` }) : null,
      ]));
    } else {
      children.push(svgEl('g', { className: 'history-mark history-mark-free' }, [
        svgEl('line', {
          x1: String(center - barWidth / 2), y1: String(top + plotHeight - 4),
          x2: String(center + barWidth / 2), y2: String(top + plotHeight - 4), className: 'history-chart-free',
        }),
        svgEl('title', { text: label }),
      ]));
    }
    children.push(svgEl('text', { x: String(center), y: String(height - 8), 'text-anchor': 'middle', className: 'history-chart-axis', text: dateOnlyLabel(point.atMs) }));
  });
  const ratedValues = rated.map(point => point.percent);
  const ariaLabel = `Aproveitamento por treino: ${rated.length} treino(s) avaliado(s)`
    + (ratedValues.length > 0 ? `, de ${Math.min(...ratedValues)}% a ${Math.max(...ratedValues)}%` : '')
    + (unrated > 0 ? `; ${unrated} sem percentual (modo livre)` : '')
    + '. As datas de cada treino estão na lista abaixo.';
  return frame({ className: 'history-chart-accuracy', ariaLabel, height, children });
}

// Tempo real por dia local (últimos 28 dias). Dias sem prática aparecem com
// zero; as datas são as do calendário local, não um múltiplo de 24 h.
export function dailyBars({ rows = [], ariaLabel = 'Tempo praticado por dia' } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return emptyChart('history-chart-days', 'Sem janela de dias para mostrar.');
  const width = 720;
  const height = 210;
  const left = 14;
  const right = 14;
  const top = 18;
  const bottom = 34;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const max = Math.max(1, ...list.map(row => row.ms));
  const slot = plotWidth / list.length;
  const barWidth = Math.max(4, Math.min(20, slot * 0.7));
  const children = [
    svgEl('line', { x1: String(left), y1: String(top + plotHeight), x2: String(width - right), y2: String(top + plotHeight), className: 'history-chart-axis-line' }),
  ];
  list.forEach((row, index) => {
    const center = left + slot * (index + 0.5);
    const barHeight = row.ms > 0 ? Math.max(3, (row.ms / max) * plotHeight) : 2;
    const minutes = Math.round(row.ms / 60000);
    const seconds = Math.round(row.ms / 1000);
    const value = row.ms > 0 ? (minutes >= 1 ? `${minutes} min` : `${seconds} s`) : 'sem prática';
    children.push(svgEl('g', { className: `history-day${row.ms > 0 ? ' history-day-active' : ''}` }, [
      svgEl('rect', {
        x: String(center - barWidth / 2), y: String(top + plotHeight - barHeight),
        width: String(barWidth), height: String(barHeight), rx: '2', className: 'history-chart-bar',
      }),
      svgEl('title', { text: `${row.dayKey} · ${value}` }),
    ]));
    if (index % 7 === 0 || index === list.length - 1) {
      children.push(svgEl('text', { x: String(center), y: String(height - 10), 'text-anchor': 'middle', className: 'history-chart-axis', text: shortDayLabel(row.dayKey) }));
    }
  });
  children.push(svgEl('text', { x: String(left), y: '13', className: 'history-chart-label', text: `máx. do período: ${Math.round(max / 60000)} min` }));
  return frame({ className: 'history-chart-days', ariaLabel, height, children });
}
