// Forma musical compilada uma vez: relógio em segundos e origem de cada compasso.
import { ticksPerBar, secondsPerTick, EPSILON } from './meter.js';
import { prepareArrangement } from './arrangement.js';

export const FORM_KINDS = Object.freeze(['intro', 'A', 'B', 'fill', 'break', 'end']);
export const FORM_LABELS = Object.freeze({ intro: 'Introdução', A: 'A', B: 'B', fill: 'Virada', break: 'Pausa da banda', end: 'Final' });
export const FORM_DESCRIPTIONS = Object.freeze({
  intro: 'Sem melodia; banda toca apenas os ataques no início de cada compasso.', A: 'Arranjo completo da fonte.', B: 'Arranjo completo da fonte; escolha outra fonte ou densidade para contrastar.',
  fill: 'Virada de bateria no último tempo de cada compasso.', break: 'Só melodia e cliques; banda em silêncio.',
  end: 'Melodia completa; banda só nos ataques iniciais de cada compasso. Sustentações terminam na seção.',
});

// A validação pertence ao documento; não importa session.js para evitar ciclos.
export function normalizeForm(value, bars) {
  const form = { enabled: false, loop: true, sections: [], ...value };
  const object = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  const bad = message => { throw new TypeError(`Forma: ${message}`); };
  if (value !== undefined && !object(value)) bad('objeto inválido.');
  if (Object.keys(form).some(key => !['enabled', 'loop', 'sections'].includes(key))
    || typeof form.enabled !== 'boolean' || typeof form.loop !== 'boolean' || !Array.isArray(form.sections)
    || form.sections.length > 32) bad('use até 32 seções e opções booleanas.');
  const ids = new Set();
  form.sections = form.sections.map(raw => {
    if (!object(raw)) bad('seção inválida.');
    const section = { name: '', kind: 'A', startBar: 0, endBar: bars, repeats: 1, bpm: null, meter: null, density: null, ...raw };
    if (Object.keys(section).some(key => !['id', 'name', 'kind', 'startBar', 'endBar', 'repeats', 'bpm', 'meter', 'density'].includes(key))) bad('campo desconhecido.');
    if (typeof section.id !== 'string' || !section.id.length || section.id.length > 80 || ids.has(section.id)) bad('IDs devem ser únicos.');
    ids.add(section.id);
    if (typeof section.name !== 'string' || section.name.length > 80 || !FORM_KINDS.includes(section.kind)) bad('nome ou tipo inválido.');
    if (!Number.isInteger(section.startBar) || !Number.isInteger(section.endBar) || section.startBar < 0 || section.endBar > bars || section.startBar >= section.endBar) bad('a fonte deve caber na sessão (início incluso, fim exclusivo).');
    if (!Number.isInteger(section.repeats) || section.repeats < 1 || section.repeats > 16) bad('repetições de 1 a 16.');
    if (section.bpm !== null && (!Number.isInteger(section.bpm) || section.bpm < 30 || section.bpm > 300)) bad('BPM de 30 a 300 ou herdar.');
    if (section.density !== null && !['sparse', 'medium', 'busy'].includes(section.density)) bad('densidade inválida.');
    if (section.meter !== null) {
      const m = section.meter;
      if (!object(m) || Object.keys(m).some(key => !['beats', 'unit'].includes(key)) || !Number.isInteger(m.beats) || m.beats < 1 || m.beats > 16 || ![2, 4, 8, 16].includes(m.unit)) bad('compasso inválido.');
      section.meter = { beats: m.beats, unit: m.unit };
    }
    return section;
  });
  if (form.enabled && !form.sections.length) bad('adicione uma seção antes de ativar.');
  return form;
}

