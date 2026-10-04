// Realização pura do arranjo, compasso a compasso, compartilhada pelo
// transporte ao vivo e pela renderização offline (mesmo resultado sonoro).
// Eventos: {channel, kind:'note'|'chord'|'drum'|'click'|'pulse', tick, duration,
// offsetMs, pitch|pitches, velocity, timbre, instrument, articulation, accent}
// com tick/duration em ticks TOCADOS (swing aplicado) relativos ao início do
// compasso; offsetMs é o microtempo da nota.
import { EPSILON, ticksPerBar, beatTicks, beatGroups, gridStep, performTick, swingLocalTick } from './meter.js';
import { generateDrums, TRIPLET_STYLES } from './drums.js';
import { generateBass, generateComping } from './band.js';

function byBar(items, barTicks) {
  const bars = new Map();
  for (const item of items) {
    const bar = Math.floor((item.start + EPSILON) / barTicks);
    if (!bars.has(bar)) bars.set(bar, []);
    bars.get(bar).push(item);
  }
  return bars;
}

// Converte início/duração retos em locais tocados (com ou sem swing).
function performed(session, barStart, start, duration, swing) {
  if (!swing) return { tick: start - barStart, duration };
  const begin = performTick(session, start);
  const end = performTick(session, start + duration);
  return { tick: begin - barStart, duration: Math.max(end - begin, 0.01) };
}

function metronomeTicks(session, pattern) {
  const barTicks = ticksPerBar(session);
  const step = beatTicks(session);
  const groups = beatGroups(session);
  const groupStarts = [];
  let cursor = 0;
  for (const group of groups) {
    groupStarts.push(cursor * step);
    cursor += group;
  }
  const accentOf = tick => (tick < EPSILON ? 'bar' : groupStarts.some(start => Math.abs(start - tick) < EPSILON) ? 'group' : 'beat');
  const beats = Array.from({ length: session.meter.beats }, (_, index) => index * step);
  switch (pattern) {
    case 'downbeats':
      return [{ tick: 0, accent: 'bar' }];
    case 'backbeat':
      if (session.meter.unit <= 4 && groups.every(group => group === 1)) {
        return beats.filter((_, index) => index % 2 === 1).map(tick => ({ tick, accent: 'beat' }));
      }
      return groupStarts.slice(1).map(tick => ({ tick, accent: 'group' }));
    case 'offbeats':
      if (session.meter.unit <= 4) return beats.map(tick => ({ tick: tick + step / 2, accent: 'beat' }));
      return beats.filter(tick => !groupStarts.some(start => Math.abs(start - tick) < EPSILON)).map(tick => ({ tick, accent: 'beat' }));
    case 'subdivisions': {
      const sub = Math.min(gridStep(session.subdivision), step);
      const ticks = [];
      for (let tick = 0; tick < barTicks - EPSILON; tick += sub) {
        const onBeat = beats.some(beat => Math.abs(beat - tick) < EPSILON);
        ticks.push({ tick, accent: onBeat ? accentOf(tick) : 'sub' });
      }
      return ticks;
    }
    default:
      return beats.map(tick => ({ tick, accent: accentOf(tick) }));
  }
}

