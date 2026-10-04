// Intercâmbio por ARQUIVO (sem MIDI ao vivo nem hardware): WAV PCM e Standard
// MIDI File (SMF) formatos 0/1. Coordenadas da sessão: 4 ticks = semínima.

export const SESSION_TICKS_PER_QUARTER = 4;
export const MIDI_PPQ = 480;
export const MIDI_DRUM_CHANNEL = 9;
export const QUANTIZE_GRIDS = Object.freeze({
  none: 0,
  sixteenth: 1,
  'eighth-triplet': 4 / 3,
  'sixteenth-triplet': 2 / 3,
  'thirty-second': 0.5,
});
const MAX_MIDI_BYTES = 4 * 1024 * 1024;
const MAX_MIDI_NOTES = 20000;

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function readAscii(view, offset, length) {
  let text = '';
  for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(offset + i));
  return text;
}

export function encodeWav(channels, sampleRate, { bitDepth = 16 } = {}) {
  if (!Array.isArray(channels) || !channels.length || !channels.every(channel => channel instanceof Float32Array)) {
    throw new TypeError('O WAV precisa de ao menos um canal Float32Array.');
  }
  const length = channels[0].length;
  if (!channels.every(channel => channel.length === length)) throw new RangeError('Os canais do WAV devem ter o mesmo tamanho.');
  if (!Number.isInteger(sampleRate) || sampleRate < 3000 || sampleRate > 768000) throw new RangeError('Taxa de amostragem inválida para WAV.');
  if (bitDepth !== 16 && bitDepth !== 32) throw new RangeError('O WAV exportado usa 16 bits PCM ou 32 bits flutuante.');
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels.length * bytesPerSample;
  const dataBytes = length * blockAlign;
  if (dataBytes > 0xffffffff - 44) throw new RangeError('Áudio longo demais para um único arquivo WAV.');
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (const channel of channels) {
      const value = Number.isFinite(channel[i]) ? Math.max(-1, Math.min(1, channel[i])) : 0;
      if (bitDepth === 32) view.setFloat32(offset, value, true);
      else view.setInt16(offset, Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), true);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

// Leitura de WAV PCM 8/16/24/32 bits e flutuante 32/64 (inclusive WAVE_FORMAT_EXTENSIBLE).
export function decodeWav(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 44) throw new TypeError('Arquivo WAV curto demais.');
  const view = new DataView(arrayBuffer);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') throw new TypeError('O arquivo não é um WAV RIFF.');
  let format = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      let code = view.getUint16(body, true);
      if (code === 0xfffe && size >= 26) code = view.getUint16(body + 24, true);
      format = { code, channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, view.byteLength - body) };
    }
    offset = body + size + (size % 2);
  }
  if (!format || !data) throw new TypeError('O WAV não contém blocos fmt e data.');
  const { code, channels: channelCount, sampleRate, bits } = format;
  const supported = (code === 1 && [8, 16, 24, 32].includes(bits)) || (code === 3 && [32, 64].includes(bits));
  if (!supported || channelCount < 1) throw new TypeError('Codificação WAV não suportada.');
  const bytes = bits / 8;
  const frames = Math.floor(data.size / (bytes * channelCount));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  let position = data.offset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      let value;
      if (code === 3) value = bits === 32 ? view.getFloat32(position, true) : view.getFloat64(position, true);
      else if (bits === 8) value = (view.getUint8(position) - 128) / 128;
      else if (bits === 16) value = view.getInt16(position, true) / 0x8000;
      else if (bits === 24) {
        const raw = view.getUint8(position) | (view.getUint8(position + 1) << 8) | (view.getInt8(position + 2) << 16);
        value = raw / 0x800000;
      } else value = view.getInt32(position, true) / 0x80000000;
      channels[c][i] = value;
      position += bytes;
    }
  }
  return { sampleRate, channels };
}

function variableLength(value) {
  const bytes = [value & 0x7f];
  let rest = value >>> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return bytes;
}

function textBytes(text) {
  return Array.from(new TextEncoder().encode(String(text).slice(0, 120)));
}

