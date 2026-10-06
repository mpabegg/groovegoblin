// A3 — Controlador das formas de dedilhado (rodada 6).
//
// Liga três peças que não se conhecem: o painel Braço (`studio-fretboard.js`), a
// loja (localStorage, fora da sessão) e o gerador de estudos (A2), que só aceita
// a forma móvel `{id,label,quality,degrees,notes}`. A interface não fala com a
// loja nem com o gerador diretamente, e o gerador não conhece DOM: este módulo é
// a única costura.
//
// É daqui que a etapa A4/A5 tira as escolhas de forma para a receita
// (`shapeChoicesForRecipe`/`shapeForRecipe`) e que a Biblioteca tira a mesma
// instância de loja para o backup privado.

import { sharedFingeringShapeStore, toGeneratorShape } from './fingering-shapes.js';
import { mountFingeringShapes } from './fingering-shapes-view.js';

// Monta o editor dentro do `<details>` do Braço. `repaint` é o gancho do quadro:
// quando a forma muda, a tabela é redesenhada com o destaque novo.
export function mountFingeringShapesInFretboard({ panel, table = null, store = fingeringShapeStore(), repaint = null, download = null, now = null } = {}) {
  if (!panel || typeof panel.appendChild !== 'function') throw new TypeError('Informe o painel do Braço para montar as formas de dedilhado.');
  return mountFingeringShapes(panel, {
    store,
    table,
    ...(typeof download === 'function' ? { download } : {}),
    ...(typeof now === 'function' ? { now } : {}),
    ...(typeof repaint === 'function' ? { repaint } : {}),
  });
}

// A MESMA loja compartilhada do Estúdio e do backup (uma instância por página).
export function fingeringShapeStore() {
  return sharedFingeringShapeStore();
}

// Escolhas para a receita do gerador: `shape` já sai no schema do A2
// (`normalizeShape`) e pode ir direto em `recipe.shapes`/`recipe.shape`. Formas
// sem posição no instrumento atual ficam de fora — sem "quase cabe".
export function shapeChoicesForRecipe(profile = null, { store = fingeringShapeStore() } = {}) {
  return store.list(profile)
    .filter(record => record.applicable !== false)
    .map(record => Object.freeze({
      id: record.id,
      label: record.label,
      instrument: record.instrument,
      generic: record.generic === true,
      reused: record.reused === true,
      shape: Object.freeze(toGeneratorShape(record)),
    }));
}

// Forma pronta para `recipe.shapes` a partir do identificador escolhido na
// interface. Lança (RangeError) quando a forma não existe ou não tem posição: a
// receita nunca é montada com uma forma inexistente.
export function shapeForRecipe(id, profile = null, { store = fingeringShapeStore() } = {}) {
  const record = store.list(profile).find(item => item.id === id) ?? null;
  if (record === null) throw new RangeError(`Forma de dedilhado não encontrada: ${id}.`);
  if (record.applicable === false) throw new RangeError(`A forma “${record.label}” não tem posição neste instrumento.`);
  return Object.freeze(toGeneratorShape(record));
}
