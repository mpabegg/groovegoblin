// Mescla escolhas sem alterar a referência congelada da sessão executada.
export function mergeSession(current, patch) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const merged = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeSession(Object.hasOwn(current ?? {}, key) ? current[key] ?? {} : {}, value) : value;
    Object.defineProperty(next, key, { value: merged, enumerable: true, writable: true, configurable: true });
  }
  return next;
}

export const SESSION_LIBRARY_KEY = 'groovegoblin:studio-library:v2';
export function readSessionLibrary(storage, parse) {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(SESSION_LIBRARY_KEY);
    if (!raw) return { entries: [], warning: null, recoveryRaw: null };
    try {
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries) || entries.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.savedAt !== 'string' || !Number.isFinite(Date.parse(item.savedAt)) || !item.session)
        || new Set(entries.map(item => item.id)).size !== entries.length) throw new Error('Formato inválido');
      return { entries: entries.map(item => ({ ...item, session: parse(JSON.stringify(item.session)) })), warning: null, recoveryRaw: null };
    } catch { return { entries: [], warning: 'Biblioteca antiga corrompida: originais preservados; baixe-os antes de substituir.', recoveryRaw: raw }; }
  } catch { return { entries: [], warning: 'Biblioteca indisponível neste navegador; exporte seus exercícios.', recoveryRaw: null }; }
}
