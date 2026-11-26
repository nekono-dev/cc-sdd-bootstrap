#!/usr/bin/env node
// PoC（work-branch-flow の設計の前提の確認）
//   A: フックの入力が worktree での作業をどう映すか（cwd・編集ツールの対象ファイル）
//   B: 試作の関門（基底ブランチの間、編集ツールを拒否）で、拒否→ブランチ作成→編集の流れが両ツールで成立するか
//   C: B に branch-release-workflow（brw）のフックを重ねたとき、拒否が衝突せず brw の手順へ移るか（Claude Code）
//   D: gh が無い・未認証のときの PR の有無の判定が、止めずに通せるか
//   G: F に別の仕組み（brw）を重ねたとき、行き詰まらず作業ブランチ（worktree）で作業できるか（Claude Code）
//   H: 配置した入口の終了の停止（PR が無ければ 1 回止める）が、両ツールで成立するか（偽の gh を使う）
//   F: 配置した入口（cc-sdd-bootstrap init で入れた work-branch-gate）で、基底ブランチ上の対象の入力 → 案内 → 拒否 → 切り替え → 作業が両ツールで成立するか
// 使い方: node poc/work-branch-flow/run.mjs [A] [B] [C] [D]   認証済みの claude・codex、git、Node.js 22 が要る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  check, observe, summary, run, git, makeRepo, registerHooks, records, resetLog, invoke, succeeded, finalAnswer, brwRoot, scratch,
} from './common.mjs';

const want = process.argv.slice(2).map((s) => s.toUpperCase());
const enabled = (name) => want.length === 0 || want.includes(name);
const tools = ['claude', 'codex'];

function addWorktree(dir, name, branch) {
  // brw と同じく、リポジトリの中（.claude/worktrees/）に作る。Codex の書き込み許可の範囲に入る
  const wt = path.join(dir, '.claude/worktrees', name);
  fs.rmSync(wt, { recursive: true, force: true });
  git(dir, 'worktree', 'prune');
  const r = git(dir, 'worktree', 'add', '-q', '-b', branch, wt);
  if (r.status !== 0) throw new Error(`worktree の作成に失敗: ${r.stderr}`);
  return wt;
}
const pre = (list) => list.filter((r) => r.input?.hook_event_name === 'PreToolUse');
const brief = (r) => `${r.input.tool_name} cwd=${r.input.cwd} input=${JSON.stringify(r.input.tool_input).slice(0, 160)}`;

// ---- A: フックの入力 ----
if (enabled('A')) {
  console.log('\n## A: フックの入力（worktree での作業）');
  for (const tool of tools) {
    const dir = makeRepo(`a-${tool}`);
    const wt = addWorktree(dir, 'wt', 'dev/x');
    registerHooks(dir, [{ event: 'PreToolUse', args: 'log' }]);
    const prompt = tool === 'claude'
      ? `次を順に実行してください。1. Bash で cd ${wt} を実行。2. Bash で pwd と git branch --show-current を実行。3. Write ツールで ${wt}/a.txt に a と書く。4. Write ツールで相対パス b.txt に b と書く。終わったら完了と答える。`
      : `次を順に実行してください。1. シェルで workdir を ${wt} にして pwd と git branch --show-current を実行。2. apply_patch で ${wt}/a.txt に a と書く。3. apply_patch で相対パス b.txt に b と書く。終わったら完了と答える。`;
    const result = invoke(tool, dir, prompt);
    check(`A ${tool}: 実行が成功した`, succeeded(result));
    const list = pre(records(dir));
    for (const r of list) observe(`A ${tool}`, brief(r));
    const names = list.map((r) => r.input.tool_name);
    observe(`A ${tool}: ツール名`, [...new Set(names)].join(', '));
    check(`A ${tool}: 編集のツール（Write / apply_patch）が PreToolUse で観測できた`, names.some((n) => /^(Write|apply_patch)$/.test(n)));
    observe(`A ${tool}: a.txt の場所`, `wt=${fs.existsSync(path.join(wt, 'a.txt'))} main=${fs.existsSync(path.join(dir, 'a.txt'))}`);
    observe(`A ${tool}: b.txt（相対パス）の場所`, `wt=${fs.existsSync(path.join(wt, 'b.txt'))} main=${fs.existsSync(path.join(dir, 'b.txt'))}`);
  }
}

