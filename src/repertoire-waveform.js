// Desenho da forma de onda e das camadas de anotação em <canvas>.
// Picos em pirâmide: um nível base de 256 amostras por balde é calculado uma vez
// por buffer; zoom distante agrega esse nível e zoom próximo lê as amostras.

import { computePeaks } from './repertoire-dsp.js';
import { midiToName } from './repertoire-analysis.js';
import { sectionList } from './repertoire.js';

const BASE_BUCKET = 256;
const peakCache = new WeakMap();
export const LANES = Object.freeze({ sections: [0, 18], wave: [20, 132], chords: [136, 156], notes: [160, 196] });
export const WAVEFORM_HEIGHT = 200;
const SECTION_COLORS = ['#5f8f3e', '#3f7392', '#8c5b8f', '#9a7a3a', '#3f8a7c', '#91553f'];

function channelsOf(buffer) {
  return Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
}

function basePeaks(buffer) {
  let cached = peakCache.get(buffer);
  if (!cached) {
    const buckets = Math.ceil(buffer.length / BASE_BUCKET);
    cached = computePeaks(channelsOf(buffer), 0, buckets * BASE_BUCKET, buckets);
    peakCache.set(buffer, cached);
  }
  return cached;
}

export function peaksFor(buffer, startSeconds, endSeconds, width) {
  const rate = buffer.sampleRate;
  const start = Math.max(0, Math.floor(startSeconds * rate));
  const end = Math.min(buffer.length, Math.ceil(endSeconds * rate));
  const perPixel = (end - start) / width;
  if (perPixel < BASE_BUCKET * 2) return computePeaks(channelsOf(buffer), start, end, width);
  const base = basePeaks(buffer);
  const peaks = new Float32Array(width * 2);
  for (let x = 0; x < width; x++) {
    const first = Math.floor((start + x * perPixel) / BASE_BUCKET);
    const last = Math.max(first + 1, Math.floor((start + (x + 1) * perPixel) / BASE_BUCKET));
    let min = 0;
    let max = 0;
    for (let b = first; b < last && b * 2 + 1 < base.length; b++) {
      if (base[b * 2] < min) min = base[b * 2];
      if (base[b * 2 + 1] > max) max = base[b * 2 + 1];
    }
    peaks[x * 2] = min;
    peaks[x * 2 + 1] = max;
  }
  return peaks;
}

