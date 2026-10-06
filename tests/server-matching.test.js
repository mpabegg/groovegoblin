// Casamento de nome entre a pasta de entrada e os materiais do curso
// (rodada 6, etapa 8 / B4b) — consumidor.
//
// Curso fictício "Curso de Exemplo", aulas "Aula 1"/"Aula 2", materiais
// "Apostila de Exemplo" e "Faixa de Exemplo".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apostilaPageFor, classifyFileName, courseMaterialIndex, extensionOf, FILE_KINDS,
  foldName, isSixStringsName, matchKey, memberId, parseMemberId, withoutExtension,
} from '../server/matching.js';

function courseDocument() {
  return {
    format: 'groovegoblin-course',
    version: 2,
    course: {
      id: 'curso-exemplo',
      title: 'Curso de Exemplo',
      strings: 4,
      sections: [{
        id: 'modulo-1',
        title: 'Módulo 1',
        type: 'módulo',
        lessons: [
          {
            id: 'aula-1',
            title: 'Aula 1',
            type: 'aula',
            resources: [
              { id: 'material-1', name: 'Apostila de Exemplo.pdf', extension: 'pdf', role: 'apostila', pdfPage: null },
              { id: 'material-2', name: 'Faixa de Exemplo', extension: 'mp3', role: 'faixa' },
            ],
            resourceRefs: [],
            suggestedExercises: [{ id: 'ex-1', title: 'Exercício de Exemplo', trackNames: ['Apostila de Exemplo.pdf'], pdfPage: 12 }],
          },
          { id: 'aula-2', title: 'Aula 2', type: 'aula', resources: [], resourceRefs: [{ lessonId: 'aula-1', resourceId: 'material-1' }], suggestedExercises: [] },
        ],
      }],
    },
  };
}

test('matching: a chave tolera caixa, acento, espaço, hífen, underscore e sufixo de cópia', () => {
  const alvo = matchKey('Apostila de Exemplo.pdf');
  assert.equal(matchKey('APOSTILA DE EXEMPLO.PDF'), alvo);
  assert.equal(matchKey('apostila-de-exemplo (1).pdf'), alvo);
  assert.equal(matchKey('apostila_de_exemplo (2).PDF'), alvo);
  assert.equal(matchKey('Apostila de Exemplo - cópia.pdf'), alvo);
  assert.equal(matchKey('Apostila  de   Exemplo.pdf'), alvo);
  assert.equal(matchKey('Exercício 1.mp3'), matchKey('exercicio 1.mp3'));
  assert.equal(matchKey('Exercício 1.mp3'), matchKey('Exercicio1.MP3'));
  assert.notEqual(matchKey('Apostila de Exemplo.pdf'), matchKey('Apostila de Exemplo 2.pdf'));
  assert.notEqual(matchKey('Apostila.pdf'), matchKey('Faixa.pdf'));
});

test('matching: nome vazio ou só pontuação não tem chave', () => {
  assert.equal(matchKey(''), null);
  assert.equal(matchKey('   '), null);
  assert.equal(matchKey('---'), null);
  assert.equal(matchKey(null), null);
  assert.equal(foldName('  Ação  Útil '), 'acao util');
});

test('matching: extensão e tipo do arquivo pelo nome', () => {
  assert.equal(extensionOf('Apostila.PDF'), 'pdf');
  assert.equal(extensionOf('sem-extensao'), '');
  assert.equal(withoutExtension('Apostila.PDF'), 'Apostila');
  assert.equal(withoutExtension('sem ponto'), 'sem ponto');
  assert.equal(classifyFileName('Apostila de Exemplo.pdf'), FILE_KINDS.pdf);
  assert.equal(classifyFileName('Faixa de Exemplo.mp3'), FILE_KINDS.audio);
  assert.equal(classifyFileName('Faixa de Exemplo.WAV'), FILE_KINDS.audio);
  assert.equal(classifyFileName('Pacote de Exemplo.zip'), FILE_KINDS.zip);
  assert.equal(classifyFileName('anotacoes.txt'), FILE_KINDS.other);
  assert.equal(classifyFileName('Apostila 6 cordas.pdf'), FILE_KINDS.sixStrings);
  assert.equal(classifyFileName('../Apostila.pdf'), FILE_KINDS.invalid);
  assert.equal(classifyFileName('a\\b.pdf'), FILE_KINDS.invalid);
  assert.equal(classifyFileName(''), FILE_KINDS.invalid);
  assert.equal(classifyFileName('Apostila\n.pdf'), FILE_KINDS.invalid);
});