export function compileBarPlan(session, { training = false } = {}) {
  const useForm = session.form.enabled && !training;
  const sections = useForm ? session.form.sections : [{ id: null, name: '', kind: 'A', ...session.loop, repeats: 1, bpm: null, meter: null, density: null }];
  const rootTicks = ticksPerBar(session);
  const bars = [];
  let duration = 0;
  for (const [sectionIndex, section] of sections.entries()) {
    const density = section.density;
    // Gere na grade da fonte e redimensione TODOS os eventos proporcionalmente.
    // Isso conserva posições, alturas, articulação e sustentações da fonte.
    const source = {
      ...session, loop: { startBar: section.startBar, endBar: section.endBar },
      drums: { ...session.drums, density: density ?? session.drums.density },
      band: { ...session.band, density: density ?? session.band.density },
    };
    const arrangement = prepareArrangement(source);
    const meter = section.meter ?? session.meter;
    const bpm = section.bpm ?? session.bpm;
    const barTicks = ticksPerBar(meter);
    const secPerTick = secondsPerTick(bpm);
    const ratio = barTicks / rootTicks;
    // Cliques usam os tempos do compasso de destino, não os da fonte.
    const clock = prepareArrangement({ ...source, meter, notes: [], drums: { ...source.drums, enabled: false }, band: { ...source.band, bassEnabled: false }, progression: { ...source.progression, enabled: false } });
    for (let repeat = 0; repeat < section.repeats; repeat += 1) {
      for (let sourceBar = section.startBar; sourceBar < section.endBar; sourceBar += 1) {
        const index = bars.length;
        const descriptor = {
          index, sourceBar, sectionIndex, sectionId: section.id, sectionName: section.name || FORM_LABELS[section.kind],
          kind: section.kind, sectionRepeat: repeat + 1, meter, bpm, ticks: barTicks, secPerTick,
          start: duration, duration: barTicks * secPerTick,
          events({ barIndex = index, includePhrase = true, activity = null } = {}) {
            let events = arrangement.barEvents(sourceBar, { barIndex, includePhrase: includePhrase && section.kind !== 'intro', activity })
              .filter(event => event.channel !== 'metronome')
              .map(event => ({ ...event, tick: event.tick * ratio, duration: event.duration * ratio }));
            if (section.kind === 'intro') events = events.filter(event => event.tick < EPSILON);
            if (section.kind === 'break') events = events.filter(event => event.channel === 'phrase');
            if (section.kind === 'end') events = events.filter(event => event.channel === 'phrase' || event.tick < EPSILON);
            if (section.kind === 'fill' && source.drums.enabled && source.band.role !== 'drums') {
              const beat = 16 / meter.unit;
              const start = barTicks - beat;
              events = events.filter(event => event.channel !== 'drums' || event.tick < start - EPSILON);
              for (let i = 0; i < 4; i += 1) events.push({ channel: 'drums', kind: 'drum', tick: start + beat * i / 4, duration: 0, offsetMs: 0, instrument: i % 2 ? 'tom' : 'snare', velocity: 0.55 + i * 0.1 });
            }
            events.push(...clock.barEvents(sourceBar, { barIndex, includePhrase: false }).filter(event => event.channel === 'metronome'));
            for (const event of events) {
              const fromSectionStart = ((sourceBar - section.startBar) * barTicks + event.tick) * secPerTick;
              event.offsetMs = Math.max(event.offsetMs ?? 0, -fromSectionStart * 1000);
              event.maxSeconds = ((section.endBar - sourceBar) * barTicks - event.tick) * secPerTick - event.offsetMs / 1000;
            }
            return events.filter(event => event.maxSeconds > 0).sort((a, b) => a.tick * secPerTick + a.offsetMs / 1000 - b.tick * secPerTick - b.offsetMs / 1000);
          },
        };
        bars.push(descriptor);
        duration += descriptor.duration;
      }
    }
  }
  return {
    bars, duration, loop: !useForm || session.form.loop, rootTicks,
    at(index) { return bars[((index % bars.length) + bars.length) % bars.length]; },
    timeAt(index) { return Math.floor(index / bars.length) * duration + this.at(index).start; },
    locate(seconds) {
      const cycle = Math.floor((seconds + 1e-10) / duration);
      const local = seconds - cycle * duration;
      let low = 0; let high = bars.length;
      while (low + 1 < high) { const mid = (low + high) >> 1; if (bars[mid].start <= local + 1e-10) low = mid; else high = mid; }
      const bar = bars[low];
      return { bar, index: cycle * bars.length + low, fraction: Math.max(0, (local - bar.start) / bar.duration) };
    },
  };
}