function trackChunk(events) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const bytes = [];
  let previous = 0;
  for (const event of events) {
    bytes.push(...variableLength(Math.max(0, event.tick - previous)), ...event.data);
    previous = event.tick;
  }
  bytes.push(0x00, 0xff, 0x2f, 0x00);
  const length = bytes.length;
  return [0x4d, 0x54, 0x72, 0x6b, (length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255, ...bytes];
}

function toMidiTicks(sessionTicks) {
  return Math.round(sessionTicks * MIDI_PPQ / SESSION_TICKS_PER_QUARTER);
}

function velocityByte(velocity) {
  const value = Number.isFinite(velocity) ? velocity : 0.8;
  return Math.max(1, Math.min(127, Math.round(value * 127)));
}

function noteEvents(notes, channel, order = 0) {
  const events = [];
  for (const note of notes) {
    const start = toMidiTicks(note.start);
    const end = Math.max(start + 1, toMidiTicks(note.start + note.duration));
    const pitch = Math.max(0, Math.min(127, Math.round(note.pitch ?? 69)));
    events.push({ tick: start, order: order + 1, data: [0x90 | channel, pitch, velocityByte(note.velocity)] });
    events.push({ tick: end, order, data: [0x80 | channel, pitch, 0] });
  }
  return events;
}

function sessionTicksPerBar(meter) {
  return meter.beats * 16 / meter.unit;
}

// Exporta frase (canal 1) e acordes da progressão (canal 2). Bateria e baixo são
// gerados pelo motor durante a reprodução e não fazem parte dos dados da sessão.
export function sessionToMidi(session, { includeChords = true } = {}) {
  if (!session || typeof session !== 'object' || !Array.isArray(session.notes)) throw new TypeError('Sessão inválida para MIDI.');
  const meter = session.meter && session.meter.beats > 0 && session.meter.unit > 0 ? session.meter : { beats: 4, unit: 4 };
  const bpm = Number.isFinite(session.bpm) && session.bpm > 0 ? session.bpm : 100;
  const conductor = [
    { tick: 0, order: 0, data: [0xff, 0x03, ...variableLength(textBytes(session.name || 'GrooveGoblin').length), ...textBytes(session.name || 'GrooveGoblin')] },
    { tick: 0, order: 1, data: [0xff, 0x51, 0x03, ...(n => [(n >>> 16) & 255, (n >>> 8) & 255, n & 255])(Math.round(60000000 / bpm))] },
    { tick: 0, order: 2, data: [0xff, 0x58, 0x04, meter.beats, Math.round(Math.log2(meter.unit)), 24, 8] },
  ];
  const melodyName = textBytes('Frase');
  const melody = [{ tick: 0, order: 0, data: [0xff, 0x03, ...variableLength(melodyName.length), ...melodyName] }, ...noteEvents(session.notes, 0)];
  const tracks = [trackChunk(conductor), trackChunk(melody)];
  const chords = includeChords && session.progression?.enabled !== false ? session.progression?.chords ?? [] : [];
  if (chords.length) {
    const perBar = sessionTicksPerBar(meter);
    const chordNotes = [];
    let cursor = 0;
    for (const chord of chords) {
      const duration = (Number.isFinite(chord.durationBars) && chord.durationBars > 0 ? chord.durationBars : 1) * perBar;
      for (const note of chord.notes ?? []) chordNotes.push({ start: cursor, duration, pitch: note.midi, velocity: 0.6 });
      cursor += duration;
    }
    const chordName = textBytes('Acordes');
    tracks.push(trackChunk([{ tick: 0, order: 0, data: [0xff, 0x03, ...variableLength(chordName.length), ...chordName] }, ...noteEvents(chordNotes, 1)]));
  }
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (MIDI_PPQ >>> 8) & 255, MIDI_PPQ & 255];
  return new Uint8Array([...header, ...tracks.flat()]);
}

