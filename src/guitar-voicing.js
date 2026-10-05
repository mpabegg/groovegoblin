// Frets and tuning are low → high; -1 means a muted string.
// Exhaustive, bounded first-position search. No dictionary shapes or fallback pitches.
export function guitarFingering(frets, { maxSpan = 4 } = {}) {
  const pressed = frets.flatMap((fret, string) => fret > 0 ? [{ fret, string }] : []);
  if (!pressed.length) return { fingers: 0, barre: null };
  const low = Math.min(...pressed.map(note => note.fret));
  const high = Math.max(...pressed.map(note => note.fret));
  if (high - low >= maxSpan) return null;
  let best = { fingers: pressed.length, barre: null };
  // A barre may pass under higher frets, never an open/muted/lower string.
  for (let from = 0; from < frets.length; from++) {
    if (frets[from] <= 0) continue;
    for (let to = from + 1; to < frets.length; to++) {
      const fret = frets[from];
      if (frets[to] !== fret || frets.slice(from, to + 1).some(value => value < fret)) continue;
      const covered = frets.slice(from, to + 1).filter(value => value === fret).length;
      const fingers = pressed.length - covered + 1;
      if (fingers < best.fingers) best = { fingers, barre: { fret, from, to } };
    }
  }
  return best.fingers <= 4 ? best : null;
}

export function generateGuitarVoicing(chord, tuning, { maxFret = 5, maxSpan = 4 } = {}) {
  if (!Array.isArray(tuning) || tuning.length !== 6 || tuning.some(pitch => !Number.isInteger(pitch) || pitch < 0 || pitch > 127)) return null;
  if (!Number.isInteger(maxFret) || maxFret < 0 || maxFret > 5) throw new RangeError('A busca vai da corda solta até a quinta casa.');
  const required = new Set(chord.notes.map(note => note.midi % 12));
  required.add(chord.root);
  const options = tuning.map(open => [-1, ...Array.from({ length: maxFret + 1 }, (_, fret) => fret).filter(fret => open + fret <= 127 && required.has((open + fret) % 12))]);
  const remaining = Array.from({ length: 7 }, () => new Set());
  for (let string = 5; string >= 0; string--) {
    remaining[string] = new Set(remaining[string + 1]);
    for (const fret of options[string]) if (fret >= 0) remaining[string].add((tuning[string] + fret) % 12);
  }
  const frets = Array(6).fill(-1);
  let best = null; let bestScore = Infinity;
  function search(string, mask, started, ended) {
    for (const pitch of required) if (!mask.has(pitch) && !remaining[string].has(pitch)) return;
    if (string === 6) {
      const sounding = frets.filter(fret => fret >= 0).length;
      if (sounding < 3 || mask.size !== required.size) return;
      const fingering = guitarFingering(frets, { maxSpan });
      if (!fingering) return;
      const pitches = frets.map((fret, index) => fret < 0 ? null : tuning[index] + fret);
      const bass = pitches.find(pitch => pitch !== null) % 12;
      if (chord.bass !== null && chord.bass !== undefined && bass !== chord.bass) return;
      const score = (bass !== chord.root ? 30 : 0) + fingering.fingers * 3 + (6 - sounding) * 4 + frets.reduce((sum, fret) => sum + Math.max(0, fret), 0) + (fingering.barre ? 2 : 0);
      if (score < bestScore) { bestScore = score; best = { frets: [...frets], pitches, ...fingering }; }
      return;
    }
    for (const fret of options[string]) {
      if (ended && fret >= 0) continue; // No interior mute in a strummed diagram.
      frets[string] = fret;
      if (fret < 0) search(string + 1, mask, started, ended || started);
      else {
        const pitch = (tuning[string] + fret) % 12;
        const added = !mask.has(pitch); mask.add(pitch);
        search(string + 1, mask, true, false);
        if (added) mask.delete(pitch);
      }
    }
  }
  search(0, new Set(), false, false);
  return best;
}
