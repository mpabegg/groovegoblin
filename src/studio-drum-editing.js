import { generateDrums } from './drums.js';
import { DRUM_POSITION_EPSILON, validateSession } from './session.js';

export const drumRowVoice = voice => ['kick', 'snare'].includes(voice) ? voice : 'hihat';
export const sameDrumPosition = (a, b) => Math.abs(a - b) <= DRUM_POSITION_EPSILON;

// One absolute desired state per voice/position; undoing an addition removes its diff.
// Do not rebase stored edits on style/density changes: dormant tombstones remain intentional.
export function drumHitPatch(session, voice, start, velocity) {
  const base = generateDrums({ ...session, drums: { ...session.drums, edits: [] } }).hits
    .find(hit => hit.instrument === voice && sameDrumPosition(hit.start, start));
  const edits = session.drums.edits.filter(edit => edit.voice !== voice || !sameDrumPosition(edit.start, start));
  if (velocity === null ? !!base : !base || velocity !== base.velocity) edits.push({ voice, start: base?.start ?? start, velocity });
  const checked = validateSession({ ...session, drums: { ...session.drums, edits } });
  if (!checked.ok) throw new TypeError(checked.error);
  return { drums: { edits: checked.session.drums.edits } };
}