// Hipóteses de altura (segundos) para MIDI, com o andamento escolhido pelo usuário.
export function notesToMidi(notes, { bpm = 120, name = 'Hipóteses de altura' } = {}) {
  const secondsPerTick = 60 / bpm / SESSION_TICKS_PER_QUARTER;
  const sessionNotes = notes.map(note => ({
    start: note.start / secondsPerTick,
    duration: Math.max(0.25, (note.end - note.start) / secondsPerTick),
    pitch: note.midi,
    velocity: 0.4 + 0.5 * (note.confidence ?? 0.5),
  }));
  return sessionToMidi({ name, bpm, meter: { beats: 4, unit: 4 }, notes: sessionNotes }, { includeChords: false });
}

export function parseMidi(input) {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!bytes) throw new TypeError('O arquivo MIDI deve ser binário.');
  if (bytes.length > MAX_MIDI_BYTES) throw new RangeError('Arquivo MIDI grande demais (limite de 4 MB).');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 14 || readAscii(view, 0, 4) !== 'MThd') throw new TypeError('O arquivo não é um Standard MIDI File (falta o cabeçalho MThd).');
  const headerLength = view.getUint32(4);
  const format = view.getUint16(8);
  const declaredTracks = view.getUint16(10);
  const division = view.getUint16(12);
  if (format > 1) throw new TypeError('Somente arquivos MIDI de formato 0 ou 1 são suportados.');
  if (division & 0x8000) throw new TypeError('Arquivos MIDI com divisão SMPTE não são suportados.');
  const ppq = division;
  if (!ppq) throw new TypeError('Resolução MIDI inválida.');
  let offset = 8 + headerLength;
  const tracks = [];
  const tempos = [];
  const timeSignatures = [];
  let noteCount = 0;
  while (offset + 8 <= bytes.length && tracks.length < declaredTracks) {
    const id = readAscii(view, offset, 4);
    const length = view.getUint32(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) throw new RangeError('Trilha MIDI truncada.');
    offset = end;
    if (id !== 'MTrk') continue;
    const track = { name: '', notes: [], channels: new Set() };
    const open = new Map();
    let position = start;
    let tick = 0;
    let status = 0;
    const readLength = () => {
      let value = 0;
      for (let i = 0; i < 4; i++) {
        if (position >= end) throw new RangeError('Evento MIDI truncado.');
        const byte = bytes[position++];
        value = (value << 7) | (byte & 0x7f);
        if (!(byte & 0x80)) return value;
      }
      throw new RangeError('Comprimento variável MIDI inválido.');
    };
    while (position < end) {
      tick += readLength();
      let byte = bytes[position];
      if (byte & 0x80) { status = byte; position++; } else if (!status) throw new RangeError('Status MIDI ausente (running status sem evento anterior).');
      if (status === 0xff) {
        const type = bytes[position++];
        const size = readLength();
        const data = bytes.subarray(position, position + size);
        position += size;
        if (type === 0x2f) break;
        if (type === 0x03 && !track.name) track.name = new TextDecoder().decode(data);
        if (type === 0x51 && size === 3) tempos.push({ tick, bpm: 60000000 / ((data[0] << 16) | (data[1] << 8) | data[2]) });
        if (type === 0x58 && size >= 2) timeSignatures.push({ tick, beats: data[0], unit: 2 ** data[1] });
        status = 0;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        position += readLength();
        status = 0;
        continue;
      }
      const kind = status & 0xf0;
      const channel = status & 0x0f;
      const first = bytes[position++];
      const second = kind === 0xc0 || kind === 0xd0 ? 0 : bytes[position++];
      if (kind === 0x90 && second > 0) {
        const key = channel * 128 + first;
        if (!open.has(key)) open.set(key, []);
        open.get(key).push({ tick, velocity: second });
      } else if (kind === 0x80 || (kind === 0x90 && second === 0)) {
        const pending = open.get(channel * 128 + first);
        const begun = pending?.shift();
        if (begun) {
          if (++noteCount > MAX_MIDI_NOTES) throw new RangeError('O arquivo MIDI tem notas demais (limite de 20000).');
          track.notes.push({ tick: begun.tick, durationTicks: Math.max(1, tick - begun.tick), pitch: first, velocity: begun.velocity / 127, channel });
          track.channels.add(channel);
        }
      }
    }
    track.notes.sort((a, b) => a.tick - b.tick || b.pitch - a.pitch);
    tracks.push({ name: track.name, notes: track.notes, channels: [...track.channels].sort((a, b) => a - b) });
  }
  if (!tracks.length) throw new TypeError('O arquivo MIDI não contém trilhas.');
  tempos.sort((a, b) => a.tick - b.tick);
  timeSignatures.sort((a, b) => a.tick - b.tick);
  return { format, ppq, tracks, tempos, timeSignatures };
}