// ---- B: 試作の関門 ----
if (enabled('B')) {
  console.log('\n## B: 試作の関門（基底ブランチの間は編集ツールを拒否）');
  for (const tool of tools) {
    const dir = makeRepo(`b-${tool}`);
    registerHooks(dir, [{ event: 'PreToolUse', args: 'gate' }]);
    const result = invoke(tool, dir, 'hello.txt というファイルを作り、内容を hi にしてください。');
    check(`B ${tool}: 実行が成功した`, succeeded(result));
    const list = pre(records(dir));
    const denied = list.filter((r) => r.output?.hookSpecificOutput?.permissionDecision === 'deny');
    observe(`B ${tool}: 呼び出し`, list.map((r) => `${r.input.tool_name}${r.output ? '(拒否)' : ''}`).join(' → '));
    check(`B ${tool}: 基底ブランチ上の編集が拒否された`, denied.length >= 1);
    const branch = git(dir, 'branch', '--show-current').stdout.trim();
    check(`B ${tool}: 拒否の後に作業ブランチへ切り替えた`, branch !== 'develop' && branch !== '', `branch=${branch}`);
    check(`B ${tool}: 切り替えの後にファイルが作られた`, fs.existsSync(path.join(dir, 'hello.txt')));
    check(`B ${tool}: develop には変更が入っていない`, git(dir, 'ls-tree', '-r', '--name-only', 'develop').stdout.split('\n').every((f) => f !== 'hello.txt'));
  }
}

// ---- C: brw との併存（Claude Code） ----
if (enabled('C')) {
  console.log('\n## C: brw のフックと重ねる（Claude Code）');
  const dir = makeRepo('c-claude');
  fs.writeFileSync(path.join(dir, '.branch-release-workflow.json'), `${JSON.stringify({
    workBranches: ['develop', 'dev/*'], protectedBranches: ['main'], baseBranch: 'develop',
    namePattern: '^dev/[a-z0-9]+(-[a-z0-9]+)*$', autoApprove: { push: true, pullRequest: true }, preview: { provider: 'none' },
  }, null, 2)}\n`);
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'brw declaration'); git(dir, 'push', '-q', 'origin', 'develop');
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'brw'), `#!/bin/sh\nexec node ${JSON.stringify(path.join(brwRoot, 'scripts/brw.mjs'))} "$@"\n`, { mode: 0o755 });
  registerHooks(dir, [{ event: 'PreToolUse', args: 'gate' }]);
  const result = invoke('claude', dir, 'hello.txt というファイルを作り、内容を hi にしてください。', { pluginDir: brwRoot, extraPath: bin });
  check('C: 実行が成功した', succeeded(result));
  const list = pre(records(dir));
  observe('C: 関門のフックを通った呼び出し', list.map((r) => `${r.input.tool_name}${r.output ? '(関門が拒否)' : ''}`).join(' → '));
  const text = `${result.stdout}`;
  const brwDenied = /brw create|brw resume/.test(text);
  check('C: 関門が基底ブランチ上の編集を拒否した', list.some((r) => r.output));
  observe('C: brw の案内（brw create / brw resume）が会話に現れた', String(brwDenied));
  const worktrees = git(dir, 'worktree', 'list', '--porcelain').stdout;
  observe('C: worktree', worktrees.replace(/\n/g, ' | '));
  const created = worktrees.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).find((p) => p !== dir);
  check('C: brw が worktree を作った', Boolean(created));
  if (created) {
    check('C: ファイルは worktree の中に作られた', fs.existsSync(path.join(created, 'hello.txt')));
    check('C: 本体の checkout（develop）には作られていない', !fs.existsSync(path.join(dir, 'hello.txt')));
    const writes = list.filter((r) => r.input.tool_name === 'Write' && !r.output);
    observe('C: 許可された Write の対象', writes.map((r) => r.input.tool_input.file_path).join(', '));
    check('C: worktree 内の Write が関門を通った（現在のブランチを対象ファイルの場所で判定できる）', writes.some((r) => String(r.input.tool_input.file_path).startsWith(created)));
  }
  observe('C: 最終の答え', finalAnswer('claude', result).slice(0, 200));
}

// ---- D: gh が無い・未認証のとき ----
if (enabled('D')) {
  console.log('\n## D: gh の状態ごとの PR の有無の判定');
  const dir = makeRepo('d');
  git(dir, 'switch', '-q', '-c', 'dev/d');
  const clean = { ...process.env };
  const cases = {
    '未認証（無効なトークン・設定の場所を空に）': { env: { ...clean, GH_TOKEN: 'invalid', GITHUB_TOKEN: 'invalid', GH_CONFIG_DIR: path.join(scratch, 'empty-gh') } },
    'gh が PATH に無い': { env: { ...clean, PATH: '/usr/local/bin-nonexistent' }, command: '/usr/bin/env' },
    'リモートが GitHub ではない（ローカルの bare）': { env: clean },
  };
  for (const [label, { env, command }] of Object.entries(cases)) {
    const r = command
      ? run('gh', ['pr', 'list', '--head', 'dev/d', '--json', 'number'], { cwd: dir, env })
      : run('gh', ['pr', 'list', '--head', 'dev/d', '--json', 'number'], { cwd: dir, env });
    observe(`D ${label}`, `status=${r.status} error=${r.error?.code ?? '-'} stderr=${(r.stderr ?? '').trim().split('\n')[0]}`);
    check(`D ${label}: 終了コードが 0 以外（成功と取り違えない）`, r.status !== 0);
  }
}

