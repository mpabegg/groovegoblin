// Mulberry32: estado uint32, inclusive seed zero; nao usa relógio ou aleatoriedade
// externa. Serve à reprodução de frases e arranjos, nao a fins criptográficos.
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Semente derivada e estável para uma parte do arranjo (ex.: compasso 3 do baixo).
export function deriveSeed(seed, ...parts) {
  let hash = (seed >>> 0) ^ 0x9e3779b9;
  for (const part of parts) {
    hash = Math.imul(hash ^ (part >>> 0), 0x85ebca6b) >>> 0;
    hash ^= hash >>> 13;
  }
  return hash >>> 0;
}
