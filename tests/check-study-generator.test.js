// A2 — o conferidor de catálogo é privacidade-safe: imprime só contagens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const script = join(root, 'scripts/check-study-generator.js');

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
}

test('check-study-generator: sem catálogo usa fixtures públicos e sai limpo', () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /study-generator: \d+ material\(is\)/);
  assert.match(result.stdout, /motivos:/);
  assert.match(result.stdout, /movimento_continuo_linha_4_notas/);
});

test('check-study-generator: nunca ecoa título, id, filename, caminho nem termo privado', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gg-study-'));
  const catalogPath = join(directory, 'MAPA-PRIVADO-DO-CURSO.json');
  const secret = 'AULA-SECRETA-EXEMPLO';
  writeFileSync(catalogPath, JSON.stringify({
    curso: { titulo: secret },
    modulos: [{
      nome: `${secret}-MODULO`,
      aulas: [{
        nome_do_exercicio: `${secret}-EXERCICIO`, familia: 'movimento_continuo_grave_agudo_grave', qualidade: 'maior',
        sequencia_de_acordes: { cifras: ['C'] }, regiao_do_braco: { observada_na_tab: { de: 1, ate: 5 } },
        total_de_compassos: 4, contorno: { padrao: 'sobe-desce' }, figura_ritmica: { padrao_codigo: 'quarters' },
      }],
    }],
  }), 'utf8');
  try {
    const result = run([catalogPath]);
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stdout.includes('MAPA-PRIVADO'), false);
    assert.equal(result.stdout.includes(catalogPath), false);
    assert.equal(result.stderr.includes(secret), false);
    assert.match(result.stdout, /1 material\(is\)/);
    assert.match(result.stdout, /movimento_continuo_grave_agudo_grave: 1/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('check-study-generator: divergência real de compassos aparece como motivo e falha', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gg-study-'));
  const catalogPath = join(directory, 'catalogo.json');
  writeFileSync(catalogPath, JSON.stringify([{
    familia: 'movimento_continuo_linha_4_notas', qualidade: 'maior', sequencia_de_acordes: { cifras: ['C', 'G'] },
    regiao_do_braco: { observada_na_tab: { de: 1, ate: 5 } }, total_de_compassos: 7,
    contorno: { padrao: 'sobe' }, figura_ritmica: { padrao_codigo: 'quarters' },
  }]), 'utf8');
  try {
    const result = run([catalogPath]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /bars 1/);
    assert.match(result.stdout, /movimento_continuo_linha_4_notas: 1 · ok 0 · bars 1/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('check-study-generator: biblioteca de formas fornece o binding (sem forma, conta forma-nao-definida)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gg-study-'));
  const catalogPath = join(directory, 'catalogo.json');
  const formsPath = join(directory, 'formas.json');
  writeFileSync(catalogPath, JSON.stringify([{
    familia: 'arpejo_triade_forma_unica', qualidade: 'maior', sequencia_de_acordes: { cifras: ['C'] },
    regiao_do_braco: { observada_na_tab: { de: 7, ate: 10 } }, aula_id: 7, pagina_do_pdf: 3,
    total_de_compassos: 2, figura_ritmica: { padrao_codigo: 'arpejo' }, extensao_em_casas: { menor: 7, maior: 10 },
  }]), 'utf8');
  writeFileSync(formsPath, JSON.stringify({
    versao: 1,
    formas: [{
      id: 'forma-1', familia: 'arpejo_triade_forma_unica', qualidade: 'maior', graus: [1, 3, 5],
      notas: [{ corda: 4, casa: 3, grau: 1 }, { corda: 3, casa: 2, grau: 3 }, { corda: 3, casa: 5, grau: 5 }],
      aplicar: { aula_id: 7, pagina_do_pdf: 3 },
    }],
  }), 'utf8');
  try {
    const withoutForm = run([catalogPath]);
    assert.match(withoutForm.stdout, /forma-nao-definida 1/);
    const withForm = run([catalogPath, `--formas=${formsPath}`]);
    assert.match(withForm.stdout, /arpejo_triade_forma_unica: 1 · ok 1/);
    assert.equal(withForm.stdout.includes('forma-nao-definida 1'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('check-study-generator: compara derivados com a observação (cordas em letras, código rítmico); contorno só informa', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gg-study-'));
  const catalogPath = join(directory, 'catalogo.json');
  // Arpejo T-3-5 em 1..5 por 12 quartas + final: 25 compassos, cordas G D A E, casas 1..5.
  const quartas = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'B', 'E', 'A', 'D', 'G', 'C'];
  const good = {
    familia: 'arpejo_triade_formas_combinadas', qualidade: 'maior', sequencia_de_acordes: { cifras: quartas },
    regiao_do_braco: { declarada: { de: 1, ate: 5 }, observada_na_tab: { de: 1, ate: 5 } }, compassos_por_acorde: 2,
    contorno: { padrao: 'T-3-5' }, figura_ritmica: { padrao_codigo: 'q q h | h(lig) pausa_h', compasso_final: 'w' },
    total_de_compassos: 25, cordas_usadas: ['G', 'D', 'A', 'E'], extensao_em_casas: { menor: 1, maior: 5 },
  };
  writeFileSync(catalogPath, JSON.stringify([
    good,
    { ...good, cordas_usadas: ['D', 'A', 'E'] },
    { ...good, figura_ritmica: { padrao_codigo: 'q q h | w', compasso_final: 'w' } },
    { ...good, figura_ritmica: { padrao_codigo: 'q q ??', compasso_final: 'w' } },
    // Só contorno: o contorno define a figura, então nada independente para conferir.
    { familia: 'arpejo_triade_formas_combinadas', qualidade: 'maior', sequencia_de_acordes: { cifras: ['C'] }, contorno: { padrao: '5-T-3' } },
  ]), 'utf8');
  try {
    const result = run([catalogPath]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /5 material\(is\); 1 família\(s\); 2 conferido\(s\) sem divergência; 2 com divergência; 1 não conferível/);
    assert.match(result.stdout, /arpejo_triade_formas_combinadas: 5 · ok 2 · rhythm 1 · ritmo-nao-mapeado 1 · sem-dados-para-conferir 1 · strings 1/);
    assert.match(result.stdout, /checagens: bars 4 · strings 4 · minmax-frets 4 · regiao 4 · rhythm 3\n/);
    assert.match(result.stdout, /informativo \(não conta\): graus-ordem-igual 5 · graus-ordem-diferente 0 · contorno-nao-mapeado 0/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
