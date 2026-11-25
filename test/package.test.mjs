import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { catalog } from '../lib/catalog.mjs';

const packageRoot = path.resolve(import.meta.dirname, '..');

test('配布物は入口・本体・カタログの配置物に限られる', (t) => {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'cc-sdd-bootstrap-npm-cache-'));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cacheDir },
    timeout: 120_000,
  });

  if (['ENOENT', 'EACCES', 'EPERM'].includes(result.error?.code)) {
    const reason = `npm を起動できませんでした (${result.error.code}): ${result.error.message}`;
    t.diagnostic(reason);
    t.skip(reason);
    return;
  }

  assert.ifError(result.error, `npm pack の実行に失敗しました: ${result.stderr}`);
  assert.equal(result.signal, null, `npm pack がシグナル ${result.signal} で終了しました: ${result.stderr}`);
  assert.equal(result.status, 0, `npm pack が終了コード ${result.status} で失敗しました: ${result.stderr}`);
  let pack;
  try {
    pack = JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(`npm pack の JSON を解析できません: ${error.message}\n${result.stdout}`);
  }
  assert.ok(Array.isArray(pack) && pack[0]?.files, 'npm pack の結果に files 一覧がありません');
  const files = new Set(pack[0].files.map((entry) => entry.path));

  assert.ok(files.has('package.json'), 'package.json が同梱されていません');
  assert.ok(files.has('bin/cc-sdd-bootstrap.mjs'), '入口が同梱されていません');

  const libraryFiles = readdirSync(path.join(packageRoot, 'lib'))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => `lib/${name}`);
  const catalogFiles = catalog.files.map(({ path: filePath }) => filePath);
  for (const file of [...libraryFiles, ...catalogFiles]) {
    assert.ok(files.has(file), `${file} が同梱されていません`);
  }

  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const expectedFiles = new Set(['package.json', 'README.md', 'LICENSE', 'bin/cc-sdd-bootstrap.mjs', ...libraryFiles, ...catalogFiles]);
  assert.deepEqual([...files].sort(), [...expectedFiles].sort(), '同梱ファイルが package.json の files とカタログに一致しません');

  assert.ok(!files.has('.agent-hooks/cc-sdd-bootstrap/installed.json'), '配置の記録が同梱されています');
  for (const file of files) {
    assert.ok(!file.startsWith('test/'), `テストファイルが同梱されています: ${file}`);
    assert.ok(!file.startsWith('poc/'), `PoC ファイルが同梱されています: ${file}`);
    assert.ok(!file.startsWith('.kiro/'), `.kiro のファイルが同梱されています: ${file}`);
    assert.ok(!/^skills\/kiro-[^/]+(?:\/|$)/.test(file), `cc-sdd 本体のスキルが同梱されています: ${file}`);
    assert.ok(!/(?:^|\/)settings\/templates(?:\/|$)/.test(file), `cc-sdd 本体の雛形が同梱されています: ${file}`);
  }
  assert.ok(!files.has('.claude/settings.json'), '.claude/settings.json が同梱されています');
  assert.ok(!files.has('CLAUDE.md'), 'CLAUDE.md が同梱されています');

  for (const dependencyField of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.ok(!manifest[dependencyField] || Object.keys(manifest[dependencyField]).length === 0,
      `${dependencyField} に依存パッケージがあります`);
  }
  assert.equal(manifest.engines?.node, '>=22');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.bin?.['cc-sdd-bootstrap'], 'bin/cc-sdd-bootstrap.mjs');
  assert.ok(readFileSync(path.join(packageRoot, 'bin/cc-sdd-bootstrap.mjs'), 'utf8')
    .startsWith('#!/usr/bin/env node\n'), '入口に Node.js の shebang がありません');
});

test('展開した配布物から導入コマンドを起動できる（help が成功する）', (t) => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'cc-sdd-bootstrap-pack-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const cacheDir = path.join(work, 'cache');
  const outDir = path.join(work, 'out');
  const unpackDir = path.join(work, 'unpacked');
  for (const dir of [outDir, unpackDir]) mkdirSync(dir);

  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', outDir], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cacheDir },
    timeout: 120_000,
  });
  if (['ENOENT', 'EACCES', 'EPERM'].includes(packed.error?.code)) {
    t.skip(`npm を起動できませんでした (${packed.error.code})`);
    return;
  }
  assert.equal(packed.status, 0, `npm pack が失敗しました: ${packed.stderr}`);
  const tarball = path.join(outDir, JSON.parse(packed.stdout)[0].filename);

  const extracted = spawnSync('tar', ['-xzf', tarball, '-C', unpackDir], { encoding: 'utf8' });
  if (extracted.error) {
    t.skip(`tar を起動できませんでした (${extracted.error.code})`);
    return;
  }
  assert.equal(extracted.status, 0, extracted.stderr);

  const root = path.join(unpackDir, 'package');
  assert.ok(existsSync(path.join(root, '.agent-hooks/cc-sdd-bootstrap/subagent-roles.mjs')), 'subagent-roles.mjs が展開物にありません');
  const help = spawnSync(process.execPath, [path.join(root, 'bin/cc-sdd-bootstrap.mjs'), 'help'], { cwd: unpackDir, encoding: 'utf8' });
  assert.equal(help.status, 0, `help が失敗しました: ${help.stderr}`);
  assert.match(help.stdout, /init/);
  assert.match(help.stdout, /update/);
});