// ---- E: Bash も対象にした関門 ----
if (enabled('E')) {
  console.log('\n## E: Bash も対象にした関門（git の切り替え系・読み取り専用だけ許可）');
  const brwRepo = (name) => {
    const dir = makeRepo(name);
    fs.writeFileSync(path.join(dir, '.branch-release-workflow.json'), `${JSON.stringify({
      workBranches: ['develop', 'dev/*'], protectedBranches: ['main'], baseBranch: 'develop',
      namePattern: '^dev/[a-z0-9]+(-[a-z0-9]+)*$', autoApprove: { push: true, pullRequest: true }, preview: { provider: 'none' },
    }, null, 2)}\n`);
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'brw declaration'); git(dir, 'push', '-q', 'origin', 'develop');
    return dir;
  };
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'brw'), `#!/bin/sh\nexec node ${JSON.stringify(path.join(brwRoot, 'scripts/brw.mjs'))} "$@"\n`, { mode: 0o755 });
  const prompt = 'hello.txt というファイルを作り、内容を hi にしてください。シェルのコマンドで作ってかまいません。';
  const seq = (list) => pre(list).map((r) => `${r.input.tool_name}${r.output ? '(関門が拒否)' : ''}`).join(' → ');
  const cases = [
    { id: 'E1', label: 'brw なし・gate-all', mode: 'gate-all', tool: 'claude', brw: false },
    { id: 'E1', label: 'brw なし・gate-all', mode: 'gate-all', tool: 'codex', brw: false },
    { id: 'E2', label: 'brw あり・gate-all（brw を許可しない）', mode: 'gate-all', tool: 'claude', brw: true },
    { id: 'E3', label: 'brw あり・gate-all+brw（brw を許可する）', mode: 'gate-all+brw', tool: 'claude', brw: true },
  ];
  for (const c of cases) {
    const dir = c.brw ? brwRepo(`e-${c.id}-${c.tool}`) : makeRepo(`e-${c.id}-${c.tool}`);
    registerHooks(dir, [{ event: 'PreToolUse', args: c.mode }]);
    const result = invoke(c.tool, dir, prompt, c.brw ? { pluginDir: brwRoot, extraPath: bin } : {});
    const list = records(dir);
    observe(`${c.id} ${c.label} ${c.tool}: 呼び出し`, seq(list));
    for (const r of pre(list).filter((x) => x.input.tool_name === 'Bash' || x.input.tool_name === 'exec_command')) {
      observe(`${c.id} ${c.tool}: Bash`, `${r.output ? '[拒否] ' : ''}${String(r.input.tool_input.command).slice(0, 110)}`);
    }
    const wts = git(dir, 'worktree', 'list', '--porcelain').stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
    const where = [dir, ...wts].find((d) => fs.existsSync(path.join(d, 'hello.txt')));
    observe(`${c.id} ${c.tool}: hello.txt の場所`, where ?? '作られなかった');
    const branchOf = where ? git(where, 'branch', '--show-current').stdout.trim() : '-';
    check(`${c.id} ${c.tool}: 基底ブランチの外（作業ブランチ）でファイルが作られた`, Boolean(where) && branchOf !== 'develop' && branchOf !== '', `branch=${branchOf}`);
    check(`${c.id} ${c.tool}: 関門が拒否した`, list.some((r) => r.output));
    observe(`${c.id} ${c.tool}: 最終の答え`, finalAnswer(c.tool, result).slice(0, 160).replace(/\n/g, ' '));
  }
}