export function prepareArrangement(session) {
  const barTicks = ticksPerBar(session);
  const loopStart = session.loop.startBar;
  const loopEnd = session.loop.endBar;
  const loopStartTick = loopStart * barTicks;
  const loopEndTick = loopEnd * barTicks;
  const role = session.band.role;
  const tripletDrums = TRIPLET_STYLES.includes(session.drums.style);
  const tripletBand = TRIPLET_STYLES.includes(session.band.style);

  // Notas que começam dentro do loop; sustentações são cortadas no fim do loop.
  const phrase = session.notes
    .filter(note => note.start >= loopStartTick - EPSILON && note.start < loopEndTick - EPSILON)
    .map(note => ({ ...note, duration: Math.min(note.start + note.duration, loopEndTick) - note.start }));
  const drums = session.drums.enabled && role !== 'drums' ? generateDrums(session).hits : [];
  const bass = session.band.bassEnabled && role !== 'bass' ? generateBass(session) : [];
  // "changes" marca o primeiro ataque de cada acorde (mantido quando a banda abre espaço).
  const comping = (session.progression.enabled && role !== 'harmony' ? generateComping(session) : [])
    .map((chord, index, all) => ({
      ...chord,
      changes: index === 0 || chord.pitches.join() !== all[index - 1].pitches.join() || chord.start % barTicks < EPSILON,
    }));
  const phraseBars = byBar(phrase, barTicks);
  const drumBars = byBar(drums, barTicks);
  const bassBars = byBar(bass, barTicks);
  const compBars = byBar(comping, barTicks);
  const clicks = metronomeTicks(session, session.metronome.pattern);
  const countClicks = metronomeTicks(session, 'quarters');
  const clipToLoop = (start, duration) => Math.max(0.01, Math.min(start + duration, loopEndTick) - start);

  function clickEvents(list) {
    return list.map(({ tick, accent }) => ({
      channel: 'metronome', kind: 'click', tick: swingLocalTick(tick, session.swing, session.swingUnit, barTicks),
      duration: 0, offsetMs: 0, accent, velocity: accent === 'bar' ? 1 : accent === 'group' ? 0.85 : accent === 'beat' ? 0.7 : 0.45,
    }));
  }

  function companionEvents(barIndex) {
    const { pulses, spanBeats, pitch } = session.companion;
    const span = spanBeats * beatTicks(session);
    const barStart = barIndex * barTicks;
    const events = [];
    const firstCycle = Math.floor(barStart / span);
    for (let cycle = firstCycle; cycle * span < barStart + barTicks; cycle += 1) {
      for (let pulse = 0; pulse < pulses; pulse += 1) {
        const tick = cycle * span + (pulse * span) / pulses - barStart;
        if (tick < -EPSILON || tick >= barTicks - EPSILON) continue;
        events.push({
          channel: 'metronome', kind: 'pulse', tick: Math.max(0, tick), duration: Math.min(1, span / pulses), offsetMs: 0,
          pitch, velocity: pulse === 0 ? 0.8 : 0.6, timbre: 'woodblock', articulation: 'staccato',
        });
      }
    }
    return events;
  }

  // Modo "follow": quando a pessoa tocou no compasso anterior, a banda abre
  // espaço (harmonia só nas trocas, sem notas fantasmas); quando ela para logo
  // após tocar, a harmonia responde com o ritmo dos ataques reais dela e a
  // bateria faz uma virada curta. Só usa toques de teclado/tela registrados.
  function follow(events, activity) {
    if (session.band.mode !== 'follow' || !activity) return events;
    const previous = activity.previous ?? [];
    const earlier = activity.earlier ?? [];
    if (previous.length > 0) {
      return events.flatMap(event => {
        if (event.channel === 'chords') return event.changes ? [{ ...event, velocity: event.velocity * 0.8 }] : [];
        if (event.channel === 'drums') {
          if (event.velocity < 0.3 || event.instrument === 'openhat') return [];
          return [{ ...event, velocity: event.velocity * 0.9 }];
        }
        return [event];
      });
    }
    if (earlier.length > 0) {
      const chords = events.filter(event => event.channel === 'chords');
      const answer = chords.length === 0 ? [] : earlier.map(tick => {
        const source = [...chords].reverse().find(event => event.tick <= tick + EPSILON) ?? chords[0];
        return { ...source, tick, duration: Math.min(2, barTicks - tick), velocity: 0.5, articulation: 'staccato', changes: false };
      });
      const lastBeat = barTicks - Math.min(4, barTicks);
      const drums = events.filter(event => event.channel === 'drums');
      const fill = drums.length === 0 ? [] : [0, 1, 2, 3].map(index => lastBeat + index)
        .filter(tick => tick < barTicks - EPSILON)
        .map((tick, index) => ({ channel: 'drums', kind: 'drum', tick, duration: 0, offsetMs: 0, instrument: index % 2 ? 'tom' : 'snare', velocity: 0.45 + index * 0.1 }));
      return [
        ...events.filter(event => event.channel !== 'chords' && !(event.channel === 'drums' && event.tick >= lastBeat - EPSILON && event.instrument !== 'kick')),
        ...answer, ...fill,
      ];
    }
    return events;
  }

  return {
    session,
    ticksPerBar: barTicks,
    loopStartBar: loopStart,
    loopBars: loopEnd - loopStart,

    countInEvents() {
      return clickEvents(countClicks);
    },

    // sessionBar: compasso da sessão (0-based); barIndex: compassos tocados
    // desde o início do loop/treino (para ciclos de metrônomo e polirritmo).
    barEvents(sessionBar, { barIndex = 0, includePhrase = true, activity = null } = {}) {
      const barStart = sessionBar * barTicks;
      const events = [];
      if (includePhrase) {
        for (const note of phraseBars.get(sessionBar) ?? []) {
          const { tick, duration } = performed(session, barStart, note.start, note.duration, true);
          events.push({
            channel: 'phrase', kind: 'note', tick, duration, offsetMs: note.offsetMs, pitch: note.pitch,
            velocity: note.velocity, articulation: note.articulation, timbre: session.timbres.phrase,
          });
        }
      }
      for (const hit of drumBars.get(sessionBar) ?? []) {
        const { tick } = performed(session, barStart, hit.start, 0, !tripletDrums);
        events.push({ channel: 'drums', kind: 'drum', tick, duration: 0, offsetMs: 0, instrument: hit.instrument, velocity: hit.velocity });
      }
      for (const note of bassBars.get(sessionBar) ?? []) {
        const { tick, duration } = performed(session, barStart, note.start, clipToLoop(note.start, note.duration), !tripletBand);
        events.push({
          channel: 'bass', kind: 'note', tick, duration, offsetMs: 0, pitch: note.pitch, velocity: note.velocity,
          articulation: note.articulation, timbre: session.timbres.bass,
        });
      }
      for (const chord of compBars.get(sessionBar) ?? []) {
        const { tick, duration } = performed(session, barStart, chord.start, clipToLoop(chord.start, chord.duration), !tripletBand);
        events.push({
          channel: 'chords', kind: 'chord', tick, duration, offsetMs: 0, pitches: chord.pitches, velocity: chord.velocity,
          articulation: chord.articulation, timbre: session.timbres.chords, changes: chord.changes,
        });
      }
      const { enabled, audibleBars, silentBars } = session.metronome;
      if (enabled && (silentBars === 0 || barIndex % (audibleBars + silentBars) < audibleBars)) events.push(...clickEvents(clicks));
      if (session.companion.enabled) events.push(...companionEvents(barIndex));
      return follow(events, activity).sort((a, b) => a.tick - b.tick);
    },
  };
}
