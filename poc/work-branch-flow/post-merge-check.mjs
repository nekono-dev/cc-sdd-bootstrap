// 取り込み後の確認（work-branch-flow・feasibility-review のタスク 5.3）:
//   新しく clone した develop の普通の checkout と worktree で `update` を実行し、実機（Claude Code・Codex）で次を確かめる。
//   W1 基底ブランチ上の /kiro-discovery が拒否・案内され、基底ブランチには brief.md が入らない
//   W2 作業ブランチの worktree では /kiro-discovery が通り、worktree に brief.md が作られる
//   W3 作業ブランチの worktree で /kiro-validate-impl の後、PR が無ければ終了が 1 回止まる（偽の gh）
//   F1 記録（feasibility.md）の無い spec への /kiro-spec-tasks が止まり、通過の記録があれば通る（worktree から本体の spec を見つける）
// 使い方: node poc/work-branch-flow/post-merge-check.mjs   認証済みの claude・codex と、リポジトリへの git の取得権限が要る（POC_REPO・POC_BRANCH で取得元を変えられる）。
//   Codex は一時の CODEX_HOME・HOME を使い、`update` が書いた承認の記録だけでフックを動かす（承認を省く指定は使わない）。実際の ~/.codex/config.toml は変更しない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, observe, summary, run, git, invoke, finalAnswer, succeeded } from './common.mjs';

const here = path.resolve(import.meta.dirname, '../..');
const origin = process.env.POC_REPO ?? run('git', ['-C', here, 'remote', 'get-url', 'origin']).stdout.trim();
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wbf53-'));
const stateDir = path.join(os.tmpdir(), 'cc-sdd-bootstrap-work-branch');
const stub = (name, body) => `---\nname: ${name}\ndescription: 確認用の手順書（${name}）\n---\n\n# ${name}\n\n${body}\n`;
const record = (design, tasks) => `# 実現性の記録: feas\n\n## 実機検証の要否\n- 判定: 必要\n- 理由: 確認用\n\n## 設計の確認\n- 判定: ${design}\n\n## タスク計画の確認\n- 判定: ${tasks}\n`;

function stubs(dir) {
  const bodies = {
    'kiro-discovery': '手順: `.kiro/specs/demo/brief.md` というファイルを作り、内容を `# Brief: demo` の 1 行にして、「完了」と答える。',
    'kiro-validate-impl': '手順: 検証の結果を「GO」と 1 行で報告する。ファイルは作らない。',
    'kiro-spec-tasks': '手順: ツールは使わず「完了」と答える。',
  };
  for (const skills of ['.claude/skills', '.agents/skills']) {
    for (const [name, body] of Object.entries(bodies)) {
      fs.mkdirSync(path.join(dir, skills, name), { recursive: true });
      fs.writeFileSync(path.join(dir, skills, name, 'SKILL.md'), stub(name, body));
    }
  }
}

/** 実機の Codex を 1 回起動する（承認の記録は update が一時の CODEX_HOME に書いたものを使う） */
function codex(dir, prompt, home, extraPath) {
  const h = path.join(base, 'h');
  const env = { ...process.env, CODEX_HOME: home, HOME: h };
  if (extraPath) env.PATH = `${extraPath}:${env.PATH}`;
  return run('codex', ['-a', 'never', 'exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '--cd', dir, prompt], { cwd: dir, env });
}
function claude(dir, prompt, extraPath) {
  return invoke('claude', dir, prompt, { extraPath, tools: 'Bash,Read,Write,Edit,Agent,Skill' });
}

const tools = ['claude', 'codex'];
const fakeBin = path.join(base, 'bin');
fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, 'gh'), `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo '[]'; exit 0; fi\necho "gh: poc では未対応" >&2\nexit 1\n`, { mode: 0o755 });

const homes = {};
/** 新しい clone（普通の checkout）と worktree を作り、両方で update を実行する */
function setup(name) {
  const repo = fs.realpathSync((() => { const d = path.join(base, name); fs.mkdirSync(d); return d; })());
  const normal = path.join(repo, 'normal');
  const r = run('git', ['clone', '-q', '--branch', process.env.POC_BRANCH ?? 'develop', origin, normal]);
  if (r.status !== 0) throw new Error(`clone 失敗: ${r.stderr}`);
  git(normal, 'config', 'user.email', 'poc@example.com');
  git(normal, 'config', 'user.name', 'poc');
  const wt = path.join(repo, 'wt');
  const w = git(normal, 'worktree', 'add', '-q', '-b', 'dev/demo', wt);
  if (w.status !== 0) throw new Error(`worktree 失敗: ${w.stderr}`);
  const h = path.join(base, 'h');
  fs.mkdirSync(h, { recursive: true });
  const home = path.join(repo, 'codex-home');
  fs.mkdirSync(home);
  fs.copyFileSync(path.join(os.homedir(), '.codex/auth.json'), path.join(home, 'auth.json'));
  fs.chmodSync(path.join(home, 'auth.json'), 0o600);
  fs.writeFileSync(path.join(home, 'config.toml'), [normal, wt].map((p) => `[projects.${JSON.stringify(p)}]\ntrust_level = "trusted"\n`).join('\n'));
  homes[name] = home;
  const env = { ...process.env, CODEX_HOME: home, HOME: h, CC_SDD_BOOTSTRAP_NPX_TIMEOUT_MS: '5000' };
  const u1 = run(process.execPath, [path.join(normal, 'bin/cc-sdd-bootstrap.mjs'), 'update'], { cwd: normal, env });
  const u2 = run(process.execPath, [path.join(wt, 'bin/cc-sdd-bootstrap.mjs'), 'update'], { cwd: wt, env });
  check(`${name}: 普通の checkout と worktree で update が成功した`, u1.status === 0 && u2.status === 0, `${u1.status}/${u2.status}`);
  stubs(normal);
  stubs(wt);
  const cfg = JSON.parse(fs.readFileSync(path.join(normal, '.cc-sdd-bootstrap.json'), 'utf8'));
  check(`${name}: 設定に workflow（作業ブランチと PR）が入り、フックが登録されている`, cfg.workflow?.branchGate === true
    && fs.readFileSync(path.join(normal, '.claude/settings.json'), 'utf8').includes('work-branch-gate.mjs')
    && fs.readFileSync(path.join(normal, '.codex/hooks.json'), 'utf8').includes('feasibility-gate.mjs'));
  return { normal, wt, home };
}
function states(since) {
  if (!fs.existsSync(stateDir)) return [];
  return fs.readdirSync(stateDir).map((f) => path.join(stateDir, f)).filter((f) => fs.statSync(f).mtimeMs >= since)
    .map((f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }).filter(Boolean);
}
const sigil = (tool) => (tool === 'claude' ? '/' : '$');
const ask = (tool, dir, home, prompt, extraPath) => {
  const result = tool === 'claude' ? claude(dir, prompt, extraPath) : codex(dir, prompt, home, extraPath);
  const text = `${result.stdout}\n${result.stderr}`;
  fs.writeFileSync(path.join(base, `${tool}-${Date.now()}.out.txt`), text);
  return { result, text, answer: finalAnswer(tool, result) };
};

