#!/usr/bin/env node
// 4.6 の確認: 前の配置物（develop の eb49c83）で書いた CLAUDE.md・AGENTS.md の古い区画が、
// 4.5 のコミットの配置物に更新した後の入力のフックで、区画だけ書き直されることを確かめる。
// 使い方: node poc/self-apply/rewrite.mjs（POC_KEEP=1 で作業場所を残す）
// 作業場所は ~/.cache/cc-sdd-bootstrap-scratch/rewrite-<乱数>/ の下に作る（git worktree は使わない）。
// 確かめること: (a) 区画が 4.5 の文章になる (b) 区画の外が変わらない (c) cc-sdd の導入（npx）が呼ばれない (d) 2 回目の入力では何も書き直されない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SECTION_BEGIN_MARKER, SECTION_END_MARKER } from '../../.agent-hooks/cc-sdd-bootstrap/install-rules.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// この spec の前の配置物（develop のコミット）
const BASE_REV = 'eb49c83';
const TARGET_REV = 'd71527a'; // 4.5（自己適用）のコミット
const SCRATCH = path.join(os.homedir(), '.cache', 'cc-sdd-bootstrap-scratch');
const DOCS = ['CLAUDE.md', 'AGENTS.md'];
const SECTION_FILES = {
  'CLAUDE.md': '.agent-hooks/cc-sdd-bootstrap/agent-section-claude.md',
  'AGENTS.md': '.agent-hooks/cc-sdd-bootstrap/agent-section-codex.md',
};
// 区画の外に足す目印の文章。書き直しの後も一字も変わらないことを確かめる。
const MARK_BEFORE = '区画の外の目印（前）: 4.6 の確認で足した文章';
const MARK_AFTER = '区画の外の目印（後）: 4.6 の確認で足した文章';
// 委任の案内（lib/catalog.mjs の delegationSection）の見出しの文。新しい区画に含まれることを確かめる。
const DELEGATION_LEAD = '子（指揮役から仕事を任される別のモデル）への分担と既定のモデルは次のとおりです';
const REWRITE_NOTICE = '区画だけを書き直しました';

const date = new Date().toISOString().slice(0, 10);
let ok = 0;
let ng = 0;

