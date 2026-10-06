// Leitor de ZIP nativo (rodada 6, etapa 8 / B4b) — consumidor.
//
// Exercita o módulo com ZIPs montados de verdade no teste: `store` e `deflate`,
// pasta, comentário no EOCD, e também os arquivos ruins que a pasta de entrada
// pode receber (travessia, link simbólico, cifra, ZIP64, multidisco, corte,
// bomba por tamanho declarado, por razão de compressão e por saída grande
// demais).
//
// Tudo fictício: nomes de material do curso de exemplo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCentralDirectory, readMember, readZipMembers, createZipBudget, isZipSignature, ZipError, ZIP_LIMITS } from '../server/zip.js';
import { buildZip, buildPdf, UNIX_DIRECTORY, UNIX_SYMLINK } from './server-zip-fixtures.js';

const LIMITS = { ...ZIP_LIMITS, maxMemberBytes: 4 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 };

function checkZipError(error, code) {
  assert.ok(error instanceof ZipError, `esperava ZipError, veio ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
  return true;
}

async function fails(promise, code) {
  await assert.rejects(promise, (error) => checkZipError(error, code));
}

function syncFails(run, code) {
  assert.throws(run, (error) => checkZipError(error, code));
}

test('zip: lê membros em store e deflate e ignora o que o filtro recusa', async () => {
  const pdf = buildPdf('apostila de exemplo');
  const zip = buildZip([
    { name: 'Apostila de Exemplo.pdf', data: pdf, method: 'store' },
    { name: 'Faixa de Exemplo.txt', data: 'nada de áudio aqui', method: 'deflate' },
    { name: 'Exercício de Exemplo.pdf', data: buildPdf('exercício'), method: 'deflate' },
    { name: 'Módulo/', data: '', mode: UNIX_DIRECTORY },
  ], { comment: 'pacote de exemplo' });
  assert.equal(isZipSignature(zip), true);
  assert.equal(isZipSignature(pdf), false);

  const result = await readZipMembers(zip, { limits: LIMITS, accept: (name) => name.endsWith('.pdf') });
  assert.equal(result.entries, 4);
  assert.equal(result.members.length, 2);
  assert.deepEqual(result.members.map((member) => member.name), ['Apostila de Exemplo.pdf', 'Exercício de Exemplo.pdf']);
  assert.deepEqual(result.members[0].data, pdf);
  assert.equal(result.members[1].invalid, false);
  assert.equal(result.bytes, pdf.length + result.members[1].data.length);
});

test('zip: membro que diz ser PDF mas não é fica marcado como inválido, sem dado', async () => {
  const zip = buildZip([{ name: 'Falso.pdf', data: 'texto puro', method: 'store' }]);
  const result = await readZipMembers(zip, { limits: LIMITS, accept: (name) => name.endsWith('.pdf') });
  assert.equal(result.members.length, 1);
  assert.equal(result.members[0].invalid, true);
  assert.equal(result.members[0].data, null);
  assert.equal(result.bytes, 'texto puro'.length, 'os bytes descompactados contam mesmo sem assinatura de PDF');
});

test('zip: nomes com travessia, absolutos, barra invertida, vazios e ponto são recusados', () => {
  for (const name of ['../fora.pdf', 'pasta/../../fora.pdf', '/etc/passwd.pdf', 'C:/segredo.pdf', 'a\\b.pdf', './']) {
    syncFails(() => readCentralDirectory(buildZip([{ name, data: 'x' }]), LIMITS), 'bad-name');
  }
  syncFails(() => readCentralDirectory(buildZip([{ name: '', data: 'x' }]), LIMITS), 'bad-name');
});

test('zip: link simbólico e membro criptografado são recusados', () => {
  const link = buildZip([{ name: 'Atalho.pdf', data: '/etc/passwd', mode: UNIX_SYMLINK }]);
  syncFails(() => readCentralDirectory(link, LIMITS), 'symlink');
  const encrypted = buildZip([{ name: 'Apostila.pdf', data: 'x', encrypted: true }]);
  syncFails(() => readCentralDirectory(encrypted, LIMITS), 'encrypted');
  const aes = buildZip([{ name: 'Apostila.pdf', data: 'x' }]);
  aes.writeUInt16LE(99, 8); // método do cabeçalho local
  const central = aes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  aes.writeUInt16LE(99, central + 10);
  syncFails(() => readCentralDirectory(aes, LIMITS), 'encrypted');
});

test('zip: ZIP64, multidisco, corte e arquivo que não é ZIP são recusados', () => {
  const pdf = buildPdf();
  syncFails(() => readCentralDirectory(buildZip([{ name: 'Apostila.pdf', data: pdf }], { entriesTotal: 0xffff }), LIMITS), 'zip64');
  syncFails(() => readCentralDirectory(buildZip([{ name: 'Apostila.pdf', data: pdf }], { cdDisk: 1 }), LIMITS), 'multidisk');
  syncFails(() => readCentralDirectory(buildZip([{ name: 'Apostila.pdf', data: pdf }]).subarray(0, buildZip([{ name: 'Apostila.pdf', data: pdf }]).length - 30), LIMITS), 'not-zip');
  syncFails(() => readCentralDirectory(Buffer.alloc(40), LIMITS), 'not-zip');
  syncFails(() => readCentralDirectory(Buffer.from('%PDF-1.4 nada'), LIMITS), 'truncated');

  const cortado = buildZip([{ name: 'Apostila.pdf', data: pdf }]);
  const eocd = cortado.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  cortado.writeUInt32LE(cortado.length - 1, eocd + 16);
  syncFails(() => readCentralDirectory(cortado, LIMITS), 'truncated');
});

test('zip: teto de membros e de nome do diretório central', () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({ name: `Apostila ${index}.pdf`, data: buildPdf() }));
  syncFails(() => readCentralDirectory(buildZip(entries), { ...LIMITS, maxEntries: 4 }), 'too-many-entries');
  syncFails(() => readCentralDirectory(buildZip([{ name: `${'a'.repeat(300)}.pdf`, data: 'x' }]), LIMITS), 'bad-name');
});

test('zip: membro maior que o teto, razão absurda e saída além do limite são recusados', async () => {
  const grande = buildZip([{ name: 'Grande.pdf', data: Buffer.alloc(3 * 1024 * 1024, 1), method: 'store' }]);
  await fails(readMember(grande, readCentralDirectory(grande, LIMITS)[0], { ...LIMITS, maxMemberBytes: 1024 * 1024 }), 'member-too-large');

  const zeros = Buffer.alloc(1024 * 1024, 0);
  const razao = buildZip([{ name: 'Compactado.pdf', data: zeros, method: 'deflate' }]);
  await fails(readMember(razao, readCentralDirectory(razao, LIMITS)[0], { ...LIMITS, maxRatio: 100 }), 'ratio');

  // Tamanho declarado mentiroso (pequeno) com conteúdo bem maior: o teto de
  // saída do zlib segura antes de alocar.
  const bomba = buildZip([{ name: 'Bomba.pdf', data: Buffer.alloc(2 * 1024 * 1024, 0), method: 'deflate', declaredUncompressed: 4096 }]);
  await fails(readMember(bomba, readCentralDirectory(bomba, LIMITS)[0], { ...LIMITS, maxMemberBytes: 1024 * 1024 }), 'bomb');
});

test('zip: tamanho declarado diferente do conteúdo e fluxo ilegível são recusados', async () => {
  const store = buildZip([{ name: 'Apostila.pdf', data: 'cinco', declaredUncompressed: 10 }]);
  await fails(readMember(store, readCentralDirectory(store, LIMITS)[0], LIMITS), 'size-mismatch');

  const deflate = buildZip([{ name: 'Apostila.pdf', data: buildPdf(), method: 'deflate', declaredUncompressed: 9999 }]);
  await fails(readMember(deflate, readCentralDirectory(deflate, LIMITS)[0], LIMITS), 'size-mismatch');

  const lixo = buildZip([{ name: 'Apostila.pdf', data: 'ignorado', method: 'deflate', packed: Buffer.from([9, 9, 9, 9, 9]), declaredUncompressed: 100 }]);
  await fails(readMember(lixo, readCentralDirectory(lixo, LIMITS)[0], LIMITS), 'corrupt');
});

test('zip: cabeçalho local inválido e membro cortado são recusados', async () => {
  const zip = buildZip([{ name: 'Apostila.pdf', data: buildPdf() }]);
  const entry = readCentralDirectory(zip, LIMITS)[0];
  await fails(readMember(zip, { ...entry, compressedSize: 10 ** 6 }, LIMITS), 'truncated');
  await fails(readMember(zip, { ...entry, localOffset: zip.length - 1 }, LIMITS), 'bad-local-header');
  await fails(readMember(zip, { ...entry, directory: true }, LIMITS), 'bad-name');
});

test('zip: orçamento é cumulativo entre chamadas e entre pacotes', async () => {
  const zip = buildZip([
    { name: 'Apostila 1.pdf', data: buildPdf('um') },
    { name: 'Apostila 2.pdf', data: buildPdf('dois') },
  ]);
  const budget = createZipBudget({ maxFiles: 1, maxBytes: 1024 * 1024 });
  await fails(readZipMembers(zip, { limits: LIMITS, budget, accept: (name) => name.endsWith('.pdf') }), 'budget');
  assert.equal(budget.files, 1);
  const outro = buildZip([{ name: 'Apostila 3.pdf', data: buildPdf('três') }]);
  await fails(readZipMembers(outro, { limits: LIMITS, budget, accept: (name) => name.endsWith('.pdf') }), 'budget');

  const bytes = createZipBudget({ maxFiles: 10, maxBytes: 4 });
  await fails(readZipMembers(outro, { limits: LIMITS, budget: bytes, accept: (name) => name.endsWith('.pdf') }), 'budget');
  assert.equal(bytes.bytes, 0);
});

test('zip: total descompactado do arquivo é limitado', async () => {
  const zip = buildZip([
    { name: 'Apostila 1.pdf', data: Buffer.alloc(400, 1), method: 'store' },
    { name: 'Apostila 2.pdf', data: Buffer.alloc(400, 2), method: 'store' },
  ]);
  await fails(readZipMembers(zip, { limits: { ...LIMITS, maxTotalBytes: 500 }, accept: (name) => name.endsWith('.pdf') }), 'total-too-large');
});

test('zip: o teto cumulativo cobre todo membro descompactado, inclusive os que não são PDF', async () => {
  // Dois ".pdf" com assinatura inválida: antes eles eram descompactados e
  // descartados sem entrar na conta, então N membros mentirosos cabiam todos.
  const zip = buildZip([
    { name: 'Falso 1.pdf', data: Buffer.alloc(300, 7), method: 'store' },
    { name: 'Falso 2.pdf', data: Buffer.alloc(300, 7), method: 'store' },
  ]);
  await fails(readZipMembers(zip, { limits: { ...LIMITS, maxTotalBytes: 400 }, accept: (name) => name.endsWith('.pdf') }), 'total-too-large');

  const budget = createZipBudget({ maxFiles: 10, maxBytes: 400 });
  await fails(readZipMembers(zip, { limits: LIMITS, budget, accept: (name) => name.endsWith('.pdf') }), 'budget');
  assert.equal(budget.files, 0, 'membro que não é PDF não gasta a cota de PDFs do curso');
  assert.equal(budget.bytes, 300, 'mas os bytes descompactados contam no orçamento');
});

test('zip: o orçamento que resta limita o tamanho antes de descompactar', async () => {
  const zip = buildZip([{ name: 'Apostila.pdf', data: Buffer.alloc(400, 1), method: 'store' }]);
  const budget = createZipBudget({ maxFiles: 10, maxBytes: 300 });
  // O membro declarado (400) não cabe nos 300 que restam: recusa ANTES de inflar.
  await fails(readZipMembers(zip, { limits: LIMITS, budget, accept: (name) => name.endsWith('.pdf') }), 'budget');
  assert.equal(budget.bytes, 0, 'nada foi descompactado');
  assert.equal(budget.files, 0);
});