for (const tool of tools) {
  console.log(`\n## ${tool}`);
  // W1: 基底ブランチ上の入力
  {
    const { normal, home } = setup(`w1-${tool}`);
    const { result, text } = ask(tool, normal, home, `${sigil(tool)}kiro-discovery demo 作業用ブランチは dev/demo2 にしてよい。`);
    const where = [normal, ...git(normal, 'worktree', 'list', '--porcelain').stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))]
      .find((d) => fs.existsSync(path.join(d, '.kiro/specs/demo/brief.md')));
    const branch = where ? git(where, 'branch', '--show-current').stdout.trim() : '-';
    observe(`W1 ${tool}: 拒否の理由が会話に現れた`, String(/作業用ブランチ|基底ブランチ/.test(text)));
    observe(`W1 ${tool}: brief.md の場所`, where ? `${where} (${branch})` : '作られなかった');
    check(`W1 ${tool}: 実行が成功した`, succeeded(result));
    check(`W1 ${tool}: 基底ブランチ（develop）の上では brief.md が作られなかった`, !(where && branch === 'develop'), `branch=${branch}`);
    check(`W1 ${tool}: 拒否・案内が届いた（作業ブランチへ移ったか、理由を伝えて止まった）`, /作業用ブランチ|基底ブランチ/.test(text) && (Boolean(where) || /読み取り専用|作成でき|作れません/.test(finalAnswer(tool, result))), `where=${where ?? '-'}`);
  }
  // W2・W3・F1: 作業ブランチの worktree
  const { normal, wt, home } = setup(`w2-${tool}`);
  {
    const { result, answer } = ask(tool, wt, home, `${sigil(tool)}kiro-discovery demo`);
    check(`W2 ${tool}: 実行が成功した`, succeeded(result));
    check(`W2 ${tool}: 作業ブランチ（dev/demo）の worktree では通り、brief.md が worktree に作られた`, fs.existsSync(path.join(wt, '.kiro/specs/demo/brief.md')) && !fs.existsSync(path.join(normal, '.kiro/specs/demo/brief.md')));
    observe(`W2 ${tool}: 最終の答え`, answer.slice(0, 120).replace(/\n/g, ' '));
  }
  {
    const since = Date.now() - 1000;
    const { result } = ask(tool, wt, home, `${sigil(tool)}kiro-validate-impl demo`, fakeBin);
    check(`W3 ${tool}: 実行が成功した`, succeeded(result));
    const st = states(since).filter((s) => s.validated);
    observe(`W3 ${tool}: 検証後の状態`, JSON.stringify(st.map((s) => s.validated)));
    check(`W3 ${tool}: PR が無いので終了が 1 回止まった（停止済みになった）`, st.some((s) => s.validated.stopped === true));
  }
  {
    // spec は本体の checkout にだけ置く（worktree から見つけられるか。W2 が worktree に作った demo とは別名にする）
    const specDir = path.join(normal, '.kiro/specs/feas');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'spec.json'), '{"feature_name":"feas"}\n');
    for (const c of [
      { label: '記録なし', rec: null, blocked: true },
      { label: '設計・タスク計画とも通過', rec: record('通過', '通過'), blocked: false },
    ]) {
      if (c.rec === null) fs.rmSync(path.join(specDir, 'feasibility.md'), { force: true }); else fs.writeFileSync(path.join(specDir, 'feasibility.md'), c.rec);
      const { text, answer } = ask(tool, wt, home, `${sigil(tool)}kiro-spec-tasks feas`);
      // Claude Code は停止の理由が出力に出る。Codex は理由が出ず、モデルの応答も作業も無い
      const blocked = tool === 'claude' ? /実現性の確認が通っていません/.test(text) : (answer === '' && !/"command_execution"/.test(text));
      observe(`F1 ${tool} (${c.label})`, `停止=${blocked} 答え=${answer.slice(0, 60).replace(/\n/g, ' ')}`);
      check(`F1 ${tool}: worktree から ${c.label} の spec への /kiro-spec-tasks が${c.blocked ? '止まる' : '通る'}`, blocked === c.blocked);
    }
  }
}
summary();
if (!process.env.POC_KEEP) fs.rmSync(base, { recursive: true, force: true });
else console.log(`作業ディレクトリ: ${base}`);
