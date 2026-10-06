// Fronteiras de dados e ciclo de vida do tempo de prática: intervalos fechados,
// idempotência, corrupção, cota e leitura de referência. Nada aqui testa DOM,
// redação ou encaminhamento de eventos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPracticeActivity,
  normalizeActivityRecord,
  normalizeActivityInterval,
  activityStorage,
  PRACTICE_ACTIVITY_KEY,
  PRACTICE_ACTIVITY_RECOVERY_KEY,
} from '../src/practice-activity.js';
import { memoryStorage } from './storage-fixture.js';

const interval = { startedAt: '2026-10-06T10:00:00.000Z', endedAt: '2026-10-06T10:05:00.000Z' };

function closed(overrides = {}) {
  return { id: 'a1', exerciseId: 'ex-1', instrument: 'guitar', source: 'trainer', mode: 'evaluated', ...interval, ...overrides };
}

test('intervalo fechado: duração derivada em ms e fim anterior recusado', () => {
  assert.deepEqual(normalizeActivityInterval(interval), { ...interval, durationMs: 300000 });
  assert.equal(normalizeActivityInterval({ startedAt: interval.endedAt, endedAt: interval.startedAt }), null);
  assert.equal(normalizeActivityInterval({ startedAt: interval.startedAt }), null);
  assert.equal(normalizeActivityInterval({ startedAt: 'ontem', endedAt: interval.endedAt }), null);
  // Um número fora do alcance de Date não pode lançar RangeError nem virar uma data inventada.
  assert.equal(normalizeActivityInterval({ startedAt: 1e300, endedAt: interval.endedAt }), null);
  assert.equal(normalizeActivityInterval({ startedAt: interval.startedAt, endedAt: Number.NaN }), null);
});

test('registro recusado quando exerciseId/instrumento/source/mode são inválidos', () => {
  assert.equal(normalizeActivityRecord(closed({ exerciseId: undefined })).exerciseId, null);
  assert.equal(normalizeActivityRecord(closed({ exerciseId: 42 })), null, 'exerciseId presente e inválido não vira null em silêncio');
  assert.equal(normalizeActivityRecord(closed({ exerciseId: 'x'.repeat(121) })), null);
  assert.equal(normalizeActivityRecord(closed({ instrument: 'piano' })), null);
  assert.equal(normalizeActivityRecord(closed({ source: 'repertoire' })), null);
  assert.equal(normalizeActivityRecord(closed({ mode: '' })), null);
  assert.equal(normalizeActivityRecord(closed({ startedAt: 1e300 })), null);
});

test('append idempotente por id: encerramento repetido não duplica nem troca o registro', () => {
  const activity = createPracticeActivity({ storage: memoryStorage() });
  const first = activity.append(closed());
  assert.ok(first);
  assert.equal(activity.size(), 1);
  assert.deepEqual(activity.append(closed()), first, 'mesmo id e mesmo conteúdo devolve o existente');
  assert.equal(activity.append(closed({ mode: 'together' })), null, 'mesmo id com conteúdo diferente é recusado');
  assert.equal(activity.size(), 1);
  assert.equal(activity.append({ ...closed({ id: 'a2' }), startedAt: interval.endedAt, endedAt: interval.startedAt }), null);
  assert.equal(activity.size(), 1, 'intervalo inválido não entra na loja');
  const generated = activity.append({ ...closed({ id: undefined }), mode: 'routine' });
  assert.ok(generated.id);
  assert.equal(activity.size(), 2);
});

test('list devolve cópias ordenadas por início com duração derivada', () => {
  const activity = createPracticeActivity({ storage: memoryStorage() });
  activity.append(closed({ id: 'b', startedAt: '2026-10-06T11:00:00.000Z', endedAt: '2026-10-06T11:01:00.000Z' }));
  activity.append(closed({ id: 'a' }));
  const list = activity.list();
  assert.deepEqual(list.map(entry => entry.id), ['a', 'b']);
  assert.equal(list[0].durationMs, 300000);
  list[0].mode = 'mutado';
  assert.equal(activity.list()[0].mode, 'evaluated', 'a lista devolve cópias');
});

test('JSON corrompido: bytes preservados, gravação bloqueada até recuperação explícita', () => {
  const storage = memoryStorage(new Map([[PRACTICE_ACTIVITY_KEY, '{"version":1,"records":[']]));
  const activity = createPracticeActivity({ storage });
  assert.equal(activity.status, 'corrupt');
  assert.equal(activity.recoveryRaw, '{"version":1,"records":[');
  assert.equal(activity.recoveryKey, PRACTICE_ACTIVITY_RECOVERY_KEY);
  const record = activity.append(closed());
  assert.ok(record, 'intervalo real continua aceito em memória');
  assert.equal(activity.flush(), false, 'flush não destrava corrupção');
  assert.equal(storage.getItem(PRACTICE_ACTIVITY_KEY), '{"version":1,"records":[', 'bytes originais intactos');
  assert.equal(storage.getItem(PRACTICE_ACTIVITY_RECOVERY_KEY), null, 'sem escrita nenhuma até a recuperação');
  assert.equal(activity.list().length, 1, 'o intervalo novo segue acessível nesta página');
  assert.equal(activity.recover(), true);
  assert.equal(storage.getItem(PRACTICE_ACTIVITY_RECOVERY_KEY), '{"version":1,"records":[');
  assert.equal(activity.status, 'ready');
  assert.equal(JSON.parse(storage.getItem(PRACTICE_ACTIVITY_KEY)).records.length, 1);
  assert.equal(activity.recoveryRaw, '{"version":1,"records":[', 'os bytes antigos continuam disponíveis para download');
});

