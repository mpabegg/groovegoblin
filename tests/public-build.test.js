import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const source = new URL('../', import.meta.url);

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'groove-public-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const name of ['build.js', 'asset-manifest.js', 'public-content.js']) {
    await cp(new URL(`scripts/${name}`, source), join(root, 'scripts', name));
  }
  await cp(new URL('assets/drums', source), join(root, 'assets/drums'), { recursive: true });
  for (const name of ['index.html', 'guide.html', 'README.md', 'manifest.webmanifest', 'icon.svg']) {
    await writeFile(join(root, name), 'Public fixture');
  }
  await writeFile(join(root, 'sw.js'), 'const version="__GROOVE_REVISION__";');
  await writeFile(join(root, 'src/app.js'), 'export const application = true;');
  return root;
}

async function build(root) {
  return run(process.execPath, ['scripts/build.js'], { cwd: root });
}

async function refusedBuild(root, privateName) {
  await assert.rejects(build(root), error => {
    assert.match(error.stderr, /Publicação recusada/);
    assert.equal(error.stderr.includes(privateName), false);
    return true;
  });
}

test('public build preserves exactly the licensed drum bytes and manifest integrity', async t => {
  const root = await project(t);
  await build(root);
  const manifest = JSON.parse(await readFile(join(root, 'dist/offline-assets.json'), 'utf8'));
  for (const name of ['kick.wav', 'snare.wav', 'hihat.wav']) {
    const file = `assets/drums/${name}`;
    assert.deepEqual(await readFile(join(root, 'dist', file)), await readFile(new URL(file, source)));
    assert.match(manifest.integrity[file], /^sha256-/);
  }
  assert.equal(manifest.files.some(file => file.startsWith('local/')), false);
});

for (const extension of ['pdf', 'mp3', 'wav']) {
  test(`public build rejects a private ${extension} already in dist without deleting it`, async t => {
    const root = await project(t);
    await mkdir(join(root, 'dist'));
    const name = `material-ficticio-confidencial.${extension}`;
    const bytes = Buffer.from('Private fixture preserved on refusal');
    await writeFile(join(root, 'dist', name), bytes);
    await refusedBuild(root, name);
    assert.deepEqual(await readFile(join(root, 'dist', name)), bytes);
  });
}

test('renaming private audio to a licensed filename does not authorize publication', async t => {
  const root = await project(t);
  const replacement = Buffer.from('RIFF\0\0\0\0WAVEprivate fixture');
  await writeFile(join(root, 'assets/drums/kick.wav'), replacement);
  await refusedBuild(root, 'private fixture');
  assert.deepEqual(await readFile(join(root, 'assets/drums/kick.wav')), replacement);
});

test('public source cannot follow a symlink into private local content', async t => {
  const root = await project(t);
  await mkdir(join(root, 'local'));
  await writeFile(join(root, 'local/private-example.json'), '{"secret":"fictitious"}');
  await symlink('../local/private-example.json', join(root, 'src/course.js'));
  await refusedBuild(root, 'private-example.json');
});

test('PDF content disguised as an application module is refused', async t => {
  const root = await project(t);
  await writeFile(join(root, 'src/renamed.js'), '%PDF-1.7\nprivate fixture');
  await refusedBuild(root, 'private fixture');
});