function css(name, fallback) {
  const value = globalThis.getComputedStyle?.(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// model: { buffer, duration, view:{start,end}, cursor, region, selection, markers, grid, trackedBeats,
//          onsets, chords, notes, minConfidence }
export function drawWaveform(canvas, model) {
  const ratio = globalThis.devicePixelRatio || 1;
  const cssWidth = Math.max(200, canvas.clientWidth || 600);
  if (canvas.width !== Math.round(cssWidth * ratio) || canvas.height !== Math.round(WAVEFORM_HEIGHT * ratio)) {
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(WAVEFORM_HEIGHT * ratio);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = cssWidth;
  const accent = css('--accent', '#b9ef80');
  const blue = css('--blue', '#8bcced');
  const muted = css('--muted', '#9eaea9');
  ctx.clearRect(0, 0, width, WAVEFORM_HEIGHT);
  ctx.fillStyle = '#111a20';
  ctx.fillRect(0, 0, width, WAVEFORM_HEIGHT);
  const { view } = model;
  const span = Math.max(1e-6, view.end - view.start);
  const toX = time => ((time - view.start) / span) * width;
  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';

  const [sTop, sBottom] = LANES.sections;
  sectionList(model.markers, model.duration).forEach((section, index) => {
    const x0 = Math.max(0, toX(section.time));
    const x1 = Math.min(width, toX(section.end));
    if (x1 <= 0 || x0 >= width) return;
    ctx.fillStyle = SECTION_COLORS[index % SECTION_COLORS.length];
    ctx.fillRect(x0, sTop, Math.max(1, x1 - x0 - 1), sBottom - sTop);
    ctx.fillStyle = '#f2f6f1';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, sTop, x1 - x0, sBottom - sTop);
    ctx.clip();
    ctx.fillText(section.label, x0 + 4, (sTop + sBottom) / 2);
    ctx.restore();
  });

  const [wTop, wBottom] = LANES.wave;
  const middle = (wTop + wBottom) / 2;
  const amplitude = (wBottom - wTop) / 2;
  const region = model.selection ?? model.region;
  if (region) {
    ctx.fillStyle = model.selection ? '#8bcced30' : '#b9ef8022';
    ctx.fillRect(toX(region.start), wTop, toX(region.end) - toX(region.start), wBottom - wTop);
  }

  if (model.grid?.length && width / model.grid.length > 3) {
    for (const beat of model.grid) {
      const x = Math.round(toX(beat.time)) + 0.5;
      ctx.strokeStyle = beat.downbeat ? '#8bcced66' : '#8bcced22';
      ctx.beginPath();
      ctx.moveTo(x, wTop);
      ctx.lineTo(x, wBottom);
      ctx.stroke();
      if (beat.downbeat && width / model.grid.length > 6) {
        ctx.fillStyle = blue;
        ctx.fillText(String(beat.bar), x + 2, wTop + 6);
      }
    }
  }

  if (model.buffer) {
    const peaks = peaksFor(model.buffer, view.start, view.end, Math.floor(width));
    ctx.fillStyle = '#7fae8f';
    for (let x = 0; x < peaks.length / 2; x++) {
      const min = peaks[x * 2];
      const max = peaks[x * 2 + 1];
      ctx.fillRect(x, middle - max * amplitude, 1, Math.max(1, (max - min) * amplitude));
    }
  } else {
    ctx.fillStyle = muted;
    ctx.fillText(model.placeholder ?? 'Sem áudio carregado', 12, middle);
  }

  if (model.trackedBeats?.length) {
    ctx.fillStyle = '#ffd78a';
    for (const time of model.trackedBeats) {
      if (time < view.start || time > view.end) continue;
      ctx.fillRect(toX(time) - 1, wBottom - 6, 2, 6);
    }
  }
  if (model.onsets?.length) {
    ctx.strokeStyle = '#ffba9d';
    for (const onset of model.onsets) {
      if (onset.time < view.start || onset.time > view.end) continue;
      const x = Math.round(toX(onset.time)) + 0.5;
      ctx.globalAlpha = 0.35 + 0.65 * onset.confidence;
      ctx.beginPath();
      ctx.moveTo(x, wTop);
      ctx.lineTo(x, wTop + 10);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  for (const marker of model.markers) {
    if (marker.kind === 'section' || marker.time < view.start || marker.time > view.end) continue;
    const x = Math.round(toX(marker.time)) + 0.5;
    ctx.strokeStyle = marker.kind === 'comment' ? '#f1d48a' : '#cbb6ff';
    ctx.beginPath();
    ctx.moveTo(x, wTop);
    ctx.lineTo(x, wBottom);
    ctx.stroke();
    if (marker.end) {
      ctx.fillStyle = marker.kind === 'comment' ? '#f1d48a18' : '#cbb6ff18';
      ctx.fillRect(x, wTop, toX(marker.end) - x, wBottom - wTop);
    }
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillRect(x, wTop, 8, 8);
  }

  const [cTop, cBottom] = LANES.chords;
  for (const chord of model.chords ?? []) {
    if (chord.end < view.start || chord.start > view.end || chord.label === 'N') continue;
    const x0 = Math.max(0, toX(chord.start));
    const x1 = Math.min(width, toX(chord.end));
    ctx.fillStyle = chord.edited ? '#35473b' : `rgba(139, 204, 237, ${0.08 + 0.3 * chord.confidence})`;
    ctx.fillRect(x0, cTop, Math.max(1, x1 - x0 - 1), cBottom - cTop);
    if (x1 - x0 > 18) {
      ctx.fillStyle = chord.edited ? accent : '#e8eee9';
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, cTop, x1 - x0, cBottom - cTop);
      ctx.clip();
      ctx.fillText(chord.label, x0 + 3, (cTop + cBottom) / 2);
      ctx.restore();
    }
  }

  const [nTop, nBottom] = LANES.notes;
  const visibleNotes = (model.notes ?? []).filter(note => note.end >= view.start && note.start <= view.end && note.confidence >= (model.minConfidence ?? 0));
  if (visibleNotes.length) {
    let low = Infinity;
    let high = -Infinity;
    for (const note of visibleNotes) { low = Math.min(low, note.midi); high = Math.max(high, note.midi); }
    const range = Math.max(12, high - low + 1);
    const rowHeight = (nBottom - nTop) / range;
    for (const note of visibleNotes) {
      const y = nBottom - (note.midi - low + 1) * rowHeight;
      ctx.fillStyle = `rgba(185, 239, 128, ${0.25 + 0.75 * note.confidence})`;
      const x0 = toX(note.start);
      const w = Math.max(2, toX(note.end) - x0);
      ctx.fillRect(x0, y, w, Math.max(2, rowHeight - 1));
      if (w > 26 && rowHeight >= 3) {
        ctx.fillStyle = '#10161b';
        ctx.fillText(midiToName(note.midi), x0 + 2, y + Math.max(2, rowHeight - 1) / 2);
      }
    }
  }
  ctx.fillStyle = muted;
  if (!(model.chords ?? []).length) ctx.fillText('acordes: sem análise', 4, (cTop + cBottom) / 2);
  if (!visibleNotes.length) ctx.fillText('notas: sem hipóteses visíveis', 4, (nTop + nBottom) / 2);

  if (Number.isFinite(model.cursor)) {
    const x = Math.round(toX(model.cursor)) + 0.5;
    if (x >= 0 && x <= width) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, WAVEFORM_HEIGHT);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }
}

export function timeAtX(canvas, clientX, view) {
  const rect = canvas.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
  return view.start + fraction * (view.end - view.start);
}