// ---- F: 配置した入口（work-branch-flow タスク 1.3） ----
if (enabled('F')) {
  console.log('\n## F: 配置した work-branch-gate（init で導入）で、拒否→案内→切り替え→作業');
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const skill = (name) => `---\nname: ${name}\ndescription: 確認用の手順書（${name}）\n---\n\n# ${name}\n\n手順: \`.kiro/specs/demo/brief.md\` というファイルを作り、内容を \`# Brief: demo\` の 1 行にして、「完了」と答える。\n`;
  for (const tool of tools) {
    const dir = makeRepo(`f-${tool}`);
    const init = run(process.execPath, [path.join(repoRoot, 'bin/cc-sdd-bootstrap.mjs'), 'init'], { cwd: dir });
    observe(`F ${tool}: init`, `status=${init.status} ${String(init.stderr ?? '').trim().split('\n')[0]}`);
    check(`F ${tool}: init が成功し、配置物と登録が入った`, init.status === 0 && fs.existsSync(path.join(dir, '.agent-hooks/cc-sdd-bootstrap/work-branch-gate.mjs')));
    const registered = [path.join(dir, '.claude/settings.json'), path.join(dir, '.codex/hooks.json')].map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').includes('work-branch-gate.mjs') : false));
    check(`F ${tool}: 両ツールの登録に work-branch-gate がある`, registered.every(Boolean), registered.join(','));
    // 手順書: 本物は導入に通信が要るので、確認用の同名の手順書を置く（kiro-gate が先読みを求めるので、併存の確認も兼ねる）
    for (const base of ['.claude/skills', '.agents/skills']) {
      fs.mkdirSync(path.join(dir, base, 'kiro-discovery'), { recursive: true });
      fs.writeFileSync(path.join(dir, base, 'kiro-discovery/SKILL.md'), skill('kiro-discovery'));
    }
    const hint = ' 作業用ブランチは dev/demo を使ってよい。';
    const prompt = tool === 'claude' ? `/kiro-discovery demo${hint}` : `$kiro-discovery demo${hint}`;
    const result = invoke(tool, dir, prompt, { tools: 'Bash,Read,Write,Edit,Agent,Skill' });
    check(`F ${tool}: 実行が成功した`, succeeded(result));
    const text = `${result.stdout}\n${result.stderr}`;
    const branch = git(dir, 'branch --show-current'.split(' ')[0], ...'branch --show-current'.split(' ').slice(1)).stdout.trim();
    const wts = git(dir, 'worktree', 'list', '--porcelain').stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
    const brief = path.join('.kiro/specs/demo/brief.md');
    const where = [dir, ...wts].find((d) => fs.existsSync(path.join(d, brief)));
    observe(`F ${tool}: 現在のブランチ`, branch);
    observe(`F ${tool}: brief.md の場所`, where ?? '作られなかった');
    observe(`F ${tool}: 拒否の理由が会話に現れた`, String(/作業用ブランチ/.test(text)));
    const switched = Boolean(where) && git(where, 'branch', '--show-current').stdout.trim() !== 'develop' && git(where, 'branch', '--show-current').stdout.trim() !== '';
    // Codex の workspace-write では .git が読み取り専用でブランチを作れない。その場合は作れない理由を伝えて止まる（要件 3.8）ことを期待する
    const answer = finalAnswer(tool, result);
    const stopped = tool === 'codex' && !where && /読み取り専用|作成できません|作れません|作成できず/.test(answer);
    check(`F ${tool}: 作業ブランチへ切り替えてから brief.md が作られた${tool === 'codex' ? '（または .git が書けず、理由を伝えて止まった）' : ''}`, switched || stopped, stopped ? '作れない理由を伝えて止まった' : '');
    check(`F ${tool}: develop には brief.md が入っていない`, !git(dir, 'ls-tree', '-r', '--name-only', 'develop').stdout.includes('brief.md'));
    observe(`F ${tool}: 最終の答え`, finalAnswer(tool, result).slice(0, 200).replace(/\n/g, ' '));
    fs.writeFileSync(path.join(scratch, `f-${tool}.out.txt`), text);
  }
}

// ---- G・H: 別の仕組みを重ねた構成と終了の停止（work-branch-flow タスク 5.1） ----
const repoRootForGH = path.resolve(import.meta.dirname, '../..');
const skillText = (name, body) => `---\nname: ${name}\ndescription: 確認用の手順書（${name}）\n---\n\n# ${name}\n\n${body}\n`;
function deployedRepo(name, { brw = false } = {}) {
  const dir = makeRepo(name);
  if (brw) {
    fs.writeFileSync(path.join(dir, '.branch-release-workflow.json'), `${JSON.stringify({
      workBranches: ['develop', 'dev/*'], protectedBranches: ['main'], baseBranch: 'develop',
      namePattern: '^dev/[a-z0-9]+(-[a-z0-9]+)*$', autoApprove: { push: true, pullRequest: true }, preview: { provider: 'none' },
    }, null, 2)}\n`);
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'brw declaration'); git(dir, 'push', '-q', 'origin', 'develop');
  }
  const init = run(process.execPath, [path.join(repoRootForGH, 'bin/cc-sdd-bootstrap.mjs'), 'init'], { cwd: dir });
  if (init.status !== 0) throw new Error(`init に失敗: ${init.stderr}`);
  return dir;
}
function fakeBin(name, scripts) {
  const bin = path.join(scratch, name);
  fs.rmSync(bin, { recursive: true, force: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const [cmd, text] of Object.entries(scripts)) fs.writeFileSync(path.join(bin, cmd), text, { mode: 0o755 });
  return bin;
}
function workBranchStates(since) {
  const dir = path.join(os.tmpdir(), 'cc-sdd-bootstrap-work-branch');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).mtimeMs >= since)
    .map((f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }).filter(Boolean);
}