test('registro inválido dentro do documento marca a loja como corrompida sem perdê-lo', () => {
  const raw = JSON.stringify({ version: 1, records: [closed(), { ...closed({ id: 'a2' }), instrument: 'piano' }] });
  const storage = memoryStorage(new Map([[PRACTICE_ACTIVITY_KEY, raw]]));
  const activity = createPracticeActivity({ storage });
  assert.equal(activity.status, 'corrupt');
  assert.equal(activity.recoveryRaw, raw);
  assert.equal(activity.list().length, 1, 'os registros válidos continuam legíveis');
  assert.equal(activity.flush(), false);
  assert.equal(storage.getItem(PRACTICE_ACTIVITY_KEY), raw, 'o registro inválido não é descartado por uma escrita');
  assert.equal(activity.clear(), true, 'limpeza explícita');
  assert.equal(storage.getItem(PRACTICE_ACTIVITY_RECOVERY_KEY), raw, 'a limpeza preserva os bytes antigos');
  assert.deepEqual(activity.list(), []);
});

test('duplicata conflitante é corrupção; duplicata idêntica é saneada', () => {
  const conflicting = JSON.stringify({ version: 1, records: [closed(), closed({ mode: 'together' })] });
  const storage = memoryStorage(new Map([[PRACTICE_ACTIVITY_KEY, conflicting]]));
  const activity = createPracticeActivity({ storage });
  assert.equal(activity.status, 'corrupt');
  assert.equal(activity.list().length, 1);
  const identical = JSON.stringify({ version: 1, records: [closed(), closed()] });
  const clean = createPracticeActivity({ storage: memoryStorage(new Map([[PRACTICE_ACTIVITY_KEY, identical]])) });
  assert.equal(clean.status, 'ready');
  assert.equal(clean.list().length, 1);
});

test('versão desconhecida não é sobrescrita por um registro novo', () => {
  const raw = JSON.stringify({ version: 99, records: [closed()] });
  const storage = memoryStorage(new Map([[PRACTICE_ACTIVITY_KEY, raw]]));
  const activity = createPracticeActivity({ storage });
  assert.equal(activity.status, 'corrupt');
  assert.ok(activity.append(closed({ id: 'novo' })), 'intervalo real continua aceito em memória');
  assert.equal(activity.list().length, 1, 'a versão desconhecida não é reinterpretada como registros atuais');
  assert.equal(activity.flush(), false);
  assert.equal(storage.getItem(PRACTICE_ACTIVITY_KEY), raw);
});

test('falha de cota mantém os registros em memória e avisa', () => {
  const base = memoryStorage();
  const storage = {
    getItem: base.getItem,
    removeItem: base.removeItem,
    setItem(key, value) {
      if (key === PRACTICE_ACTIVITY_KEY) {
        const error = new Error('cheio');
        error.name = 'QuotaExceededError';
        throw error;
      }
      return base.setItem(key, value);
    },
  };
  const activity = createPracticeActivity({ storage });
  assert.ok(activity.append(closed()));
  assert.equal(activity.status, 'quota');
  assert.match(activity.warning, /QuotaExceededError/);
  assert.equal(activity.list().length, 1, 'nada é descartado em silêncio');
  assert.ok(activity.append(closed({ id: 'a2' })));
  assert.equal(activity.list().length, 2);
});

test('armazenamento bloqueado ou volátil não impede a leitura em memória', () => {
  const descriptor = { get() { throw new Error('SecurityError'); }, configurable: true };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', descriptor);
  try {
    const fallback = activityStorage();
    assert.equal(fallback.volatile, true);
    const activity = createPracticeActivity();
    assert.equal(activity.volatile, true);
    assert.ok(activity.append(closed()));
    assert.equal(activity.list().length, 1);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});

test('subscribe avisa nas mudanças e clear explícito persiste uma loja vazia', () => {
  const storage = memoryStorage();
  const activity = createPracticeActivity({ storage });
  let calls = 0;
  const off = activity.subscribe(() => { calls += 1; });
  activity.append(closed());
  assert.equal(calls, 1);
  off();
  activity.append(closed({ id: 'a3' }));
  assert.equal(calls, 1);
  activity.clear();
  assert.deepEqual(activity.list(), []);
  assert.deepEqual(JSON.parse(storage.getItem(PRACTICE_ACTIVITY_KEY)).records, []);
  assert.equal(activity.status, 'ready');
});