// Escolhe a primeira trilha melódica (fora do canal de bateria) com notas.
export function defaultMidiTrack(parsed) {
  const index = parsed.tracks.findIndex(track => track.notes.some(note => note.channel !== MIDI_DRUM_CHANNEL));
  return index >= 0 ? index : parsed.tracks.findIndex(track => track.notes.length);
}

// Converte uma trilha em patch de sessão monofônico (linha superior quando há
// sobreposição). Retorna avisos legíveis sobre toda perda de informação.
export function midiToSessionPatch(parsed, { trackIndex = defaultMidiTrack(parsed), quantize = 'sixteenth', idPrefix = 'midi' } = {}) {
  const track = parsed.tracks[trackIndex];
  if (!track || !track.notes.length) throw new RangeError('A trilha MIDI escolhida não tem notas.');
  if (!Object.hasOwn(QUANTIZE_GRIDS, quantize)) throw new RangeError('Grade de quantização desconhecida.');
  const warnings = [];
  const grid = QUANTIZE_GRIDS[quantize];
  const scale = SESSION_TICKS_PER_QUARTER / parsed.ppq;
  const tempo = parsed.tempos[0]?.bpm ?? 120;
  if (parsed.tempos.length > 1 && new Set(parsed.tempos.map(item => Math.round(item.bpm))).size > 1) warnings.push('O MIDI tem mudanças de andamento; foi usado o primeiro andamento.');
  const signature = parsed.timeSignatures[0] ?? { beats: 4, unit: 4 };
  if (new Set(parsed.timeSignatures.map(item => `${item.beats}/${item.unit}`)).size > 1) warnings.push('O MIDI muda de fórmula de compasso; foi usada a primeira.');
  const snap = value => (grid ? Math.round(value / grid) * grid : Math.round(value * 1000) / 1000);
  let candidates = track.notes
    .filter(note => note.channel !== MIDI_DRUM_CHANNEL || track.channels.every(channel => channel === MIDI_DRUM_CHANNEL))
    .map(note => {
      const start = snap(note.tick * scale);
      const end = Math.max(start + (grid || 0.25), snap((note.tick + note.durationTicks) * scale));
      return { start, end, pitch: note.pitch, velocity: Math.round(note.velocity * 1000) / 1000 };
    })
    .sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  const result = [];
  let reduced = 0;
  for (const note of candidates) {
    const previous = result[result.length - 1];
    if (previous && note.start < previous.end) {
      reduced++;
      if (note.start === previous.start) continue; // mesma posição: fica a nota mais aguda
      previous.end = note.start; // linha superior: encurta a anterior
    }
    result.push({ ...note });
  }
  candidates = result.filter(note => note.end > note.start);
  if (reduced) warnings.push(`${reduced} nota(s) sobreposta(s) foram reduzidas à linha superior (a sessão é monofônica).`);
  if (parsed.tracks.filter(item => item.notes.length).length > 1) warnings.push('Somente uma trilha foi importada; as demais foram ignoradas.');
  const meter = { beats: signature.beats, unit: signature.unit };
  const perBar = sessionTicksPerBar(meter);
  const lastEnd = candidates.reduce((max, note) => Math.max(max, note.end), 0);
  const bars = Math.max(1, Math.ceil(lastEnd / perBar - 1e-9));
  const notes = candidates.map((note, index) => ({
    id: `${idPrefix}-${index + 1}`,
    start: Math.round(note.start * 1e6) / 1e6,
    duration: Math.round((note.end - note.start) * 1e6) / 1e6,
    pitch: note.pitch,
    velocity: note.velocity,
  }));
  const patch = { bpm: Math.round(tempo), meter, bars, notes };
  if (track.name) patch.name = track.name.slice(0, 80);
  return { patch, warnings };
}