if (enabled('G')) {
  console.log('\n## G: 別の仕組み（brw）を重ねる（Claude Code）');
  const dir = deployedRepo('g-claude', { brw: true });
  for (const base of ['.claude/skills']) {
    fs.mkdirSync(path.join(dir, base, 'kiro-discovery'), { recursive: true });
    fs.writeFileSync(path.join(dir, base, 'kiro-discovery/SKILL.md'), skillText('kiro-discovery', '手順: `.kiro/specs/demo/brief.md` というファイルを作り、内容を `# Brief: demo` の 1 行にして、「完了」と答える。'));
  }
  const bin = fakeBin('bin-g', { brw: `#!/bin/sh\nexec node ${JSON.stringify(path.join(brwRoot, 'scripts/brw.mjs'))} "$@"\n` });
  const result = invoke('claude', dir, '/kiro-discovery demo 作業用ブランチは dev/demo にしてよい。', { pluginDir: brwRoot, extraPath: bin, tools: 'Bash,Read,Write,Edit,Agent,Skill' });
  check('G: 実行が成功した', succeeded(result));
  const text = `${result.stdout}\n${result.stderr}`;
  fs.writeFileSync(path.join(scratch, 'g-claude.out.txt'), text);
  const wts = git(dir, 'worktree', 'list', '--porcelain').stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).filter((p) => p !== dir);
  observe('G: worktree', wts.join(', ') || 'なし');
  observe('G: brw の案内（brw create / brw resume）が会話に現れた', String(/brw (create|resume)/.test(text)));
  check('G: 別の仕組みが worktree を作り、行き詰まらなかった', wts.length > 0);
  const where = wts.find((w) => fs.existsSync(path.join(w, '.kiro/specs/demo/brief.md')));
  check('G: brief.md は worktree（作業ブランチ）の中に作られた', Boolean(where));
  check('G: 本体の checkout（develop）には brief.md が無い', !fs.existsSync(path.join(dir, '.kiro/specs/demo/brief.md')));
  observe('G: 最終の答え', finalAnswer('claude', result).slice(0, 200).replace(/\n/g, ' '));
}

if (enabled('H')) {
  console.log('\n## H: 終了の停止（PR が無ければ 1 回止める。偽の gh を使う）');
  const bin = fakeBin('bin-h', { gh: `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo '[]'; exit 0; fi\necho "gh: poc では未対応" >&2\nexit 1\n` });
  for (const tool of tools) {
    const dir = deployedRepo(`h-${tool}`);
    git(dir, 'switch', '-q', '-c', 'dev/demo');
    for (const base of ['.claude/skills', '.agents/skills']) {
      fs.mkdirSync(path.join(dir, base, 'kiro-validate-impl'), { recursive: true });
      fs.writeFileSync(path.join(dir, base, 'kiro-validate-impl/SKILL.md'), skillText('kiro-validate-impl', '手順: 検証の結果を「GO」と 1 行で報告する。ファイルは作らない。'));
    }
    const since = Date.now() - 1000;
    const prompt = tool === 'claude' ? '/kiro-validate-impl demo' : '$kiro-validate-impl demo';
    const result = invoke(tool, dir, prompt, { extraPath: bin, tools: 'Bash,Read,Write,Edit,Agent,Skill' });
    check(`H ${tool}: 実行が成功した`, succeeded(result));
    fs.writeFileSync(path.join(scratch, `h-${tool}.out.txt`), `${result.stdout}\n${result.stderr}`);
    const states = workBranchStates(since).filter((st) => st.validated);
    observe(`H ${tool}: 検証後の状態`, JSON.stringify(states.map((st) => st.validated)));
    check(`H ${tool}: 検証の入力で状態が作られ、終了を 1 回止めた（停止済みになった）`, states.some((st) => st.validated.stopped === true));
    observe(`H ${tool}: 最終の答え`, finalAnswer(tool, result).slice(0, 220).replace(/\n/g, ' '));
  }
}

summary();
