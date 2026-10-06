// Primitivas de arquivo duráveis do servidor. Tudo que grava passa por aqui:
// arquivo temporário exclusivo na MESMA partição, fsync, rename atômico e fsync
// da pasta. Leitura e escrita abrem com O_NOFOLLOW, então um symlink plantado
// dentro do data dir nunca é seguido.

import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY, O_DIRECTORY } = constants;

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export class StorageError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export async function fsyncDir(path) {
  const handle = await open(path, O_RDONLY | O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Garante uma pasta real (nunca symlink) e devolve true quando acabou de criá-la.
export async function ensureRealDir(path) {
  let created = false;
  try {
    await mkdir(path, { mode: DIR_MODE });
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new StorageError('unsafe_layout', 'Uma pasta interna do data dir é symlink ou não é pasta; o servidor não usa esse data dir.');
  }
  return created;
}

export function tempName(prefix = 'tmp') {
  return `${prefix}-${process.pid}-${randomBytes(8).toString('hex')}`;
}

export async function openExclusive(path) {
  return open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE);
}

export async function openRead(path) {
  return open(path, O_RDONLY | O_NOFOLLOW);
}

export async function readNoFollow(path) {
  const handle = await openRead(path);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new StorageError('unsafe_layout', 'Entrada do data dir não é arquivo comum.');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

// Grava `data` em `target` de forma atômica e durável. O temporário fica em
// `tmpDir` (mesmo sistema de arquivos) e some se algo falhar no caminho.
export async function writeDurable(target, data, tmpDir) {
  const temporary = join(tmpDir, tempName('write'));
  const handle = await openExclusive(temporary);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await fsyncDir(join(target, '..'));
}

// Move um arquivo já sincronizado para o destino final e torna o rename durável.
export async function commitRename(temporary, target) {
  await rename(temporary, target);
  await fsyncDir(join(target, '..'));
}

export async function removeQuiet(path) {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function emptyDir(path) {
  for (const entry of await readdir(path)) await rm(join(path, entry), { recursive: true, force: true });
}

export async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
