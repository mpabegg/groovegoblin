import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BARS_PER_CHORD_RANGE, COURSE_FORMAT, COURSE_LIMITS, COURSE_VERSION, normalizeCourse } from '../src/course-format.js';
import {
  DEFAULT_OUTPUT,
  KNOWN_IGNORED,
  classifyResourceRole,
  classifySectionTitle,
  classifyVideoHosting,
  convertCourseMap,
  genericPath,
  groupWarnings,
  mentionsSixStrings,
  parseUnambiguousInteger,
  parseVideoDuration,
  readTuning,
  readWatchedFlag,
  slugifyId,
} from '../scripts/convert-course-map.js';

// Fixtures e medições vêm de um curso inventado (Curso de Exemplo, example.invalid).
function readFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/course/${name}`, import.meta.url), 'utf8'));
}

function fixturePath(name) {
  return fileURLToPath(new URL(`./fixtures/course/${name}`, import.meta.url));
}

const ZERO_COUNTS = { sections: 0, lessons: 0, resources: 0, resourceRefs: 0, exercises: 0, discarded: 0, merged: 0, catalog: null };

function lessonsOf(document) {
  return document.course.sections.flatMap((section) => section.lessons);
}

function stringsOf(value, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, found);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) stringsOf(item, found);
  return found;
}

function resourcesOf(document) {
  return lessonsOf(document).flatMap((lesson) => lesson.resources);
}

test('converte o mapa fictício completo com as contagens medidas', () => {
  const result = convertCourseMap(readFixture('map-example.json'));
  assert.equal(result.valid, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.counts, { sections: 3, lessons: 5, resources: 3, resourceRefs: 1, exercises: 2, discarded: 4, merged: 0, catalog: null });
  assert.deepEqual(result.document, readFixture('course-example-normalized.json'));
});

test('endereço longo fica indefinido em vez de virar outro destino sem aviso', () => {
  const url = `https://example.invalid/${'x'.repeat(2048)}`;
  const result = convertCourseMap({ curso: { titulo: 'Curso de Exemplo', url } });
  assert.equal(result.document.course.url, null);
  assert.ok(result.warnings.some(warning => warning.path === 'curso.url' && warning.code === 'url-longa'));
  assert.equal(JSON.stringify(result.warnings).includes(url), false);
});

test('progresso fica fora por padrão e entra com a opção', () => {
  const map = readFixture('map-example.json');
  const off = convertCourseMap(map);
  assert.equal(Object.hasOwn(off.document, 'progress'), false);

  const on = convertCourseMap(map, { includeProgress: true });
  assert.deepEqual(on.document.progress, { watchedLessonIds: ['welcome-1', 'lesson-1'] });
  const ids = new Set(lessonsOf(on.document).map((lesson) => lesson.id));
  for (const id of on.document.progress.watchedLessonIds) assert.ok(ids.has(id), 'a aula assistida existe no curso');
  assert.ok(lessonsOf(off.document).every((lesson) => Object.hasOwn(lesson, 'suggestedExercises')));
});

test('descarta material de 6 cordas e mantém apenas 4 ou 5', () => {
  const result = convertCourseMap(readFixture('map-example.json'));
  const text = JSON.stringify(result.document);
  assert.doesNotMatch(text, /6[-_ ]?cordas/i);
  assert.doesNotMatch(text, /seis cordas/i);
  const declared = lessonsOf(result.document).flatMap((lesson) => [
    ...lesson.resources.map((resource) => resource.strings),
    ...lesson.suggestedExercises.map((exercise) => exercise.strings),
  ]);
  for (const strings of declared) assert.ok([null, 4, 5].includes(strings), `cordas aceitas: ${strings}`);
  assert.ok(result.counts.discarded >= 3);
});

test('avisos citam caminho de campo e nunca valores do mapa', () => {
  const map = readFixture('map-example.json');
  const result = convertCourseMap(map, { includeProgress: true });
  assert.ok(result.warnings.length > 0);
  for (const warning of result.warnings) {
    assert.equal(typeof warning.path, 'string');
    assert.equal(typeof warning.code, 'string');
    assert.equal(typeof warning.message, 'string');
    assert.ok(warning.message.length > 0);
  }
  const values = stringsOf(map).filter((value) => value.length > 6);
  for (const warning of result.warnings) {
    for (const value of values) {
      assert.equal(warning.message.includes(value), false, 'o aviso não repete o texto do mapa');
    }
  }
  const warnText = JSON.stringify(result.warnings);
  assert.doesNotMatch(warnText, /example\.invalid/);
  assert.doesNotMatch(warnText, /Curso de Exemplo/);
  assert.doesNotMatch(warnText, /faixa-exemplo/);
});

test('avisos saem agrupados por código e caminho genérico, com a contagem', () => {
  const modulos = Array.from({ length: 60 }, (_, index) => ({
    titulo: `Módulo ${index}`,
    campo_extra: index,
    campo_extra_2: index,
    campo_extra_3: index,
    campo_extra_4: index,
    aulas: [],
  }));
  const result = convertCourseMap({ curso: { titulo: 'Curso de Exemplo' }, modulos });
  assert.equal(result.warnings.length, 240, 'a lista crua mantém uma entrada por ocorrência');
  assert.equal(result.grouped.length, 4, 'agrupa por código e caminho genérico');
  assert.deepEqual(result.grouped.map((group) => [group.path, group.code, group.count]), [
    ['modulos[].campo_extra', 'campo-ignorado', 60],
    ['modulos[].campo_extra_2', 'campo-ignorado', 60],
    ['modulos[].campo_extra_3', 'campo-ignorado', 60],
    ['modulos[].campo_extra_4', 'campo-ignorado', 60],
  ]);
  for (const group of result.grouped) {
    assert.equal(typeof group.message, 'string');
    assert.equal(group.message.includes('Módulo'), false, 'o agrupamento não repete valor do mapa');
  }

  assert.equal(genericPath('modulos[2].aulas[1].video.capitulos'), 'modulos[].aulas[].video.capitulos');
  assert.equal(genericPath('curso.titulo'), 'curso.titulo');
  assert.equal(genericPath(''), '');
  assert.deepEqual(groupWarnings([
    { path: 'a[0].b', code: 'x', message: 'primeira' },
    { path: 'a[7].b', code: 'x', message: 'segunda' },
    { path: 'a[7].b', code: 'y', message: 'terceira' },
  ]), [
    { code: 'x', path: 'a[].b', message: 'primeira', count: 2 },
    { code: 'y', path: 'a[].b', message: 'terceira', count: 1 },
  ]);
  assert.deepEqual(groupWarnings([]), []);
});

