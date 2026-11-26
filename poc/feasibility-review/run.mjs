#!/usr/bin/env node
// PoC（feasibility-review の設計の前提の確認）
//   A: 入力時の追加の文脈が、/kiro-validate-design（Codex は $kiro-validate-design）のレビューの出力に反映されるか
//   B: 子のレビュー役の起動（Claude Code の Agent・Codex の spawn_agent）の依頼文を PreToolUse で扱えるか
//      B1 依頼文に印が無ければ拒否し、理由で入れさせる（拒否→呼び直し）
//      B2 依頼文の末尾に印を足す（updatedInput）。子が受け取ったかは、子が最後の 1 行を引用して答えるので分かる
//   D: 同じ入力に複数のフックの追加の文脈が並ぶとき（feasibility-gate と work-branch-gate）、両方がモデルに届くか（両ツール）
//   C: 配置した feasibility-gate（init で導入）で、記録のない spec の /kiro-spec-tasks・/kiro-impl が入力の停止になり、通過の記録を書くと通るか（両ツール）
// 使い方: node poc/feasibility-review/run.mjs [A] [B]   認証済みの claude・codex、git、Node.js 22、cc-sdd の導入に使うネットワークが要る。
import fs from 'node:fs';
import path from 'node:path';
import { check, observe, summary, run, git, makeRepo, registerHooks, records, invoke, succeeded, finalAnswer, scratch } from '../work-branch-flow/common.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const want = process.argv.slice(2).map((s) => s.toUpperCase());
const enabled = (name) => want.length === 0 || want.includes(name);
const tools = ['claude', 'codex'];

/** 既存の登録（導入コマンドの init が書いたもの）に、PoC のフックを足す */
function addHooks(dir, entries) {
  for (const tool of tools) {
    const file = path.join(dir, tool === 'claude' ? '.claude/settings.json' : '.codex/hooks.json');
    const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    config.hooks ??= {};
    for (const { event, matcher, args } of entries) {
      const command = tool === 'claude' ? `node "$CLAUDE_PROJECT_DIR/.poc/probe.mjs" ${args}` : `node "$(git rev-parse --show-toplevel)/.poc/probe.mjs" ${args}`;
      (config.hooks[event] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 30 }] });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  }
}

