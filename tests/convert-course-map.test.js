import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COURSE_FORMAT, COURSE_VERSION, normalizeCourse } from '../src/course-format.js';
import {
  DEFAULT_OUTPUT,
  classifyResourceRole,
  classifySectionTitle,
  convertCourseMap,
  mentionsSixStrings,
  parseUnambiguousInteger,
  parseVideoDuration,
  slugifyId,
} from '../scripts/convert-course-map.js';

// Fixtures e medições vêm de um curso inventado (Curso de Exemplo, example.invalid).
function readFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/course/${name}`, import.meta.url), 'utf8'));
}

function fixturePath(name) {
  return fileURLToPath(new URL(`./fixtures/course/${name}`, import.meta.url));
}

const ZERO_COUNTS = { sections: 0, lessons: 0, resources: 0, resourceRefs: 0, exercises: 0, discarded: 0 };

function lessonsOf(document) {
  return document.course.sections.flatMap((section) => section.lessons);
}

function stringsOf(value, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, found);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) stringsOf(item, found);
  return found;
}

test('converte o mapa fictício completo com as contagens medidas', () => {
  const result = convertCourseMap(readFixture('map-example.json'));
  assert.equal(result.valid, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.counts, { sections: 3, lessons: 5, resources: 3, resourceRefs: 1, exercises: 2, discarded: 4 });
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

test('textos numéricos inequívocos valem e ambíguos ficam nulos', () => {
  assert.equal(parseUnambiguousInteger('≈25 (12 acordes × 2 + acorde final)', { min: 1, max: 64 }), 25);
  assert.equal(parseUnambiguousInteger('13', { min: 1, max: 64 }), 13);
  assert.equal(parseUnambiguousInteger('80 BPM', { min: 30, max: 300 }), 80);
  assert.equal(parseUnambiguousInteger(100, { min: 30, max: 300 }), 100);
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
  assert.deepEqual(first.counts, { sections: 2, lessons: 2, resources: 4, resourceRefs: 2, exercises: 5, discarded: 6 });
  assert.deepEqual(first.document, readFixture('course-irregular-normalized.json'));
  assert.equal(JSON.stringify(first.document), JSON.stringify(second.document));
  const lessons = lessonsOf(first.document);
  assert.deepEqual(lessons.map((lesson) => lesson.id), ['modulo-repetido-aula-1', 'modulo-repetido-aula-1-2']);
  assert.ok(first.warnings.some((warning) => warning.code === 'id-ajustado'));
  assert.ok(first.warnings.some((warning) => warning.code === 'total-aulas-divergente'));
});

test('curso que declara 6 cordas é incompatível: falha estrita e não é reclassificado', () => {
  const result = convertCourseMap(readFixture('map-six-strings.json'));
  assert.equal(result.valid, false);
  assert.deepEqual(result.problems.map((problem) => [problem.path, problem.code]), [['course.strings', 'cordas']]);
  assert.equal(result.document.course.strings, 6);
  assert.deepEqual(result.counts, { sections: 1, lessons: 1, resources: 0, resourceRefs: 0, exercises: 0, discarded: 0 });
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
  assert.deepEqual(result.counts, { sections: 1, lessons: 1, resources: 2, resourceRefs: 1, exercises: 1, discarded: 0 });
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
  assert.deepEqual(result.counts, { sections: 1, lessons: 1, resources: 0, resourceRefs: 0, exercises: 0, discarded: 0 });
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
  assert.deepEqual(result.counts, { sections: 1, lessons: 1, resources: 1, resourceRefs: 0, exercises: 1, discarded: 0 });
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

test('a linha de comando grava no caminho indicado e reporta totais', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'groovegoblin-curso-'));
  const script = fileURLToPath(new URL('../scripts/convert-course-map.js', import.meta.url));
  try {
    const output = join(directory, 'curso-convertido.json');
    const cli = spawnSync(process.execPath, [script, fixturePath('map-example.json'), '--output', output], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Seções 3 · aulas 5/);
    const written = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(written.format, COURSE_FORMAT);
    assert.equal(written.version, COURSE_VERSION);
    assert.equal(Object.hasOwn(written, 'progress'), false);
    assert.equal(normalizeCourse(written).ok, true);

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