test('campos conhecidos e deliberadamente ignorados não geram aviso', () => {
  const result = convertCourseMap({
    _sobre: 'Mapa fictício de exemplo',
    curso: { titulo: 'Curso de Exemplo', instrumento: { nome: 'baixo', tipo: 'elétrico', cordas: 4 } },
    modulos: [{
      id: 7,
      titulo: 'Módulo 1',
      aulas: [{
        id: 0,
        titulo: 'Aula 1',
        tipo_de_aula: 'Prática',
        cordas: 5,
        strings: 5,
        exercicios: [{ nome: 'Exercício de Exemplo', ordem: 3 }],
        anexos: [{ id: 'material-1', nome: 'apostila-exemplo.pdf', extensao: 'pdf', papel: 'apostila' }],
        meu_progresso: { status: 'concluida', fonte: 'marcação fictícia', obs: 'observação fictícia' },
      }],
    }],
  }, { includeProgress: true });
  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.document.progress, { watchedLessonIds: ['0'] });
  assert.deepEqual(KNOWN_IGNORED.progresso, ['fonte', 'obs']);
  assert.deepEqual(KNOWN_IGNORED.aula, ['cordas', 'strings']);
});

test('progresso escalar e embrulhado chega à lista de aulas assistidas', () => {
  const markers = [true, 'assistida', { valor: 'concluída', inferido: false }, false, 'pendente'];
  const result = convertCourseMap({
    curso: { titulo: 'Curso de Exemplo', instrumento: { nome: 'baixo', cordas: 4 } },
    modulos: [{ titulo: 'Módulo de Exemplo', aulas: markers.map((meu_progresso, id) => ({
      id, titulo: `Aula de Exemplo ${id}`, meu_progresso,
    })) }],
  }, { includeProgress: true });
  assert.equal(result.valid, true);
  assert.deepEqual(result.document.progress.watchedLessonIds, ['0', '1', '2']);
});