function setupWithSkills(name) {
  const dir = makeRepo(name);
  const init = run(process.execPath, [path.join(repoRoot, 'bin/cc-sdd-bootstrap.mjs'), 'init'], { cwd: dir });
  if (init.status !== 0) throw new Error(`init に失敗: ${init.stderr}`);
  const install = run(process.execPath, ['.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs'], { cwd: dir });
  if (install.status !== 0) throw new Error(`cc-sdd の導入に失敗: ${install.stderr}`);
  const spec = path.join(dir, '.kiro/specs/demo');
  fs.mkdirSync(spec, { recursive: true });
  fs.writeFileSync(path.join(spec, 'spec.json'), `${JSON.stringify({
    feature_name: 'demo', language: 'ja', phase: 'design-generated',
    approvals: { requirements: { generated: true, approved: true }, design: { generated: true, approved: false }, tasks: { generated: false, approved: false } }, ready_for_implementation: false,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(spec, 'requirements.md'), '# 要件\n\n## 1. あいさつ\n1.1 コマンド `hello` は標準出力に「こんにちは」と 1 行出力する。\n1.2 引数 `--name X` があれば「こんにちは、X」と出力する。\n');
  fs.writeFileSync(path.join(spec, 'design.md'), '# 設計\n\n## 概要\nNode.js の単一ファイル `hello.mjs` で実装する。引数は `process.argv` を直接読む。\n\n## 前提\n- Node.js 22 が使える。\n- Codex は追加の文脈に必ず従う（根拠は無い）。\n\n## 要件の対応\n- 1.1・1.2: `hello.mjs`。\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'spec');
  return dir;
}

// ---- A: 追加の文脈がレビューに反映されるか ----
if (enabled('A')) {
  console.log('\n## A: /kiro-validate-design に追加の文脈を渡す');
  const marker = 'FEAS-CHECK-7F3A';
  const context = `実現性の観点（この設計のレビューに必ず適用する）: 設計の各前提に、一次資料（URL・版）か実機の PoC（再実行できるスクリプトと結果）の根拠があるかを確認する。レビューの出力の最後に「${marker}:」で始まる 1 行を付け、根拠の無い前提の数を書くこと。`;
  for (const tool of tools) {
    const dir = setupWithSkills(`fr-a-${tool}`);
    addHooks(dir, [{ event: 'UserPromptSubmit', args: `context:${context}` }]);
    const command = tool === 'claude' ? '/kiro-validate-design demo' : '$kiro-validate-design demo';
    const result = invoke(tool, dir, `${command}\n対話はせず、そのまま最後までレビューして結果を出してください。`, { tools: 'Bash,Read,Write,Edit,Glob,Grep,Agent' });
    check(`A ${tool}: 実行が成功した`, succeeded(result));
    const answer = finalAnswer(tool, result);
    observe(`A ${tool}: 最終の答えの末尾`, answer.slice(-240).replace(/\n/g, ' '));
    fs.writeFileSync(path.join(dir, '.poc/answer.txt'), answer);
    check(`A ${tool}: 追加の文脈の指示（${marker} の行）がレビューの出力に反映された`, answer.includes(marker));
    observe(`A ${tool}: 出力に「根拠」が現れた回数`, String((answer.match(/根拠/g) ?? []).length));
  }
}

// ---- B: 子の起動の依頼文を扱えるか ----
if (enabled('B')) {
  console.log('\n## B: 子（Agent・spawn_agent）の依頼文');
  const mark = '[[FEAS-7F3A]]';
  const parent = (tool, extra) => tool === 'claude'
    ? `Agent ツール（subagent_type は general-purpose、model は haiku）で子を 1 回だけ起動し、子に「受け取った依頼文の最後の 1 行を、そのまま引用して答えてください」と頼んでください。子の返事をそのまま報告してください。${extra}`
    : `spawn_agent を agent_type probe_quoter・fork_turns none・model gpt-6-luna で 1 回だけ使い、子に「受け取った依頼文の最後の 1 行を、そのまま引用して答えてください」と頼み、wait で子の返事を待って、その返事をそのまま報告してください。子の返事を推測で作らないでください。${extra}`;
  for (const [mode, label] of [['agent-require', 'B1 拒否して入れさせる'], ['agent-update', 'B2 末尾に足す（updatedInput）']]) {
    for (const tool of tools) {
      const dir = makeRepo(`fr-b-${mode}-${tool}`);
      fs.mkdirSync(path.join(dir, '.codex/agents'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.codex/agents/probe_quoter.toml'), 'name = "probe_quoter"\ndescription = "PoC 用。受け取った依頼文の最後の 1 行を引用して答える。"\ndeveloper_instructions = "受け取った依頼文の最後の 1 行を、そのまま引用して答える。それ以外は書かない。"\n');
      registerHooks(dir, [{ event: 'PreToolUse', matcher: tool === 'claude' ? 'Agent|Task' : '', args: `${mode}:${mark}` }]);
      const result = invoke(tool, dir, parent(tool, mode === 'agent-require' ? '拒否されたら理由に従って、もう 1 回だけ呼び直してください。' : ''));
      const list = records(dir).filter((r) => r.input?.hook_event_name === 'PreToolUse' && /Agent|Task|spawn_agent/.test(r.input.tool_name ?? ''));
      observe(`${label} ${tool}: 子の起動`, list.map((r) => `${r.input.tool_name}[keys=${Object.keys(r.input.tool_input ?? {}).join(',')}]${r.output?.hookSpecificOutput?.permissionDecision === 'deny' ? '(拒否)' : r.output ? '(更新)' : ''}`).join(' → '));
      const answer = finalAnswer(tool, result);
      observe(`${label} ${tool}: 最終の答え`, answer.slice(0, 200).replace(/\n/g, ' '));
      check(`${label} ${tool}: 子の起動を PreToolUse で観測できた`, list.length >= 1);
      if (mode === 'agent-require') {
        const denied = list.some((r) => r.output?.hookSpecificOutput?.permissionDecision === 'deny');
        const second = list.filter((r) => !r.output).at(0);
        check(`${label} ${tool}: 印の無い起動が拒否された`, denied);
        check(`${label} ${tool}: 呼び直しの依頼文に印が入った`, Boolean(second) && JSON.stringify(second.input.tool_input).includes(mark));
      } else {
        const updated = list.some((r) => r.output?.hookSpecificOutput?.updatedInput);
        observe(`${label} ${tool}: 更新を返した`, String(updated));
        const reached = answer.includes(mark);
        if (tool === 'claude') check(`${label} ${tool}: 子が印を受け取った（子の引用に印がある）`, reached);
        else observe(`${label} ${tool}: 子が印を受け取った（子の引用に印がある）`, String(reached));
      }
    }
  }
}

// ---- B3: フックを使わず、運用の区画の文章で親に依頼文へ入れさせる ----
if (enabled('B')) {
  console.log('\n## B3: 運用の区画の文章で、子の依頼文に観点を入れさせる（フックなし）');
  const mark = '[[FEAS-DOC-9C21]]';
  for (const tool of tools) {
    const dir = makeRepo(`fr-b3-${tool}`);
    fs.mkdirSync(path.join(dir, '.codex/agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex/agents/probe_quoter.toml'), 'name = "probe_quoter"\ndescription = "PoC 用。受け取った依頼文の最後の 1 行を引用して答える。"\ndeveloper_instructions = "受け取った依頼文の最後の 1 行を、そのまま引用して答える。それ以外は書かない。"\n');
    const rule = `\n## 運用の決まり\n- 子のエージェントを起動するときは、子への依頼文の最後の 1 行に、必ず ${mark} とだけ書く。\n`;
    fs.writeFileSync(path.join(dir, tool === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'), `# PoC${rule}`);
    registerHooks(dir, [{ event: 'PreToolUse', matcher: tool === 'claude' ? 'Agent|Task' : '', args: 'log' }]);
    const prompt = tool === 'claude'
      ? 'Agent ツール（subagent_type は general-purpose、model は haiku）で子を 1 回だけ起動し、子に「受け取った依頼文の最後の 1 行を、そのまま引用して答えてください」と頼んでください。子の返事をそのまま報告してください。'
      : 'spawn_agent を agent_type probe_quoter・fork_turns none・model gpt-6-luna で 1 回だけ使い、子に「受け取った依頼文の最後の 1 行を、そのまま引用して答えてください」と頼み、wait で子の返事を待って、その返事をそのまま報告してください。子の返事を推測で作らないでください。';
    const result = invoke(tool, dir, prompt);
    const answer = finalAnswer(tool, result);
    observe(`B3 ${tool}: 最終の答え`, answer.slice(0, 200).replace(/\n/g, ' '));
    check(`B3 ${tool}: 運用の決まりに従い、子が印を受け取った（子の引用に印がある）`, answer.includes(mark));
  }
}

// ---- C: 配置した入口の停止と通過（feasibility-review タスク 1.3） ----
if (enabled('C')) {
  console.log('\n## C: 配置した feasibility-gate（init で導入）の停止と通過');
  const skill = (name) => `---\nname: ${name}\ndescription: 確認用の手順書（${name}）\n---\n\n# ${name}\n\n手順: 「完了」と 1 行で答える。ファイルは作らない。\n`;
  const record = (design, tasks) => `# 実現性の記録: demo\n\n## 実機検証の要否\n- 判定: 必要\n- 理由: 確認用\n\n## 設計の確認\n- 判定: ${design}\n\n## タスク計画の確認\n- 判定: ${tasks}\n`;
  const BLOCKED = /実現性の確認が通っていません/;
  for (const tool of tools) {
    const dir = makeRepo(`c-${tool}`);
    const init = run(process.execPath, [path.join(repoRoot, 'bin/cc-sdd-bootstrap.mjs'), 'init'], { cwd: dir });
    check(`C ${tool}: init が成功し、配置物が入った`, init.status === 0 && fs.existsSync(path.join(dir, '.agent-hooks/cc-sdd-bootstrap/feasibility-gate.mjs')));
    const registered = [path.join(dir, '.claude/settings.json'), path.join(dir, '.codex/hooks.json')].map((f) => fs.readFileSync(f, 'utf8').includes('feasibility-gate.mjs'));
    check(`C ${tool}: 両ツールの登録に feasibility-gate がある`, registered.every(Boolean), registered.join(','));
    // cc-sdd を先に導入しておく（入力時の導入が走って、後の入力を「導入中」で止めないため）。その後、確認用に 2 つの手順書だけを差し替える
    const install = run(process.execPath, ['.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs'], { cwd: dir });
    check(`C ${tool}: cc-sdd の導入が成功した`, install.status === 0, String(install.stderr ?? '').trim().split('\n')[0]);
    for (const base of ['.claude/skills', '.agents/skills']) {
      for (const name of ['kiro-spec-tasks', 'kiro-impl']) {
        fs.mkdirSync(path.join(dir, base, name), { recursive: true });
        fs.writeFileSync(path.join(dir, base, name, 'SKILL.md'), skill(name));
      }
    }
    const specDir = path.join(dir, '.kiro/specs/demo');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'spec.json'), '{"feature_name":"demo"}\n');
    const sigil = tool === 'claude' ? '/' : '$';
    let seq = 0;
    const ask = (command) => {
      const result = invoke(tool, dir, `${sigil}${command} demo`, { tools: 'Bash,Read,Write,Edit,Skill' });
      const text = `${result.stdout}\n${result.stderr}`;
      fs.writeFileSync(path.join(scratch, `c-${tool}-${command}-${++seq}.out.txt`), text);
      return { text, answer: finalAnswer(tool, result), result };
    };
    const cases = [
      { command: 'kiro-spec-tasks', label: '記録なし', record: null, blocked: true },
      { command: 'kiro-spec-tasks', label: '設計が通過', record: record('通過', '未通過'), blocked: false },
      { command: 'kiro-impl', label: '設計だけ通過（タスク計画は未通過）', record: record('通過', '未通過'), blocked: true },
      { command: 'kiro-impl', label: 'タスク計画が通過', record: record('通過', '通過'), blocked: false },
    ];
    for (const c of cases) {
      if (c.record === null) fs.rmSync(path.join(specDir, 'feasibility.md'), { force: true });
      else fs.writeFileSync(path.join(specDir, 'feasibility.md'), c.record);
      const { text, answer } = ask(c.command);
      // Claude Code は停止の理由が出力に出る。Codex は理由が出ず、モデルの応答も作業も無い（入力の停止の既知の見え方）
      const wasBlocked = tool === 'claude' ? BLOCKED.test(text) : (answer === '' && !/"command_execution"/.test(text));
      observe(`C ${tool} ${c.command} (${c.label})`, `停止=${wasBlocked} 答え=${answer.slice(0, 60).replace(/\n/g, ' ')}`);
      check(`C ${tool}: ${c.command} は ${c.label} のとき${c.blocked ? '入力が止まる' : '通る'}`, wasBlocked === c.blocked);
      if (c.blocked) {
        if (tool === 'claude') check(`C ${tool}: 停止の理由に spec 名と記録の場所が入る`, /demo/.test(text) && /feasibility\.md/.test(text));
        else check(`C ${tool}: 停止のときはモデルの応答も作業も無い`, answer === '');
      } else {
        // 通ったときは、モデルが何かを答える（kiro-impl は work-branch-gate の拒否で別の答えになることがある）
        check(`C ${tool}: 通ったときはモデルが応答した`, answer.trim() !== '');
      }
    }
  }
}

