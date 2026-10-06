#!/usr/bin/env node
// Restaura um backup do servidor num data dir (com o servidor PARADO: o lock
// do data dir recusa se houver um processo usando).
//
//   node server/restore.js --data-dir DIR (--latest | --backup ARQUIVO) [--yes]
//
// Sem --yes só valida e mostra contagens. Com --yes grava antes um snapshot
// pre-restore-<carimbo>.ndjson.gz (o arquivo completo, com blobs), reescreve
// tudo com revisões NOVAS (o seq só cresce, então clientes recebem a
// restauração pelo /api/changes), transforma em lápide o que não existia no
// backup, restaura mapa/catálogo privados e repõe os BYTES dos blobs que
// faltam. Nada que o backup não traga é apagado: blobs vivos que não estão no
// arquivo continuam onde estão, e o snapshot pre-restore guarda o estado
// anterior inteiro.
//
// O arquivo é lido e validado por inteiro (cabeçalho, ids, hashes dos corpos,
// tamanho e sha256 de cada blob, rodapé com as contagens) ANTES de qualquer
// mutação: um backup truncado ou adulterado é recusado sem tocar no data dir.
// A saída traz só contagens — nunca ids, títulos ou caminhos do conteúdo.

import { resolve as resolvePath, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StorageError, removeQuiet } from './fsutil.js';
import { openStore } from './store.js';
import { listBackups, readArchive, writePreRestoreBackupUnlocked } from './backup.js';

export async function restoreBackup({ dataDir, backupFile = null, latest = false, apply = false, guardRoots = [], now }) {
  const store = await openStore({ dataDir, guardRoots, now });
  let archive = null;
  try {
    let path = backupFile;
    if (latest) {
      const [newest] = await listBackups(store);
      if (!newest) throw Object.assign(new Error('Nenhum backup diário neste data dir.'), { code: 'backup_missing' });
      path = join(store.backupsDir, newest.name);
    }
    // Sem --yes não estagia bytes de blob: a validação continua completa.
    archive = await readArchive(path, { stageDir: apply ? store.tmpDir : null });
    const report = {
      applied: false,
      docs: archive.counts.docs,
      private: archive.counts.private,
      blobs: archive.counts.blobs,
      blobBytes: archive.counts.blobBytes,
      seq: archive.seq,
      sameDataset: archive.dataId === store.dataId,
    };
    if (!apply) return report;
    const { safety, result } = await store.exclusive(async () => {
      const safetyBackup = await writePreRestoreBackupUnlocked(store);
      return { safety: safetyBackup, result: await store.restoreUnlocked(archive, archive.blobs) };
    });
    archive = null; // os temporários de blob foram consumidos pelo rename
    return {
      ...report,
      applied: true,
      safetyBackup: safety.name,
      restored: result.restored,
      tombstoned: result.tombstoned,
      blobsInstalled: result.blobsInstalled,
      cursor: store.cursor(),
    };
  } finally {
    if (archive) for (const blob of archive.blobs) if (blob.path) await removeQuiet(blob.path).catch(() => {});
    await store.close();
  }
}

function parseArgs(argv) {
  const args = { dataDir: null, backup: null, latest: false, yes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--data-dir' || arg === '--backup') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} precisa de um caminho.` };
      if (arg === '--data-dir') args.dataDir = value;
      else args.backup = value;
      index += 1;
    } else if (arg === '--latest') args.latest = true;
    else if (arg === '--yes') args.yes = true;
    else return { error: `Opção desconhecida: ${arg}.` };
  }
  if (!args.dataDir || !isAbsolute(args.dataDir)) return { error: 'Informe --data-dir com caminho absoluto.' };
  if (Boolean(args.backup) === args.latest) return { error: 'Informe --latest OU --backup ARQUIVO.' };
  return { args };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(parsed.error);
    console.error('Uso: node server/restore.js --data-dir DIR (--latest | --backup ARQUIVO) [--yes]');
    return 2;
  }
  const { args } = parsed;
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  try {
    const report = await restoreBackup({
      dataDir: args.dataDir,
      backupFile: args.backup ? resolvePath(args.backup) : null,
      latest: args.latest,
      apply: args.yes,
      guardRoots: [projectRoot],
    });
    console.log(`Backup válido: ${report.docs} documentos · ${report.private} privados · ${report.blobs} blobs (${report.blobBytes} bytes) · mesmo dataset: ${report.sameDataset ? 'sim' : 'não'}.`);
    if (!report.applied) {
      console.log('Nada foi alterado. Repita com --yes para restaurar (um snapshot pre-restore é gravado antes).');
      return 0;
    }
    console.log(`Restaurado: ${report.restored} documentos · ${report.blobsInstalled} blobs repostos · ${report.tombstoned} apagados (lápides) · snapshot de segurança em backups/${report.safetyBackup}.`);
    return 0;
  } catch (error) {
    // Mensagens de E/S do Node citam caminhos absolutos: só as nossas saem inteiras.
    const known = error instanceof StorageError || error.code === 'backup_missing';
    const io = { ENOENT: 'arquivo não encontrado', EACCES: 'permissão negada', EPERM: 'permissão negada', EISDIR: 'o caminho é uma pasta', ENOSPC: 'sem espaço livre' };
    const message = known ? error.message : io[error.code] ?? 'falha de entrada e saída';
    console.error(`Restauração recusada: ${message.replace(/\.$/, '')}.`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
