import { renderRhythmNotation } from './notation.js';

export function notationSystems(model) {
  const systems = [];
  for (let offset = 0; offset < model.measures.length; offset += 4) {
    const measures = model.measures.slice(offset, offset + 4).map((measure, index) => ({ ...measure, index: index + 1 }));
    systems.push({ ...model, bars: measures.length, barOffset: offset, measures });
  }
  return systems;
}

export function renderPracticeScore(container, model) {
  container.replaceChildren();
  for (const system of notationSystems(model)) {
    const row = container.ownerDocument.createElement('div'); row.className = 'practice-score-system';
    row.setAttribute('aria-label', `Compassos ${system.barOffset + 1} a ${system.barOffset + system.bars}`);
    row.style.width = `${system.bars / 4 * 100}%`;
    const svg = renderRhythmNotation(row, system);
    svg.style.minWidth = '0';
    svg.style.width = '100%';
    svg.style.height = 'auto';
    container.append(row);
  }
}