// ---- D: 並んだ追加の文脈（feasibility-review タスク 5.1） ----
// 偽陽性を避けるため、2 つのフックの両方がある場合（full）と、片方を外した対照（no-branch・no-feas）を比べる。
// 答えは「追加の指示（フックが入力と一緒に出した案内）にあるものだけ」とし、CLAUDE.md・AGENTS.md の運用の区画や入力から推測しないよう指示する。
if (enabled('D')) {
  console.log('\n## D: 並んだ追加の文脈（kiro-impl の入力。feasibility-gate と work-branch-gate が同時に追加の文脈を出す。片方を外した対照つき）');
  const record = '# 実現性の記録: demo\n\n## 実機検証の要否\n- 判定: 必要\n- 理由: 確認用\n\n## 設計の確認\n- 判定: 通過\n\n## タスク計画の確認\n- 判定: 通過\n';
  const skill = `---\nname: kiro-impl\ndescription: 確認用の手順書（kiro-impl）\n---\n\n# kiro-impl\n\n手順: ツールは使わない。この入力と一緒に、フックが渡した「追加の指示（案内）」があるか確かめる。CLAUDE.md・AGENTS.md の運用の区画や、この手順書、入力から推測してはいけない。追加の指示に実際に書かれているものだけを、次の形で答える。\n1 行目「基底: <追加の指示に「現在のブランチ 「…」 は基底ブランチです」とあれば、その「…」の中のブランチ名。無ければ なし>」\n2 行目「記録: <追加の指示に、実現性の記録に関する案内（判定の語『通過』『未通過』を使う書式の説明）があれば あり。無ければ なし>」\n`;
  const variants = [
    { id: 'full', label: '両方のフックあり', expectBranch: true, expectRecord: true },
    { id: 'no-branch', label: '作業前のブランチ確保を設定で無効（対照）', expectBranch: false, expectRecord: true },
    { id: 'no-feas', label: '実現性のフックを外す（対照）', expectBranch: true, expectRecord: false },
  ];
  for (const tool of tools) {
    for (const v of variants) {
      const dir = makeRepo(`d-${tool}-${v.id}`);
      const init = run(process.execPath, [path.join(repoRoot, 'bin/cc-sdd-bootstrap.mjs'), 'init'], { cwd: dir });
      const install = run(process.execPath, ['.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs'], { cwd: dir });
      check(`D ${tool} ${v.id}: init と cc-sdd の導入が成功した`, init.status === 0 && install.status === 0);
      if (v.id === 'no-branch') {
        const file = path.join(dir, '.cc-sdd-bootstrap.json');
        const config = JSON.parse(fs.readFileSync(file, 'utf8'));
        config.workflow = { ...(config.workflow ?? {}), branchGate: false };
        fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
      }
      if (v.id === 'no-feas') {
        for (const f of ['.claude/settings.json', '.codex/hooks.json']) {
          const text = fs.readFileSync(path.join(dir, f), 'utf8');
          const config = JSON.parse(text);
          for (const entries of Object.values(config.hooks ?? {})) {
            for (const entry of entries) entry.hooks = (entry.hooks ?? []).filter((h) => !String(h.command).includes('feasibility-gate.mjs'));
          }
          fs.writeFileSync(path.join(dir, f), `${JSON.stringify(config, null, 2)}\n`);
        }
      }
      for (const base of ['.claude/skills', '.agents/skills']) {
        fs.mkdirSync(path.join(dir, base, 'kiro-impl'), { recursive: true });
        fs.writeFileSync(path.join(dir, base, 'kiro-impl/SKILL.md'), skill);
      }
      const specDir = path.join(dir, '.kiro/specs/demo');
      fs.mkdirSync(specDir, { recursive: true });
      fs.writeFileSync(path.join(specDir, 'spec.json'), '{"feature_name":"demo"}\n');
      fs.writeFileSync(path.join(specDir, 'feasibility.md'), record);
      const sigil = tool === 'claude' ? '/' : '$';
      const result = invoke(tool, dir, `${sigil}kiro-impl demo`, { tools: 'Bash,Read,Write,Edit,Skill' });
      const answer = finalAnswer(tool, result);
      fs.writeFileSync(path.join(scratch, `d-${tool}-${v.id}.out.txt`), `${result.stdout}\n${result.stderr}`);
      observe(`D ${tool} ${v.id} (${v.label}): 答え`, answer.replace(/\n/g, ' / ').slice(0, 240));
      const gotBranch = /基底[:：]\s*[`「]?develop/.test(answer);
      const gotRecord = /記録[:：]\s*あり/.test(answer);
      check(`D ${tool} ${v.id}: 応答があった`, succeeded(result) && answer.trim() !== '');
      check(`D ${tool} ${v.id}: 作業前のブランチ確保の案内（現在のブランチ名 develop を含む）が${v.expectBranch ? '届いた' : '届かない'}`, gotBranch === v.expectBranch);
      check(`D ${tool} ${v.id}: 実現性の記録の案内が${v.expectRecord ? '届いた' : '届かない'}`, gotRecord === v.expectRecord);
    }
  }
}

summary();
