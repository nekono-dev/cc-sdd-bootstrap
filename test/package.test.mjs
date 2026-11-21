import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { catalog } from '../lib/catalog.mjs';

const packageRoot = path.resolve(import.meta.dirname, '..');

test('npm package contains only the intended runtime files', (t) => {
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
  for (const file of [...libraryFiles, ...catalog.files.map(({ path: filePath }) => filePath)]) {
    assert.ok(files.has(file), `${file} が同梱されていません`);
  }
  for (const file of ['.agent-hooks/cc-sdd-bootstrap/delegation-registry.mjs', '.agent-hooks/cc-sdd-bootstrap/delegation-mcp.mjs']) {
    assert.ok(files.has(file), `${file} が同梱されていません`);
  }

  assert.ok(!files.has('.agent-hooks/cc-sdd-bootstrap/installed.json'), '配置の記録が同梱されています');
  for (const file of files) {
    assert.ok(!file.startsWith('test/'), `テストファイルが同梱されています: ${file}`);
    assert.ok(!file.startsWith('poc/'), `PoC ファイルが同梱されています: ${file}`);
    assert.ok(!file.startsWith('.kiro/'), `.kiro のファイルが同梱されています: ${file}`);
  }
  assert.ok(!files.has('.claude/settings.json'), '.claude/settings.json が同梱されています');
  assert.ok(!files.has('CLAUDE.md'), 'CLAUDE.md が同梱されています');

  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
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