test('matching: 6 cordas é reconhecido pelo nome, mas o pacote das duas versões fica', () => {
  assert.equal(isSixStringsName('Apostila 6 cordas.pdf'), true);
  assert.equal(isSixStringsName('Apostila 6-cordas.pdf'), true);
  assert.equal(isSixStringsName('Apostila 6_cordas.pdf'), true);
  assert.equal(isSixStringsName('Apostila seis cordas.pdf'), true);
  assert.equal(isSixStringsName('Apostila 4 e 6 cordas.zip'), false);
  assert.equal(isSixStringsName('Pacote 4+6 cordas.zip'), false);
  assert.equal(isSixStringsName('Apostila 4 cordas.pdf'), false);
});

test('matching: índice de materiais do curso usa a mesma chave do app', () => {
  const index = courseMaterialIndex(courseDocument(), 'curso-exemplo');
  assert.equal(index.total, 2);
  assert.equal(index.list[0].refKey, JSON.stringify(['curso-exemplo', 'aula-1', 'material-1']));
  assert.equal(index.list[1].refKey, JSON.stringify(['curso-exemplo', 'aula-1', 'material-2']));
  assert.deepEqual(index.match('APOSTILA DE EXEMPLO (1).pdf').map((material) => material.resourceId), ['material-1']);
  assert.deepEqual(index.match('Faixa de Exemplo.mp3').map((material) => material.resourceId), ['material-2']);
  assert.deepEqual(index.match('nada-a-ver.pdf'), []);
  assert.equal(index.byRefKey(JSON.stringify(['curso-exemplo', 'aula-2', 'material-1'])), null);
  assert.equal(index.byRefKey(index.list[1].refKey).resourceId, 'material-2');
});

test('matching: dois materiais com o mesmo nome em aulas diferentes casam com os dois', () => {
  const document = courseDocument();
  document.course.sections[0].lessons[1].resources = [{ id: 'material-9', name: 'Apostila de Exemplo.pdf', extension: 'pdf', role: 'apostila' }];
  const index = courseMaterialIndex(document, 'curso-exemplo');
  const matches = index.match('apostila de exemplo.pdf');
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((material) => material.refKey), [
    JSON.stringify(['curso-exemplo', 'aula-1', 'material-1']),
    JSON.stringify(['curso-exemplo', 'aula-2', 'material-9']),
  ]);
});

test('matching: identificador de membro de ZIP vai e volta', () => {
  const id = memberId('Pacote de Exemplo.zip', 'Apostila de Exemplo.pdf');
  assert.equal(id, 'Pacote de Exemplo.zip::Apostila de Exemplo.pdf');
  assert.deepEqual(parseMemberId(id), { zipName: 'Pacote de Exemplo.zip', memberName: 'Apostila de Exemplo.pdf' });
  assert.equal(parseMemberId('Apostila.pdf'), null);
  assert.equal(parseMemberId('::membro.pdf'), null);
  assert.equal(parseMemberId('pacote.zip::'), null);
  assert.equal(parseMemberId(null), null);
});

test('matching: página da apostila vem do exercício e, sem ela, do material citado', () => {
  const document = courseDocument();
  document.course.sections[0].lessons[0].resources[0].pdfPage = 30;
  const index = courseMaterialIndex(document, 'curso-exemplo');
  const lesson = document.course.sections[0].lessons[0];
  assert.equal(apostilaPageFor(index, lesson, { pdfPage: 12, trackNames: [] }), 12);
  assert.equal(apostilaPageFor(index, lesson, { pdfPage: null, trackNames: ['Apostila de Exemplo.pdf'] }), 30);
  assert.equal(apostilaPageFor(index, lesson, { pdfPage: null, trackNames: ['nada.pdf'] }), null);
  assert.equal(apostilaPageFor(index, lesson, {}), null);
});