test('citação única com mais de 32 arquivos não invalida o curso inteiro', () => {
  const names = Array.from({ length: 33 }, (_, i) => `faixa-exemplo-${i}.mp3`);
  const result = convertCourseMap({
    curso: { titulo: 'Curso de Exemplo', instrumento: { nome: 'baixo', cordas: 4 } },
    modulos: [{ titulo: 'Módulo de Exemplo', aulas: [{
      id: 1, titulo: 'Aula de Exemplo',
      exercicios: [{ nome: 'Estudo de Exemplo', arquivo_correspondente: names.join('; ') }],
    }] }],
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.document.course.sections[0].lessons[0].suggestedExercises[0].trackNames, names.slice(0, 32));
  assert.equal(result.warnings.filter(w => w.code === 'lista-longa').length, 1);
});

test('identificador numérico vira texto estável e é o id da aula', () => {
  const result = convertCourseMap({
    curso: { id: 0, titulo: 'Curso de Exemplo' },
    modulos: [{
      id: 7,
      titulo: 'Módulo 1',
      aulas: [{ id: 0, titulo: 'Aula zero' }, { id: 25, titulo: 'Aula vinte e cinco' }, { titulo: 'Aula sem identificador' }],
    }],
  });
  assert.equal(result.valid, true);
  assert.equal(result.document.course.id, '0');
  assert.deepEqual(result.document.course.sections.map((section) => section.id), ['7']);
  assert.deepEqual(lessonsOf(result.document).map((lesson) => lesson.id), ['0', '25', '7-aula-3']);
  assert.equal(result.warnings.some((warning) => warning.code === 'texto-ilegivel'), false);
  const ids = new Set(lessonsOf(result.document).map((lesson) => lesson.id));
  assert.ok(ids.has('0'), 'o id zero não se perde');

  const invalid = convertCourseMap({ curso: { titulo: 'Curso de Exemplo' }, modulos: [{ titulo: 'Módulo 1', aulas: [{ id: 1.5, titulo: 'Aula' }] }] });
  assert.equal(lessonsOf(invalid.document)[0].id, 'modulo-1-aula-1');
  assert.ok(invalid.warnings.some((warning) => warning.code === 'id-ilegivel'));
});

test('progresso aceita booleano, texto e objeto com status', () => {
  assert.equal(readWatchedFlag(true, 'p', []), true);
  assert.equal(readWatchedFlag(false, 'p', []), false);
  assert.equal(readWatchedFlag('assistida', 'p', []), true);
  assert.equal(readWatchedFlag('concluída', 'p', []), true);
  assert.equal(readWatchedFlag('CONCLUIDA', 'p', []), true);
  assert.equal(readWatchedFlag('pendente', 'p', []), false);
  assert.equal(readWatchedFlag('em andamento', 'p', []), false);
  assert.equal(readWatchedFlag('não', 'p', []), false);
  assert.equal(readWatchedFlag({ valor: true, inferido: true }, 'p', []), true);
  assert.equal(readWatchedFlag({ status: 'concluida' }, 'p', []), true);
  assert.equal(readWatchedFlag({ status: { valor: 'assistida', inferido: true } }, 'p', []), true);
  assert.equal(readWatchedFlag(undefined, 'p', []), false);
  const warnings = [];
  assert.equal(readWatchedFlag('talvez', 'p', warnings), false);
  assert.deepEqual(warnings.map((warning) => [warning.path, warning.code]), [['p', 'progresso-ilegivel']]);

  const result = convertCourseMap(readFixture('map-repairs.json'), { includeProgress: true });
  assert.deepEqual(result.document.progress, { watchedLessonIds: ['0', '25'] });
  assert.equal(result.warnings.some((warning) => warning.code === 'progresso-ilegivel'), false);
  assert.equal(result.warnings.some((warning) => warning.path.endsWith('.fonte') || warning.path.endsWith('.obs')), false);
});

test('o mesmo material nas duas listas vira um item com os dados das duas', () => {
  const result = convertCourseMap(readFixture('map-repairs.json'));
  assert.equal(result.valid, true);
  assert.equal(result.counts.merged, 2);
  assert.equal(result.counts.resources, 4);
  assert.equal(result.counts.discarded, 2);

  const lesson = lessonsOf(result.document)[0];
  assert.deepEqual(lesson.resources.map((resource) => resource.name), [
    'apostila-reparos-4-cordas.pdf',
    'faixa-reparos-4-cordas-80bpm.mp3',
    'faixa-compartilhada-reparos.mp3',
    'faixa-reparos-3-compassos-5-cordas.mp3',
  ]);
  const [apostila, repetida, compartilhada, cincoCordas] = lesson.resources;
  assert.deepEqual(repetida, {
    id: 'faixa-reparos-4-cordas-80bpm-mp3',
    name: 'faixa-reparos-4-cordas-80bpm.mp3',
    extension: 'mp3',
    role: 'faixa',
    bpm: 80,
    barsPerChord: 3,
    style: 'Reparos',
    extended: true,
    strings: 4,
  });
  assert.equal(apostila.role, 'apostila');
  assert.equal(apostila.bpm, null, 'o anexo fica com os dados da faixa, não com um segundo item');
  assert.equal(compartilhada.bpm, 90);
  assert.equal(compartilhada.barsPerChord, 4);
  assert.equal(cincoCordas.barsPerChord, 3);
  assert.equal(cincoCordas.strings, 5);
  assert.equal(normalizeCourse(result.document).ok, true);
});

test('exercício que cita o pacote alternativo de 6 cordas continua no curso', () => {
  const result = convertCourseMap(readFixture('map-repairs.json'));
  const lesson = lessonsOf(result.document)[0];
  assert.deepEqual(lesson.suggestedExercises.map((exercise) => [exercise.id, exercise.bars, exercise.strings, exercise.trackNames]), [
    ['exercicio-com-pacote-alternativo', 25, null, ['apostila-reparos-4-cordas.pdf']],
    ['exercicio-de-cinco-cordas-longo', 97, 5, ['faixa-compartilhada-reparos.mp3']],
  ]);
  assert.deepEqual(lesson.resourceRefs, [
    { lessonId: '0', resourceId: 'apostila-reparos-4-cordas-pdf' },
    { lessonId: '0', resourceId: 'faixa-compartilhada-reparos-mp3' },
  ]);
  const six = result.warnings.filter((warning) => warning.code === 'cordas-6');
  assert.deepEqual(six.map((warning) => warning.path), [
    'modulos[0].aulas[0].backing_tracks[3]',
    'modulos[0].aulas[0].exercicios[2]',
  ]);
  assert.ok(result.warnings.some((warning) => warning.code === 'cordas-6' && warning.path.endsWith('exercicios[2]')));
  assert.equal(result.warnings.some((warning) => warning.path.endsWith('exercicios[0]')), false);
});

test('material e exercício que citam as duas versões ficam', () => {
  const result = convertCourseMap({
    curso: { titulo: 'Curso de Exemplo', instrumento: { nome: 'baixo', cordas: 4 } },
    modulos: [{ titulo: 'Módulo 1', aulas: [{
      titulo: 'Aula 1',
      tipo_de_aula: 'Prática',
      anexos: [
        { nome: 'apostila-exemplo-4-cordas.pdf', extensao: 'pdf', papel: 'apostila', cordas: 4 },
        { nome: 'faixa-exemplo-4-e-6-cordas.mp3' },
        { nome: 'apostila-exemplo-6-cordas.pdf', cordas: 6 },
      ],
      backing_tracks: [{ nome: 'faixa-exemplo-4-cordas.mp3', cordas: '4+6' }],
      exercicios: [{
        nome: 'Exercício 4 e 6 cordas',
        cordas: '4+6',
        arquivo_correspondente: 'apostila-exemplo-4-cordas.pdf; pacote-exemplo-6-cordas.zip',
      }],
    }] }],
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.counts, { sections: 1, lessons: 1, resources: 3, resourceRefs: 1, exercises: 1, discarded: 1, merged: 0, catalog: null });
  const lesson = lessonsOf(result.document)[0];
  assert.deepEqual(lesson.resources.map((resource) => [resource.name, resource.strings]), [
    ['apostila-exemplo-4-cordas.pdf', 4],
    ['faixa-exemplo-4-e-6-cordas.mp3', null],
    ['faixa-exemplo-4-cordas.mp3', null],
  ]);
  assert.deepEqual(lesson.suggestedExercises.map((exercise) => [exercise.title, exercise.strings, exercise.trackNames]), [
    ['Exercício 4 e 6 cordas', null, ['apostila-exemplo-4-cordas.pdf']],
  ]);
  assert.deepEqual(lesson.resourceRefs, [{ lessonId: 'modulo-1-aula-1', resourceId: 'apostila-exemplo-4-cordas-pdf' }]);
  assert.deepEqual(result.warnings.filter((warning) => warning.code === 'cordas-6').map((warning) => warning.path), ['modulos[0].aulas[0].anexos[2]']);
  assert.equal(result.warnings.some((warning) => warning.code === 'cordas-ignoradas'), false);
  assert.equal(result.warnings.some((warning) => warning.code === 'vinculo-ausente'), false);
});

test('compassos por acorde aceita de 1 a 4 e texto numérico', () => {
  assert.deepEqual({ ...BARS_PER_CHORD_RANGE }, { min: 1, max: 4 });
  const result = convertCourseMap(readFixture('map-repairs.json'));
  const valores = resourcesOf(result.document).map((resource) => resource.barsPerChord);
  assert.deepEqual(valores, [null, 3, 4, 3]);
  assert.equal(result.warnings.some((warning) => warning.code === 'compassos-ilegiveis'), false);

  const text = convertCourseMap({
    curso: { titulo: 'Curso de Exemplo' },
    modulos: [{ titulo: 'Módulo 1', aulas: [{
      titulo: 'Aula 1',
      anexos: [
        { nome: 'faixa-exemplo-a.mp3', compassos_por_acorde: '2' },
        { nome: 'faixa-exemplo-b.mp3', 'compassos_por_acorde': '≈4 (explicação fictícia)' },
        { nome: 'faixa-exemplo-c.mp3', compassos_por_acorde: 5 },
      ],
    }] }],
  });
  assert.deepEqual(resourcesOf(text.document).map((resource) => resource.barsPerChord), [2, 4, null]);
  assert.ok(text.warnings.some((warning) => warning.code === 'compassos-ilegiveis' && warning.path === 'modulos[0].aulas[0].anexos[2].compassos_por_acorde'));
});

test('textos longos de hospedagem, afinação e instrumento não são cortados', () => {
  const map = readFixture('map-repairs.json');
  const hospedagem = map.modulos[0].aulas[0].video.hospedagem;
  assert.ok(hospedagem.length > COURSE_LIMITS.label, 'a hospedagem do fixture passa do rótulo curto');
  const afinacao = map.modulos[0].aulas[1].afinacao;
  assert.ok(afinacao.length > COURSE_LIMITS.shortText, 'a afinação do fixture passa do texto curto');
  const instrumento = map.curso.instrumento.nome;
  assert.ok(instrumento.length > COURSE_LIMITS.label, 'o instrumento do fixture passa do rótulo curto');

  const result = convertCourseMap(map);
  const lessons = lessonsOf(result.document);
  assert.equal(lessons[0].videoSeconds, 600);
  assert.equal(lessons[0].hasVideo, true);
  assert.equal(lessons[0].tuning, 'E A D G', 'afinação curta fica como veio');
  assert.equal(lessons[1].tuning, 'B E A D G', 'afinação longa vira as notas citadas');
  assert.equal(lessons[1].hasVideo, true);
  assert.equal(result.document.course.instrument, 'bass');
  assert.equal(result.document.course.strings, 4);
  const cortes = result.warnings.filter((warning) => warning.code === 'texto-truncado');
  assert.deepEqual(cortes.map((warning) => warning.path), []);
  assert.equal(result.warnings.some((warning) => warning.code === 'instrumento-diferente'), false);

  assert.equal(classifyVideoHosting('Vídeo publicado na plataforma externa do curso'), 'externo');
  assert.equal(classifyVideoHosting('youtube'), 'youtube');
  assert.equal(classifyVideoHosting('Vimeo privado'), 'vimeo');
  assert.equal(classifyVideoHosting('arquivo local em disco'), 'arquivo');
  assert.equal(classifyVideoHosting(null), null);
  assert.equal(classifyVideoHosting(''), null);

  const longText = `${'observação fictícia muito longa '.repeat(12)}`;
  const warnings = [];
  assert.equal(readTuning(longText, 'p', warnings), longText.length > COURSE_LIMITS.shortText ? longText.slice(0, COURSE_LIMITS.shortText) : longText);
  assert.equal(warnings[0].code, 'texto-truncado');
  assert.equal(readTuning('   E   A   D   G   ', 'p', []), 'E A D G');
  assert.equal(readTuning(null, 'p', []), null);
});

test('textos numéricos inequívocos valem e ambíguos ficam nulos', () => {
  assert.equal(parseUnambiguousInteger('≈25 (12 acordes × 2 + acorde final)', { min: 1, max: 64 }), 25);
  assert.equal(parseUnambiguousInteger('13', { min: 1, max: 64 }), 13);
  assert.equal(parseUnambiguousInteger('80 BPM', { min: 30, max: 300 }), 80);
  assert.equal(parseUnambiguousInteger(100, { min: 30, max: 300 }), 100);
  assert.equal(parseUnambiguousInteger('90 compassos', { min: 1, max: COURSE_LIMITS.barsMax }), 90);
  assert.equal(parseUnambiguousInteger('80 ou 90 BPM', { min: 30, max: 300 }), null);
  assert.equal(parseUnambiguousInteger('90-100 BPM', { min: 30, max: 300 }), null);
  assert.equal(parseUnambiguousInteger('500 BPM', { min: 30, max: 300 }), null);
  assert.equal(parseUnambiguousInteger('8.5', { min: 1, max: 64 }), null);
  assert.equal(parseUnambiguousInteger(90.5, { min: 30, max: 300 }), null);
  assert.equal(parseUnambiguousInteger('tempo desconhecido'), null);
  assert.equal(parseUnambiguousInteger(null), null);

  const result = convertCourseMap(readFixture('map-example.json'));
  const exercises = lessonsOf(result.document)[1].suggestedExercises;
  assert.equal(exercises[0].bars, 25);
  assert.equal(exercises[1].bars, 13);
  assert.equal(exercises[1].initialBpm, null);
});

test('duração de vídeo em hh:mm:ss ou mm:ss', () => {
  assert.equal(parseVideoDuration('06:00'), 360);
  assert.equal(parseVideoDuration('02:00'), 120);
  assert.equal(parseVideoDuration('0:45'), 45);
  assert.equal(parseVideoDuration('1:02:03'), 3723);
  assert.equal(parseVideoDuration(120), 120);
  assert.equal(parseVideoDuration('90'), null);
  assert.equal(parseVideoDuration('tempo desconhecido'), null);
  assert.equal(parseVideoDuration(null), null);

  const result = convertCourseMap(readFixture('map-example.json'));
  const lessons = lessonsOf(result.document);
  assert.equal(lessons[1].videoSeconds, 360);
  assert.equal(lessons[1].hasVideo, true);
  assert.equal(lessons[3].videoSeconds, 120);
  assert.equal(lessons[4].videoSeconds, null);
  assert.equal(lessons[4].hasVideo, true);
  assert.ok(result.warnings.some((warning) => warning.code === 'duracao-ilegivel'));
});

test('seções e materiais são classificados por título e nome', () => {
  assert.equal(classifySectionTitle('Seminário de Exemplo'), 'seminário');
  assert.equal(classifySectionTitle('Boas-vindas de Exemplo'), 'boas-vindas');
  assert.equal(classifySectionTitle('Módulo 1'), 'módulo');
  assert.equal(classifySectionTitle('   Encontros   extras   '), 'módulo');
  assert.equal(classifySectionTitle(''), 'outro');
  assert.equal(classifySectionTitle(null), 'outro');

  assert.equal(classifyResourceRole('pacote de exercícios'), 'pacote de exercícios');
  assert.equal(classifyResourceRole('apostila'), 'apostila');
  assert.equal(classifyResourceRole('figurinha'), 'outro');
  assert.equal(classifyResourceRole(null), 'outro');

  assert.equal(mentionsSixStrings('faixa-exemplo-6-cordas.mp3'), true);
  assert.equal(mentionsSixStrings('material de seis cordas'), true);
  assert.equal(mentionsSixStrings('faixa-exemplo-4-cordas-80bpm.mp3'), false);
  assert.equal(mentionsSixStrings(null), false);

  assert.equal(slugifyId('Exercício de Exemplo A'), 'exercicio-de-exemplo-a');
  assert.equal(slugifyId('', 'aula-1'), 'aula-1');
});

test('mapa vazio, nulo ou sem curso não derruba o conversor', () => {
  const empty = convertCourseMap({});
  assert.equal(empty.valid, true);
  assert.deepEqual(empty.counts, ZERO_COUNTS);
  assert.equal(empty.document.course.title, 'Curso sem título');
  assert.deepEqual(empty.document.course.sections, []);
  assert.ok(empty.warnings.some((warning) => warning.code === 'curso-ausente'));

  const nil = convertCourseMap(null);
  assert.equal(nil.valid, true);
  assert.deepEqual(nil.counts, ZERO_COUNTS);
  assert.ok(nil.warnings.some((warning) => warning.code === 'raiz'));

  const text = convertCourseMap('mapa de exemplo');
  assert.equal(text.valid, true);
  assert.deepEqual(text.counts, ZERO_COUNTS);
  assert.equal(normalizeCourse(text.document).ok, true);
});

test('o mapa irregular converte igual e determinístico', () => {
  const first = convertCourseMap(readFixture('map-example-irregular.json'));
  const second = convertCourseMap(readFixture('map-example-irregular.json'));
  assert.equal(first.valid, true);
  assert.deepEqual(first.problems, []);
  assert.deepEqual(first.counts, { sections: 2, lessons: 2, resources: 4, resourceRefs: 2, exercises: 5, discarded: 6, merged: 0, catalog: null });
  assert.deepEqual(first.document, readFixture('course-irregular-normalized.json'));
  assert.equal(JSON.stringify(first.document), JSON.stringify(second.document));
  const lessons = lessonsOf(first.document);
  assert.deepEqual(lessons.map((lesson) => lesson.id), ['modulo-repetido-aula-1', 'modulo-repetido-aula-1-2']);
  assert.ok(first.warnings.some((warning) => warning.code === 'id-ajustado'));
  assert.ok(first.warnings.some((warning) => warning.code === 'total-aulas-divergente'));
  assert.equal(lessons[1].suggestedExercises[1].bars, 90, 'compassos acima do teto antigo de 64 são lidos');
});

test('curso que declara 6 cordas é incompatível: falha estrita e não é reclassificado', () => {
  const result = convertCourseMap(readFixture('map-six-strings.json'));
  assert.equal(result.valid, false);
  assert.deepEqual(result.problems.map((problem) => [problem.path, problem.code]), [['course.strings', 'cordas']]);
  assert.equal(result.document.course.strings, 6);
  assert.deepEqual(result.counts, { sections: 1, lessons: 1, resources: 0, resourceRefs: 0, exercises: 0, discarded: 0, merged: 0, catalog: null });
  const warning = result.warnings.find((item) => item.path === 'curso.cordas' && item.code === 'cordas-6');
  assert.ok(warning, 'o aviso explica que o curso é incompatível');
  assert.equal(warning.message.includes('convertido para 4'), false);
  assert.equal(normalizeCourse(result.document).ok, false);
});

test('material e exercício de 6 cordas continuam descartados em curso de 4 ou 5', () => {
  const result = convertCourseMap(readFixture('map-example-irregular.json'));
  assert.equal(result.valid, true);
  assert.equal(result.document.course.strings, 5);
  const sixStrings = result.warnings.filter((warning) => warning.code === 'cordas-6');
  assert.deepEqual(sixStrings.map((warning) => warning.path), [
    'modulos[2].aulas[0].anexos[2]',
    'modulos[2].aulas[0].backing_tracks[1]',
    'modulos[2].aulas[1].exercicios[4]',
  ]);
});

test('vínculos usam material da mesma aula, de outra aula e do pacote', () => {
  const result = convertCourseMap(readFixture('map-example-irregular.json'));
  const lessons = lessonsOf(result.document);
  assert.deepEqual(lessons[1].resourceRefs, [
    { lessonId: 'modulo-repetido-aula-1', resourceId: 'faixa-irregular-4-cordas-80bpm-mp3' },
    { lessonId: 'modulo-repetido-aula-1', resourceId: 'pacote-irregular-zip' },
  ]);
  assert.ok(result.warnings.some((warning) => warning.code === 'vinculo-ausente' && warning.path === 'modulos[2].aulas[1].exercicios[3]'));
  assert.equal(normalizeCourse(result.document).ok, true);
});

test('listas embrulhadas em { valor, inferido } não perdem itens', () => {
  const result = convertCourseMap({
    curso: { titulo: 'Curso de Exemplo' },
    modulos: { valor: [{
      titulo: 'Módulo 1',
      aulas: { valor: [{
        titulo: 'Aula 1',
        anexos: { valor: [{ nome: 'apostila-exemplo.pdf', extensao: 'pdf', papel: 'apostila' }], inferido: false },
        backing_tracks: { valor: [{ nome: 'faixa-exemplo-4-cordas-80bpm.mp3', cordas: 4 }], inferido: true },
        exercicios: { valor: [{
          nome: 'Exercício de Exemplo A',
          compassos_aproximados: { valor: '25', inferido: true },
          andamento_inicial: { valor: '80 BPM', inferido: true },
          arquivo_correspondente: 'faixa-exemplo-4-cordas-80bpm.mp3',
        }], inferido: false },
      }], inferido: false },
    }], inferido: false },
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.counts, { sections: 1, lessons: 1, resources: 2, resourceRefs: 1, exercises: 1, discarded: 0, merged: 0, catalog: null });
  const lesson = lessonsOf(result.document)[0];
  assert.equal(lesson.id, 'modulo-1-aula-1');
  assert.deepEqual(lesson.resources.map((resource) => resource.id), ['apostila-exemplo-pdf', 'faixa-exemplo-4-cordas-80bpm-mp3']);
  assert.deepEqual(lesson.resourceRefs, [{ lessonId: 'modulo-1-aula-1', resourceId: 'faixa-exemplo-4-cordas-80bpm-mp3' }]);
  assert.deepEqual(lesson.suggestedExercises.map((exercise) => [exercise.bars, exercise.initialBpm]), [[25, 80]]);
  const ilegiveis = result.warnings.filter((warning) => ['lista-ilegivel', 'aulas-ilegiveis', 'modulos-ilegiveis'].includes(warning.code));
  assert.deepEqual(ilegiveis, []);
});

test('ordem aceita embrulho e texto numérico em seções e aulas', () => {
  const result = convertCourseMap({
    curso: { titulo: 'Curso de Exemplo' },
    modulos: [
      { titulo: 'Módulo B', ordem: '2', aulas: [{ titulo: 'Aula B', ordem_global: '2' }, { titulo: 'Aula A', ordem_global: { valor: 1, inferido: true } }] },
      { titulo: 'Módulo A', ordem: { valor: 1, inferido: true }, aulas: [] },
    ],
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.document.course.sections.map((section) => section.title), ['Módulo A', 'Módulo B']);
  assert.deepEqual(lessonsOf(result.document).map((lesson) => lesson.title), ['Aula A', 'Aula B']);
  assert.equal(result.warnings.some((warning) => warning.code === 'campo-ignorado'), false);
});

test('ordem_global do módulo é reconhecida e não vira campo ignorado', () => {
  const result = convertCourseMap({
    curso: { titulo: 'Curso de Exemplo' },
    modulos: [{ titulo: 'Módulo 1', ordem_global: 1, aulas: [] }],
  });
  assert.equal(result.document.course.sections.length, 1);
  assert.equal(result.warnings.some((warning) => warning.code === 'campo-ignorado'), false);
});

test('módulos são convertidos mesmo sem o curso', () => {
  const result = convertCourseMap({ modulos: [{ titulo: 'Módulo 1', aulas: [{ titulo: 'Aula 1' }] }] });
  assert.equal(result.valid, true);
  assert.deepEqual(result.counts, { sections: 1, lessons: 1, resources: 0, resourceRefs: 0, exercises: 0, discarded: 0, merged: 0, catalog: null });
  assert.deepEqual(result.document.course.sections.map((section) => section.title), ['Módulo 1']);
  assert.equal(result.document.course.title, 'Curso sem título');
  assert.ok(result.warnings.some((warning) => warning.code === 'curso-ausente'));
  assert.equal(result.warnings.some((warning) => warning.code === 'modulos-ausentes'), false);
});

test('embrulhos em containers e aninhados preservam conteúdo', () => {
  const result = convertCourseMap({ valor: {
    curso: { valor: { titulo: 'Curso de Exemplo', instrumento: { valor: { nome: 'baixo', cordas: 5 }, inferido: true } }, inferido: false },
    modulos: [{ titulo: 'Módulo 1', aulas: [{ valor: {
      titulo: 'Aula 1',
      video: { valor: { hospedagem: 'site externo', duracao_segundos: 120 }, inferido: true },
      andamentos: { valor: { inicial: '80 BPM', alvo: 100 }, inferido: true },
      meu_progresso: { valor: { assistida: true }, inferido: true },
      anexos: [{ valor: { nome: 'apostila-exemplo.pdf', extensao: 'pdf', papel: 'apostila' }, inferido: true }],
      exercicios: [{ valor: { nome: 'Exercício de Exemplo B', compassos_aproximados: '8' }, inferido: true }],
    }, inferido: true }] }],
  }, inferido: true }, { includeProgress: true });
  assert.equal(result.valid, true);
  assert.equal(result.document.course.title, 'Curso de Exemplo');
  assert.equal(result.document.course.strings, 5);
  const lesson = lessonsOf(result.document)[0];
  assert.equal(lesson.videoSeconds, 120);
  assert.equal(lesson.hasVideo, true);
  assert.equal(lesson.initialBpm, 80);
  assert.equal(lesson.targetBpm, 100);
  assert.deepEqual(result.counts, { sections: 1, lessons: 1, resources: 1, resourceRefs: 0, exercises: 1, discarded: 0, merged: 0, catalog: null });
  assert.deepEqual(result.document.progress.watchedLessonIds, [lesson.id]);
  assert.equal(result.warnings.some((warning) => warning.code === 'campo-ignorado'), false);
});

test('lista com tipo errado avisa e o resto do mapa continua', () => {
  const aulas = convertCourseMap({ curso: { titulo: 'Curso de Exemplo' }, modulos: [{ titulo: 'Módulo 1', aulas: 'nenhuma' }] });
  assert.equal(aulas.valid, true);
  assert.ok(aulas.warnings.some((warning) => warning.code === 'aulas-ilegiveis' && warning.path === 'modulos[0].aulas'));
  assert.equal(aulas.counts.sections, 1);
  assert.equal(aulas.counts.lessons, 0);

  const modulos = convertCourseMap({ curso: { titulo: 'Curso de Exemplo' }, modulos: 'nenhum' });
  assert.equal(modulos.valid, true);
  assert.ok(modulos.warnings.some((warning) => warning.code === 'modulos-ilegiveis' && warning.path === 'modulos'));
  assert.deepEqual(modulos.counts, ZERO_COUNTS);

  const anexos = convertCourseMap({
    curso: { titulo: 'Curso de Exemplo' },
    modulos: [{ titulo: 'Módulo 1', aulas: [{ titulo: 'Aula 1', anexos: { nada: 1 } }] }],
  });
  assert.equal(anexos.valid, true);
  assert.ok(anexos.warnings.some((warning) => warning.code === 'lista-ilegivel' && warning.path === 'modulos[0].aulas[0].anexos'));
  assert.equal(anexos.counts.lessons, 1);
  assert.equal(anexos.counts.resources, 0);
});

test('campo extra fora do embrulho ainda é avisado', () => {
  const result = convertCourseMap({ curso: { valor: { titulo: 'Curso de Exemplo', instrumento: { nome: 'baixo', cordas: 4 } }, extra: 1 } });
  assert.ok(result.warnings.some((warning) => warning.code === 'campo-ignorado' && warning.path === 'curso.extra'));
  assert.deepEqual(result.grouped.filter((group) => group.code === 'campo-ignorado').map((group) => [group.path, group.count]), [['curso.extra', 1]]);
  assert.deepEqual(result.grouped.map((group) => group.path), ['curso.extra', 'modulos']);
  assert.equal(result.document.course.title, 'Curso de Exemplo');
  assert.equal(result.document.course.strings, 4);
});

test('embrulho em papel, extensão e total de aulas alimenta as regras', () => {
  const result = convertCourseMap({
    curso: { titulo: 'Curso de Exemplo', total_aulas: { valor: 9, inferido: true } },
    modulos: [{ titulo: 'Módulo 1', aulas: [{ titulo: 'Aula 1', anexos: [{ nome: 'material-exemplo', extensao: { valor: 'pdf', inferido: true }, papel: { valor: 'apostila', inferido: true } }] }] }],
  });
  const resource = lessonsOf(result.document)[0].resources[0];
  assert.equal(resource.extension, 'pdf');
  assert.equal(resource.role, 'apostila');
  assert.ok(result.warnings.some((warning) => warning.code === 'total-aulas-divergente' && warning.path === 'curso.total_aulas'));
});

test('a linha de comando grava no caminho indicado, agrupa avisos e aceita --verbose', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'groovegoblin-curso-'));
  const script = fileURLToPath(new URL('../scripts/convert-course-map.js', import.meta.url));
  try {
    const output = join(directory, 'curso-convertido.json');
    const cli = spawnSync(process.execPath, [script, fixturePath('map-example.json'), '--output', output], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Seções 3 · aulas 5/);
    assert.match(cli.stdout, /Avisos agrupados \(/);
    assert.doesNotMatch(cli.stdout, /^Avisos \(\d+\):$/m);
    const written = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(written.format, COURSE_FORMAT);
    assert.equal(written.version, COURSE_VERSION);
    assert.equal(Object.hasOwn(written, 'progress'), false);
    assert.equal(normalizeCourse(written).ok, true);

    const repairs = join(directory, 'curso-reparos.json');
    const verbose = spawnSync(process.execPath, [script, fixturePath('map-repairs.json'), '--output', repairs, '--com-progresso', '--verbose'], { encoding: 'utf8' });
    assert.equal(verbose.status, 0, verbose.stderr);
    assert.match(verbose.stdout, /Avisos \(7\):/);
    assert.match(verbose.stdout, /campo-ignorado/);
    assert.match(verbose.stdout, /2 mesclado\(s\)/);
    assert.match(verbose.stdout, /Progresso do mapa incluído: 2 aulas assistidas/);

    const incompatible = join(directory, 'incompativel.json');
    const six = spawnSync(process.execPath, [script, fixturePath('map-six-strings.json'), '--output', incompatible], { encoding: 'utf8' });
    assert.equal(six.status, 1, six.stdout);
    assert.match(six.stderr, /nenhum arquivo foi gravado/);
    assert.match(six.stderr, /course\.strings/);
    assert.match(six.stderr, /6 cordas/);
    await assert.rejects(readFile(incompatible, 'utf8'));

    const missing = spawnSync(process.execPath, [script, join(directory, 'ausente.json'), '--output', output], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /arquivo não encontrado/);
    assert.equal(missing.stderr.includes('ENOENT'), false);
    assert.equal(missing.stderr.includes('at Object'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('o caminho de saída padrão fica em local/', () => {
  assert.equal(DEFAULT_OUTPUT, 'local/curso-convertido.json');
});

// --------------------------------------- catálogo de exercícios (etapa 5)

test('catálogo: liga por aula, substitui as sugestões e traz a receita de cada exercício', () => {
  const catalog = readFixture('catalog-example.json');
  const result = convertCourseMap(readFixture('map-repairs.json'), { includeProgress: true, catalog });
  assert.equal(result.valid, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.counts.catalog, {
    // `replaced` conta as sugestões do MAPA que o catálogo substitui (a aula 0
    // do mapa fictício sugere 2 exercícios depois do descarte de 6 cordas).
    entries: 6, bound: 5, replaced: 2, variations: 1, unknownLesson: 1, withoutRecipe: 1, refs: 2, ignoredFields: 3,
  });
  assert.deepEqual(result.document.course.catalog.entries, 5);
  assert.match(result.document.course.catalog.id, /^cat-[0-9a-f]{16}$/);
  const lessons = new Map(lessonsOf(result.document).map((lesson) => [lesson.id, lesson]));

  // Aula 0: a sugestão do mapa foi substituída pelos exercícios do catálogo.
  const aulaZero = lessons.get('0');
  assert.deepEqual(aulaZero.suggestedExercises.map((exercise) => exercise.id), ['cat-exemplo-1', 'cat-exemplo-1-cinco', 'cat-exemplo-5']);
  const base = aulaZero.suggestedExercises[0];
  assert.equal(base.title, 'Exercício fictício de arpejo');
  assert.equal(base.pdfPage, 12);
  assert.equal(base.initialBpm, 110);
  assert.equal(base.bars, 25);
  assert.equal(base.practiceMode, 'com metrônomo');
  assert.deepEqual(base.trackNames, ['faixa-reparos-4-cordas-80bpm.mp3']);
  assert.equal(base.catalogId, 'cat-exemplo-1');
  assert.equal(base.recipe.family, 'arpejo_triade_forma_unica');
  // O ciclo escrito nas cifras é a progressão que o motor toca (a receita é a
  // do motor, não uma segunda tradução do catálogo).
  assert.equal(base.recipe.progression.kind, 'lista');
  assert.equal(base.recipe.progression.start, 'C');
  assert.deepEqual(base.recipe.progression.chords, ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'B', 'E', 'A', 'D', 'G']);
  assert.deepEqual(base.recipe.figure.degrees, [1, 3, 5]);
  assert.equal(base.recipe.figure.bars, 2);
  assert.equal(base.recipe.final, 'tonica');
  assert.deepEqual(base.recipe.shapeLabel, { label: 'Shape 1', quality: 'major', inversion: 'fundamental' });
  // A faixa indicada virou vínculo com o material da própria aula.
  assert.ok(aulaZero.resourceRefs.some((ref) => ref.lessonId === '0' && ref.resourceId === 'faixa-reparos-4-cordas-80bpm-mp3'));

  // A variação de 5 cordas aponta para o exercício de 4 cordas da mesma aula.
  const variant = aulaZero.suggestedExercises[1];
  assert.equal(variant.variantOf, 'cat-exemplo-1');
  assert.equal(variant.strings, 5);
  assert.equal(variant.recipe.voltas, 'periodo');
  assert.equal(variant.recipe.rhythm, 'quarters');
  assert.deepEqual(variant.recipe.profile, { type: 'bass', strings: 5 });

  // O exercício do catálogo sem `qualidade` (campo OPCIONAL) não perde a
  // receita: a base é maior e o resumo mostra isso.
  const semQualidade = aulaZero.suggestedExercises[2];
  assert.equal(semQualidade.id, 'cat-exemplo-5');
  assert.equal(semQualidade.recipe.progression.quality, 'major');

  // Aula 25: recebe o exercício do percurso (o exercício sem família gerável
  // vai para a aula 26, que é a dele).
  const aulaVinteCinco = lessons.get('25');
  assert.deepEqual(aulaVinteCinco.suggestedExercises.map((exercise) => exercise.id), ['cat-exemplo-2']);
  assert.equal(aulaVinteCinco.suggestedExercises[0].recipe.family, 'movimento_continuo_grave_agudo_grave');
  assert.equal(aulaVinteCinco.suggestedExercises[0].recipe.progression.kind, 'lista');
  assert.deepEqual(aulaVinteCinco.suggestedExercises[0].recipe.progression.chords, ['C', 'Am', 'Dm', 'G']);
  assert.equal(aulaVinteCinco.suggestedExercises[0].recipe.rhythm, 'quarters');
  assert.equal(aulaVinteCinco.suggestedExercises[0].initialBpm, null, 'dois andamentos no texto não viram um número');
  assert.ok(aulaVinteCinco.resourceRefs.some((ref) => ref.lessonId === '0' && ref.resourceId === 'faixa-compartilhada-reparos-mp3'));

  // Aula 26: só o exercício sem família gerável (entra sem receita, com os
  // dados do catálogo) — o mapa não tinha exercício nenhum nesta aula.
  const aulaVinteSeis = lessons.get('26');
  assert.deepEqual(aulaVinteSeis.suggestedExercises.map((exercise) => exercise.id), ['cat-exemplo-3']);
  assert.equal(aulaVinteSeis.suggestedExercises[0].recipe, null);
  assert.equal(aulaVinteSeis.suggestedExercises[0].catalogId, 'cat-exemplo-3');

  // O resultado continua um documento válido do formato (v2, com o marcador).
  const normalized = normalizeCourse(result.document);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.document.version, COURSE_VERSION);
  assert.equal(normalized.document.privacy, 'private');
});

test('catálogo: avisos são agrupados por código e caminho genérico, sem título nem cifra', () => {
  const result = convertCourseMap(readFixture('map-repairs.json'), { catalog: readFixture('catalog-example.json') });
  const codes = result.grouped.map((group) => [group.path, group.code, group.count]);
  assert.ok(codes.some(([path, code]) => code === 'catalogo-aula-ausente' && path === 'catalogo[].aula_id'));
  assert.ok(codes.some(([path, code, count]) => code === 'catalogo-sem-receita' && path === 'catalogo[].familia' && count === 1));
  assert.ok(codes.some(([path, code, count]) => code === 'catalogo-campo-ignorado' && path === 'catalogo[].campo_estranho' && count === 1));
  assert.ok(codes.some(([path, code, count]) => code === 'catalogo-campo-ignorado' && path === 'catalogo[].forma.extra' && count === 1));
  const text = JSON.stringify(result.warnings);
  assert.equal(text.includes('Exercício fictício'), false, 'aviso nunca repete o texto do catálogo');
  assert.equal(text.includes('Am'), false, 'aviso nunca repete cifra do catálogo');
});

test('a linha de comando converte com --catalogo e informa o que ligou', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'groovegoblin-catalogo-'));
  const script = fileURLToPath(new URL('../scripts/convert-course-map.js', import.meta.url));
  try {
    const output = join(directory, 'curso-com-catalogo.json');
    const cli = spawnSync(process.execPath, [
      script, fixturePath('map-repairs.json'), '--output', output, '--catalogo', fixturePath('catalog-example.json'),
    ], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Catálogo lido: 6 exercício\(s\)/);
    assert.match(cli.stdout, /Catálogo: 5 exercício\(s\) ligado\(s\) à aula \(1 variação\(ões\) de 5 cordas\)/);
    const written = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(written.version, COURSE_VERSION);
    assert.equal(written.privacy, 'private');
    assert.equal(normalizeCourse(written).ok, true);
    assert.equal(written.course.catalog.entries, 5);
    const first = written.course.sections[0].lessons.find((lesson) => lesson.id === '0');
    assert.equal(first.suggestedExercises[0].recipe.family, 'arpejo_triade_forma_unica');
    // Sem --catalogo, o curso volta a ser o do mapa (nada de receita).
    const plain = join(directory, 'curso-sem-catalogo.json');
    const without = spawnSync(process.execPath, [script, fixturePath('map-repairs.json'), '--output', plain], { encoding: 'utf8' });
    assert.equal(without.status, 0, without.stderr);
    assert.equal(JSON.parse(await readFile(plain, 'utf8')).course.catalog, null);

    const missing = spawnSync(process.execPath, [script, fixturePath('map-repairs.json'), '--catalogo', join(directory, 'ausente.json')], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /arquivo não encontrado/);
    const notList = join(directory, 'catalogo-objeto.json');
    await writeFile(notList, JSON.stringify({ exercicios: [] }), 'utf8');
    const wrong = spawnSync(process.execPath, [script, fixturePath('map-repairs.json'), '--catalogo', notList], { encoding: 'utf8' });
    assert.equal(wrong.status, 2);
    assert.match(wrong.stderr, /lista de exercícios/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
