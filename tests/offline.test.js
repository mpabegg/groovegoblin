import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupOffline } from '../src/offline.js';

class Element extends EventTarget {
  hidden = false;
  disabled = false;
  textContent = '';
  children = [];
  setAttribute() {}
  replaceChildren(...children) { this.children = children; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}

async function offline(t, { registeredScope } = {}) {
  const container = new Element();
  const worker = new EventTarget();
  worker.state = 'installed';
  const posted = [];
  worker.postMessage = value => posted.push(value);
  const scope = new URL('../', new URL('../src/offline.js', import.meta.url)).href;
  const registration = new EventTarget();
  Object.assign(registration, { scope: registeredScope ?? scope, active: {}, waiting: worker, installing: null });
  const serviceWorker = new EventTarget();
  serviceWorker.getRegistration = async queriedScope => { assert.equal(queriedScope, scope); return registration; };
  const window = new EventTarget();
  let reloads = 0;
  window.isSecureContext = true;
  window.location = { reload() { reloads++; } };
  const globals = {
    document: { getElementById: () => container, createElement: () => new Element(), createTextNode: text => text },
    navigator: { serviceWorker, onLine: true },
    window,
  };
  const previousGlobals = new Map();
  for (const [key, value] of Object.entries(globals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  let busy = false;
  let saved = true;
  const notifications = [];
  const dispose = setupOffline({ isBusy: () => busy, canReload: () => saved, notify: (...args) => notifications.push(args) });
  t.after(() => {
    dispose();
    for (const [key, previous] of previousGlobals) {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    }
  });
  await Promise.resolve();
  const [status, , prepare, , apply] = container.children;
  return { status, prepare, apply, posted, registration, serviceWorker, window, notifications,
    setBusy(value) { busy = value; }, setSaved(value) { saved = value; }, get reloads() { return reloads; } };
}

test('atualização não ativa nem recarrega enquanto a aplicação está ocupada', async t => {
  const ui = await offline(t);
  ui.setBusy(true);
  ui.apply.click();
  assert.deepEqual(ui.posted, []);
  assert.equal(ui.reloads, 0);
  assert.equal(ui.notifications[0][1], true);
});

test('operação iniciada durante ativação é preservada até recarga explícita', async t => {
  const ui = await offline(t);
  ui.apply.click();
  assert.deepEqual(ui.posted, [{ type: 'ACTIVATE_UPDATE' }]);
  ui.setBusy(true);
  ui.registration.waiting = null;
  ui.serviceWorker.dispatchEvent(new Event('controllerchange'));
  assert.equal(ui.reloads, 0);
  assert.equal(ui.apply.hidden, false);
  assert.equal(ui.apply.disabled, false);
  assert.match(ui.apply.textContent, /Recarregar/);
  ui.window.dispatchEvent(new Event('offline'));
  assert.equal(ui.apply.hidden, false);
  assert.match(ui.status.textContent, /Pare/);
  ui.apply.click();
  assert.equal(ui.reloads, 0);
  ui.setBusy(false);
  ui.apply.click();
  assert.equal(ui.reloads, 1);
});

test('ativação solicitada com aplicação ainda parada recarrega', async t => {
  const ui = await offline(t);
  ui.apply.click();
  ui.registration.waiting = null;
  ui.serviceWorker.dispatchEvent(new Event('controllerchange'));
  assert.equal(ui.reloads, 1);
});

test('ativação de outra aba não recarrega esta aba sem solicitação', async t => {
  const ui = await offline(t);
  ui.registration.waiting = null;
  ui.serviceWorker.dispatchEvent(new Event('controllerchange'));
  assert.equal(ui.reloads, 0);
  assert.equal(ui.apply.hidden, true);
});

test('instalação de escopo ancestral não é confundida com esta aplicação', async t => {
  const ui = await offline(t, { registeredScope: 'https://example.test/' });
  assert.equal(ui.apply.hidden, true);
  assert.equal(ui.prepare.textContent, 'Preparar uso offline');
});

test('sessão só na memória impede ativação e avisa como preservar os dados', async t => {
  const ui = await offline(t);
  ui.setSaved(false);
  ui.apply.click();
  assert.deepEqual(ui.posted, []);
  assert.equal(ui.reloads, 0);
  assert.match(ui.notifications[0][0], /só na memória/);
  assert.equal(ui.notifications[0][1], true);
});

test('falha de persistência durante ativação impede também recarga posterior', async t => {
  const ui = await offline(t);
  ui.apply.click();
  ui.setSaved(false);
  ui.registration.waiting = null;
  ui.serviceWorker.dispatchEvent(new Event('controllerchange'));
  assert.equal(ui.reloads, 0);
  assert.equal(ui.apply.hidden, false);
  assert.match(ui.status.textContent, /só na memória/);
  assert.match(ui.notifications.at(-1)[0], /só na memória/);
  ui.apply.click();
  assert.equal(ui.reloads, 0);
  ui.setSaved(true);
  ui.apply.click();
  assert.equal(ui.reloads, 1);
});
