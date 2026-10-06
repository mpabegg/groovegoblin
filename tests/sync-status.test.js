// Linha de estado, indicador de problema e ações do painel de sincronização.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountSyncStatus, statusText, problemOf, relativeTime } from '../src/sync-status.js';

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.hidden = false;
    this.textContent = '';
    this.className = '';
    this.open = false;
  }

  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, target: this }); }
  click() { this.dispatch('click'); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
  focus() { this.focused = true; }
}

const doc = { createElement: tag => new El(tag), createTextNode: text => ({ textContent: text }) };

function createFakeEngine(initial) {
  const listeners = new Set();
  let snapshot = initial;
  const calls = [];
  return {
    calls,
    setSnapshot(next) { snapshot = next; for (const listener of [...listeners]) listener(snapshot); },
    snapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async syncNow() { calls.push(['syncNow']); return { sent: 2 }; },
    async probe() { calls.push(['probe']); return { ok: true }; },
    async sendAll() { calls.push(['sendAll']); return { sent: 3 }; },
    async mergeBoth() { calls.push(['mergeBoth']); return { sent: 1, applied: 2, conflicts: 0 }; },
    async resolveConflict(id, side) { calls.push(['resolveConflict', id, side]); return { ok: true, side }; },
    conflicts: () => snapshot.conflicts > 0 ? [{ id: 'exercises|ex-1', collection: 'exercises', docId: 'ex-1', intent: 'put' }] : [],
    pinned: () => snapshot.pinned > 0 ? [{ sha256: 'a'.repeat(64), name: 'apostila.pdf' }] : [],
    unpinAttachment(sha) { calls.push(['unpin', sha]); },
    exportRecovered: () => '{"format":"groovegoblin-sync-conflicts"}',
  };
}

const baseSnapshot = {
  mode: 'local', connected: false, online: true, firstConnect: null, busy: null,
  lastSyncAt: null, pending: 0, conflicts: 0, recovered: 0, pinned: 0,
  health: null, serverEmpty: null, summary: null, warnings: [],
};

test('a linha cobre os quatro estados do contrato', () => {
  assert.equal(statusText({ ...baseSnapshot }, { now: 0 }), 'Sem servidor (dados só neste navegador)');
  assert.equal(statusText({ ...baseSnapshot, mode: 'offline' }), 'Servidor: sem conexão');
  assert.equal(statusText({ ...baseSnapshot, mode: 'connected', pending: 3 }), 'Servidor: 3 alterações na fila');
  assert.equal(statusText({ ...baseSnapshot, mode: 'connected', pending: 1 }), 'Servidor: 1 alteração na fila');
  assert.equal(
    statusText({ ...baseSnapshot, mode: 'connected', lastSyncAt: '2026-01-01T00:02:00.000Z' }, { now: Date.parse('2026-01-01T00:04:00.000Z') }),
    'Servidor: sincronizado há 2 min',
  );
  assert.equal(statusText({ ...baseSnapshot, mode: 'identity' }), 'Servidor: identidade do Tailscale ausente ou não permitida');
  assert.equal(statusText({ ...baseSnapshot, mode: 'connected', conflicts: 2, pending: 5 }), 'Servidor: 2 conflitos para resolver');
  assert.equal(relativeTime('2026-01-01T00:00:00.000Z', Date.parse('2026-01-01T00:00:30.000Z')), 'agora mesmo');
});

test('o indicador do cabeçalho só aparece com problema de verdade', () => {
  assert.equal(problemOf(baseSnapshot), null);
  assert.equal(problemOf({ ...baseSnapshot, mode: 'connected', pending: 4 }), null);
  assert.equal(problemOf({ ...baseSnapshot, mode: 'offline' }), null);
  assert.equal(problemOf({ ...baseSnapshot, mode: 'identity' }), 'identity');
  assert.equal(problemOf({ ...baseSnapshot, mode: 'connected', conflicts: 1 }), 'conflicts');
  assert.equal(problemOf({ ...baseSnapshot, mode: 'connected', warnings: ['algo'] }), 'warning');
});

test('o painel mostra a linha, esconde o indicador sem problema e reage a conflitos', async () => {
  const engine = createFakeEngine({ ...baseSnapshot });
  const help = new El('div');
  const header = new El('div');
  const view = mountSyncStatus({ engine, helpContainer: help, headerContainer: header, document: doc, now: () => 0 });

  const details = help.children[0];
  const panel = details.children[1];
  const [line, detail, first, actions, conflictsBox, pinnedBox] = panel.children;
  const indicator = header.children[0];
  assert.equal(line.textContent, 'Sem servidor (dados só neste navegador)');
  assert.equal(indicator.hidden, true);
  assert.equal(conflictsBox.children.length, 0);
  assert.equal(pinnedBox.children.length, 0);
  assert.equal(first.hidden, true);

  engine.setSnapshot({ ...baseSnapshot, mode: 'connected', lastSyncAt: '2026-01-01T00:00:00.000Z', pending: 2 });
  assert.equal(line.textContent, 'Servidor: 2 alterações na fila');
  assert.equal(indicator.hidden, true);
  const syncButton = actions.children[0];
  assert.equal(syncButton.hidden, false);
  syncButton.click();
  assert.deepEqual(engine.calls.at(-1), ['syncNow']);

  engine.setSnapshot({ ...baseSnapshot, mode: 'connected', conflicts: 1, pinned: 1 });
  assert.equal(line.textContent, 'Servidor: 1 conflito para resolver');
  assert.equal(indicator.hidden, false);
  assert.match(indicator.textContent, /1 conflito/);
  indicator.click();
  assert.equal(details.open, true);
  assert.equal(line.focused, true);

  const conflictItem = conflictsBox.children[1].children[0];
  assert.match(conflictItem.children[0].textContent, /ex-1/);
  conflictItem.children[1].click();
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(engine.calls.at(-1), ['resolveConflict', 'exercises|ex-1', 'mine']);

  const pinnedItem = pinnedBox.children[1].children[0];
  assert.equal(pinnedItem.children[0].textContent, 'apostila.pdf');
  pinnedItem.children[1].click();
  assert.deepEqual(engine.calls.at(-1), ['unpin', 'a'.repeat(64)]);

  engine.setSnapshot({ ...baseSnapshot, mode: 'connected', degraded: ['forms (bindings)'] });
  assert.ok(detail.children.some(node => /forms \(bindings\)/.test(node.textContent ?? '')));

  view.destroy();
  assert.equal(help.children.length, 0);
  assert.equal(header.children.length, 0);
});

test('primeira conexão oferece enviar ou mesclar, e "agora não" recolhe', async () => {
  const engine = createFakeEngine({ ...baseSnapshot, mode: 'connected', firstConnect: 'merge' });
  const help = new El('div');
  const view = mountSyncStatus({ engine, helpContainer: help, document: doc });
  const panel = help.children[0].children[1];
  const [, , first, actions] = panel.children;
  const spinning = actions.children[0];
  assert.equal(spinning.hidden, true, 'com primeira conexão pendente, "sincronizar agora" não aparece');
  assert.equal(first.hidden, false);

  const [upload, merge, later] = first.children;
  assert.equal(upload.hidden, false);
  assert.equal(merge.hidden, false);
  upload.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(engine.calls.at(-1), ['sendAll']);

  merge.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(engine.calls.at(-1), ['mergeBoth']);

  later.click();
  assert.equal(first.hidden, true);
  view.destroy();
});