function check(label, passed, detail = '') {
  const status = Boolean(passed);
  console.log(`${status ? 'OK' : 'NG'} ${label}${detail ? `: ${detail}` : ''}`);
  status ? ok++ : ng++;
}
/** 前提の確認。失敗したら以降の確認は意味が無いので止める */
function need(label, passed, detail = '') {
  check(label, passed, detail);
  if (!passed) throw new Error(`${label} で止めました`);
}
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 600_000, ...options });
}
function output(result) { return `${result.stdout ?? ''}\n${result.stderr ?? ''}`; }
/** 結果の最後の行（失敗の理由の目安）。長すぎる場合は切る */
function tail(result) { return (output(result).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '').slice(0, 200); }
function read(file) { return fs.readFileSync(file, 'utf8'); }
function digest(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function shellQuote(text) { return `'${text.replace(/'/g, "'\\''")}'`; }

/** 文書を区画の前・区画・区画の後に分ける。区画が無ければ null */
function splitDoc(text) {
  const lines = text.split('\n');
  const begin = lines.indexOf(SECTION_BEGIN_MARKER);
  const end = begin < 0 ? -1 : lines.indexOf(SECTION_END_MARKER, begin + 1);
  if (begin < 0 || end < 0) return null;
  return {
    before: lines.slice(0, begin).join('\n'),
    section: lines.slice(begin, end + 1).join('\n'),
    after: lines.slice(end + 1).join('\n'),
  };
}

/** リビジョンの木を普通のディレクトリに展開する（git worktree は使わない） */
function exportTree(rev, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const archive = spawnSync('git', ['-C', repoRoot, 'archive', rev], { maxBuffer: 512 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive ${rev} に失敗しました: ${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-f', '-', '-C', dir], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`${dir} への展開に失敗しました: ${untar.stderr}`);
}

async function main() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const work = fs.mkdtempSync(path.join(SCRATCH, 'rewrite-'));
  const checkout = path.join(work, 'checkout');
  const headTree = path.join(work, 'head');
  const npxDir = path.join(work, 'npx-bin');
  const npxLog = path.join(work, 'npx-calls.log');
  const npxCalls = () => (fs.existsSync(npxLog) ? read(npxLog) : '');
  try {
    console.log(`実行日: ${date}`);
    console.log(`作業場所: ${work}`);
    // 検証する配置物は 4.5 のコミットに固定する（後続のコミットを 4.5 として検証したことにしない）。別のコミットで試すときは REWRITE_TARGET_REV で明示する
    const headRev = run('git', ['-C', repoRoot, 'rev-parse', '--verify', `${process.env.REWRITE_TARGET_REV ?? TARGET_REV}^{commit}`]);
    if (headRev.status !== 0) { console.error(`対象のコミットが見つかりません: ${process.env.REWRITE_TARGET_REV ?? TARGET_REV}`); process.exit(2); }
    const head = headRev.stdout.trim();
    console.log(`更新先のコミット: ${head}${process.env.REWRITE_TARGET_REV ? '（REWRITE_TARGET_REV で指定）' : '（4.5 のコミット）'}（前の配置物: ${BASE_REV}）`);

    // 1. 前の配置物で一時の checkout を作り、その時点の導入コマンドで配置して cc-sdd を導入する
    exportTree(BASE_REV, checkout);
    // init は設定ファイルが無い状態を前提にするため、展開した追跡中の設定を外してから init する
    fs.rmSync(path.join(checkout, '.cc-sdd-bootstrap.json'), { force: true });
    run('git', ['init', '-q'], { cwd: checkout });
    const init = run('node', ['bin/cc-sdd-bootstrap.mjs', 'init'], { cwd: checkout });
    need('前の配置物の init が成功する', init.status === 0, tail(init));
    const oldUpdate = run('node', ['bin/cc-sdd-bootstrap.mjs', 'update'], { cwd: checkout });
    need('前の配置物の update が成功する', oldUpdate.status === 0, tail(oldUpdate));
    // cc-sdd の導入は本物の npx を使う（通信が要る）。記録用の npx はまだ PATH に置かない
    const install = run('node', ['.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs'], { cwd: checkout, timeout: 600_000 });
    need('cc-sdd を導入する（本物の npx）', install.status === 0 && fs.existsSync(path.join(checkout, '.cache/cc-sdd-install.state.json')), tail(install));

    // 古い区画（前の配置物の文章）と、その配置物の区画の文章を記録する
    const oldFile = Object.fromEntries(DOCS.map((doc) => [doc, read(path.join(checkout, SECTION_FILES[doc]))]));
    for (const doc of DOCS) {
      const parts = splitDoc(read(path.join(checkout, doc)));
      need(`前提: ${doc} に前の配置物の区画がある`, parts !== null && parts.section.trimEnd() === oldFile[doc].trimEnd());
    }

    // 2. 区画の前後に目印の文章を足す
    for (const doc of DOCS) {
      const file = path.join(checkout, doc);
      fs.writeFileSync(file, `${MARK_BEFORE}\n\n${read(file)}\n\n${MARK_AFTER}\n`, 'utf8');
    }
    const outsideExpected = Object.fromEntries(DOCS.map((doc) => {
      const parts = splitDoc(read(path.join(checkout, doc)));
      return [doc, { before: parts?.before ?? null, after: parts?.after ?? null }];
    }));

    // 3. 呼び出しを記録するだけの npx を一時のディレクトリに置く（この後、後の入力の時だけ PATH の先頭に出す）
    fs.mkdirSync(npxDir, { recursive: true });
    fs.writeFileSync(path.join(npxDir, 'npx'), `#!/bin/sh\necho "cwd=$(pwd) args=$*" >> ${shellQuote(npxLog)}\nexit 0\n`, { mode: 0o755 });

    // 4. 4.5 のコミットの配置物に更新する（HEAD のツリーを別に展開し、その bin を checkout を cwd にして実行する）
    exportTree(head, headTree);
    const newUpdate = run('node', [path.join(headTree, 'bin/cc-sdd-bootstrap.mjs'), 'update'], { cwd: checkout });
    need('4.5 のコミットの bin で update が成功する', newUpdate.status === 0, tail(newUpdate));
    const newFile = Object.fromEntries(DOCS.map((doc) => [doc, read(path.join(headTree, SECTION_FILES[doc]))]));
    for (const doc of DOCS) {
      need(`前提: ${doc} の配置物の区画が 4.5 の文章になり、文書の古い区画と違う`,
        read(path.join(checkout, SECTION_FILES[doc])) === newFile[doc]
          && newFile[doc].trimEnd() !== oldFile[doc].trimEnd());
    }

    // 5. 後の入力を模す: 入力の JSON を標準入力に渡し、この時だけ記録用の npx を PATH の先頭に出す
    const event = JSON.stringify({
      session_id: 'rewrite-check',
      transcript_path: path.join(work, 'transcript.jsonl'),
      cwd: checkout,
      hook_event_name: 'UserPromptSubmit',
      prompt: '/kiro-spec-status subagent-delegation',
    });
    const hookEnv = { ...process.env, PATH: `${npxDir}${path.delimiter}${process.env.PATH ?? ''}` };
    const promptHook = () => run('node', [
      path.join(checkout, '.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs'), 'user-prompt-submit', '--tool', 'claude',
    ], { cwd: checkout, input: event, env: hookEnv });

    const first = promptHook();
    check('1 回目の入力のフックが終了コード 0 で終わる', first.status === 0, tail(first));
    check('1 回目の入力で区画だけを書き直したと知らされる', output(first).includes(REWRITE_NOTICE));
    const afterFirst = Object.fromEntries(DOCS.map((doc) => [doc, digest(path.join(checkout, doc))]));

    // 確かめること (a)(b)(c)
    for (const doc of DOCS) {
      const parts = splitDoc(read(path.join(checkout, doc)));
      check(`(a) ${doc} の区画が 4.5 の文章に書き直された`,
        parts !== null && parts.section.trimEnd() === newFile[doc].trimEnd() && parts.section.includes(DELEGATION_LEAD),
        parts === null ? '区画が見つからない' : '');
      check(`(b) ${doc} の区画の外の目印が一字も変わっていない`,
        parts !== null && parts.before === outsideExpected[doc].before && parts.after === outsideExpected[doc].after
          && parts.before.includes(MARK_BEFORE) && parts.after.includes(MARK_AFTER));
    }
    check('(c) 記録した npx が一度も呼ばれていない（cc-sdd の再導入が起きていない）', npxCalls() === '', npxCalls().trim());

    // (d) 2 回目の入力では何も書き直されない
    const second = promptHook();
    check('(d) 2 回目の入力のフックが終了コード 0 で終わる', second.status === 0, tail(second));
    check('(d) 2 回目の入力で文書がバイト単位で変わらない', DOCS.every((doc) => digest(path.join(checkout, doc)) === afterFirst[doc]));
    check('(d) 2 回目の入力では書き直しの案内が出ない', !output(second).includes(REWRITE_NOTICE));
    check('(d) 2 回目の入力でも npx が呼ばれていない', npxCalls() === '', npxCalls().trim());
  } catch (error) {
    check('実機の確認を最後まで実行', false, error instanceof Error ? error.message : String(error));
  } finally {
    if (process.env.POC_KEEP === '1') console.log(`作業場所を残しました: ${work}`);
    else fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(`結果: OK ${ok} 件、NG ${ng} 件`);
  process.exitCode = ng === 0 ? 0 : 1;
}

await main();
