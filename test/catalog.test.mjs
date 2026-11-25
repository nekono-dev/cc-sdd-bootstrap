import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { catalog, DEPLOY_DIR, CONFIG_PATH, CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH, AGENT_SECTION_FILES, AGENT_DOCS } from "../lib/catalog.mjs";
import pkg from "../package.json" with { type: "json" };

function excludedBy(line, file) {
  const source = line.replace(/^\//, "").replace(/\/$/, "").split("*")
    .map((part) => part.split(".").join("\\."))
    .join("[^/]*");
  return new RegExp("^" + source + "(?:/.*)?$").test(file);
}

test("カタログの配置ファイルが存在し、配布範囲に含まれる", () => {
  for (const file of catalog.files) {
    assert.ok(file.path.startsWith(`${DEPLOY_DIR}/`));
    assert.ok(fs.existsSync(path.resolve(file.path)), file.path);
    assert.ok(pkg.files.includes(file.path), file.path);
  }
  assert.equal(catalog.files.some((file) => file.path.includes("/skills/")), false);
});

test("カタログには記録や旧形式のファイル指定がない", () => {
  for (const file of catalog.files) assert.deepEqual(Object.keys(file), ["path"]);
});

test("区画の文章は導入・手順書・独自の決まりを案内する", () => {
  assert.ok(catalog.gitignore.includes("/CLAUDE.md"));
  assert.ok(catalog.gitignore.includes("/AGENTS.md"));
  for (const tool of ["claude", "codex"]) {
    const section = catalog.agentSections.map((item) => item[tool]).join("\n");
    assert.match(section, /\.kiro\/steering/);
    assert.match(section, /git で確認/);
    assert.ok(AGENT_SECTION_FILES[tool].startsWith(`${DEPLOY_DIR}/`));
  }
  assert.deepEqual([CONFIG_PATH, CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH].length, 3);
});

test("配置ファイルの道筋は配置先の通常ファイルで、上位移動を含まない", () => {
  for (const file of catalog.files) {
    assert.ok(file.path.startsWith(DEPLOY_DIR + "/"), file.path);
    assert.ok(!file.path.split("/").includes(".."), file.path);
    assert.ok(fs.statSync(path.resolve(file.path)).isFile(), file.path);
  }
});

test("配置物は lib/ を読み込まない", () => {
  for (const file of catalog.files) {
    const source = fs.readFileSync(path.resolve(file.path), "utf8");
    assert.ok(!/(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'][^"']*\blib\//.test(source), file.path);
  }
});

test("新しいフックと除外行が設計どおりで、共有物や設定を除外しない", () => {
  const installHooks = [
    { tools: ["claude"], event: "SessionStart", script: "install-cc-sdd.mjs", args: ["session-start", "--tool", "claude"], timeout: 30 },
    { tools: ["codex"], event: "SessionStart", script: "install-cc-sdd.mjs", args: ["session-start", "--tool", "codex"], timeout: 30 },
    { tools: ["claude"], event: "UserPromptSubmit", script: "install-cc-sdd.mjs", args: ["user-prompt-submit", "--tool", "claude"], timeout: 600 },
    { tools: ["codex"], event: "UserPromptSubmit", script: "install-cc-sdd.mjs", args: ["user-prompt-submit", "--tool", "codex"], timeout: 600 },
  ];
  assert.deepEqual(catalog.hooks.slice(0, installHooks.length), installHooks);
  const gateHooks = catalog.hooks.filter((hook) => hook.script === "kiro-gate.mjs");
  assert.deepEqual(gateHooks, ["claude", "codex"].flatMap((tool) => [
    { tools: [tool], event: "SessionStart", script: "kiro-gate.mjs", args: ["session-start", "--tool", tool], timeout: 10 },
    { tools: [tool], event: "UserPromptSubmit", script: "kiro-gate.mjs", args: ["user-prompt-submit", "--tool", tool], timeout: 10 },
    { tools: [tool], event: "PreToolUse", script: "kiro-gate.mjs", args: ["pre-tool-use", "--tool", tool], timeout: 10 },
    { tools: [tool], event: "PostToolUse", script: "kiro-gate.mjs", args: ["post-tool-use", "--tool", tool], timeout: 10 },
    { tools: [tool], event: "Stop", script: "kiro-gate.mjs", args: ["stop", "--tool", tool], timeout: 10 },
  ]));
  assert.ok(catalog.hooks.findIndex((hook) => hook.script === "kiro-gate.mjs" && hook.event === "UserPromptSubmit") >
    catalog.hooks.findIndex((hook) => hook.script === "install-cc-sdd.mjs" && hook.event === "UserPromptSubmit"));
  assert.deepEqual(catalog.gitignore, [
    ".claude/skills/kiro-*/", ".agents/skills/kiro-*/", ".kiro/settings/", "/CLAUDE.md", "/AGENTS.md", "/.cache/",
  ]);
  const protectedPaths = [
    CONFIG_PATH, ...catalog.files.map((file) => file.path), CLAUDE_SETTINGS_PATH, CODEX_HOOKS_PATH,
    ".kiro/specs/installer-core/requirements.md", ".kiro/steering/product.md",
  ];
  for (const line of catalog.gitignore) {
    for (const file of protectedPaths) {
      assert.ok(!excludedBy(line, file), line + " -> " + file);
    }
  }
  for (const file of [".claude/skills/kiro-x/SKILL.md", ".agents/skills/kiro-x/SKILL.md", ".kiro/settings/config.json", "CLAUDE.md", "AGENTS.md", ".cache/cc-sdd-install.failed"]) {
    assert.ok(catalog.gitignore.some((line) => excludedBy(line, file)), file);
  }
  for (const file of [".claude/skills/my-skill/SKILL.md", ".agents/skills/my-skill/SKILL.md", ".kiro/specs/x.md", ".kiro/steering/product.md", ".claude/settings.json", ".codex/hooks.json"]) {
    assert.ok(!catalog.gitignore.some((line) => excludedBy(line, file)), file);
  }
});

test("kiro-gate の案内は要件の対応表と両ツール向けの手順を示す", () => {
  const section = catalog.agentSections.find((item) => item.id === "kiro-gate");
  assert.ok(section);
  const table = [
    ["新機能・新プロジェクトの相談、分割の検討", "kiro-discovery"],
    ["次にやること・進み具合の確認", "kiro-spec-status"],
    ["既存コードと要件の差の確認", "kiro-validate-gap"],
    ["設計のレビュー", "kiro-validate-design"],
    ["実装後の最終確認", "kiro-validate-impl"],
    ["プロジェクトの方針の整備・更新", "kiro-steering"],
    ["完了・成功と報告する前", "kiro-verify-completion"],
  ];
  const markdownTable = [
    "| 依頼の種類 | 使うスキル |",
    "|---|---|",
    ...table.map(([kind, skill]) => `| ${kind} | \`${skill}\` |`),
  ].join("\n");
  for (const tool of ["claude", "codex"]) {
    assert.ok(section[tool].includes(markdownTable), `${tool}: 対応表が連続した Markdown 表であること`);
    for (const phrase of ["/kiro-*", "対応する手順書", "最後まで", "依頼の種類", "尋ねてください", "他の作業ツール", "フックが有効"]) {
      assert.ok(section[tool].includes(phrase), `${tool}: ${phrase}`);
    }
  }
  assert.equal(section.claude.includes("フックの信頼が承認されていない環境でも"), false);
  assert.equal(section.codex.includes("フックの信頼が承認されていない環境でも"), true);
  assert.ok(section.claude.includes(".claude/skills/<スキル名>/SKILL.md"));
  assert.ok(section.codex.includes(".agents/skills/<スキル名>/SKILL.md"));
  assert.match(section.codex, /信頼が承認されていない環境でも.*作業の前/s);
  assert.doesNotMatch(section.claude, /信頼が承認されていない環境でも/);
});

test("kiro-gate の配置物が package.json の配布範囲にも含まれる", () => {
  for (const name of ["kiro-gate.mjs", "kiro-gate-rules.mjs"]) {
    const file = `${DEPLOY_DIR}/${name}`;
    assert.ok(catalog.files.some((entry) => entry.path === file));
    assert.ok(pkg.files.includes(file));
  }
});

test("session-install の区画は両ツールの導入案内を持ち Codex だけに信頼の注意を含む", () => {
  const section = catalog.agentSections.find((item) => item.id === "session-install");
  assert.ok(section);
  for (const tool of ["claude", "codex"]) {
    const body = section[tool];
    for (const phrase of ["起動前", "最初の入力", "省", "kiro-", "未完了", "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs", tool === "claude" ? ".claude/skills/<名前>/SKILL.md" : ".agents/skills/<名前>/SKILL.md", "手順書", "開発作業を進めない", ".kiro/steering/"]) {
      assert.ok(body.includes(phrase), `${tool}: ${phrase}`);
    }
  }
  assert.match(section.codex, /信頼/);
  assert.match(section.codex, /機械的/);
  assert.match(section.codex, /失敗・未完了/);
  assert.doesNotMatch(section.claude, /信頼|機械的/);
});

test("運用区画に標準文書の見出しを複製せず、道筋と目印がそろう", () => {
  assert.deepEqual(AGENT_DOCS, { claude: "CLAUDE.md", codex: "AGENTS.md" });
  assert.equal(AGENT_SECTION_FILES.claude, DEPLOY_DIR + "/agent-section-claude.md");
  assert.equal(AGENT_SECTION_FILES.codex, DEPLOY_DIR + "/agent-section-codex.md");
  assert.ok(catalog.agentSections.length > 0);
  for (const item of catalog.agentSections) {
    for (const body of [item.claude, item.codex]) {
      assert.ok(body.includes(".kiro/steering/"));
      assert.ok(!body.includes("# Agentic SDLC and Spec-Driven Development"));
      assert.ok(!body.includes("## cc-sdd の標準の決まり"));
    }
  }
});

test("subagent-delegation のスクリプト・フック・生成物が登録され、配る範囲に含まれる", () => {
  for (const name of ["subagent-check.mjs", "delegate.mjs", "subagent-roles.mjs"]) {
    const file = `${DEPLOY_DIR}/${name}`;
    assert.ok(catalog.files.some((item) => item.path === file), file);
    assert.ok(pkg.files.includes(file), file);
  }
  const claude = catalog.hooks.find((hook) => hook.script === "subagent-check.mjs" && hook.tools.includes("claude"));
  assert.deepEqual(claude, { tools: ["claude"], event: "PreToolUse", matcher: "Agent", script: "subagent-check.mjs", args: ["pre-tool-use", "--tool", "claude"], timeout: 10 });
  const codex = catalog.hooks.find((hook) => hook.script === "subagent-check.mjs" && hook.tools.includes("codex"));
  assert.deepEqual(codex, { tools: ["codex"], event: "PreToolUse", script: "subagent-check.mjs", args: ["pre-tool-use", "--tool", "codex"], timeout: 10 });
  const generated = catalog.generated.find((item) => item.id === "subagent-definitions");
  assert.deepEqual(generated.owns, [".claude/agents/cc-sdd-*.md", ".codex/agents/cc_sdd_*.toml"]);
  const rendered = generated.render({});
  assert.equal(rendered.files.filter((file) => file.path.startsWith(".claude/agents/")).length, 12);
  assert.deepEqual(rendered.files.filter((file) => file.path.startsWith(".codex/agents/")).map((file) => file.path), [".codex/agents/cc_sdd_implement.toml"]);
});

test("承認の記録の 2 ファイルが配置一覧と配る範囲に登録される", () => {
  for (const name of ["codex-trust.mjs", "codex-trust-rules.mjs"]) {
    const file = `${DEPLOY_DIR}/${name}`;
    assert.ok(catalog.files.some((item) => item.path === file), file);
    assert.ok(pkg.files.includes(file), file);
  }
});

test("subagent-delegation の区画に分担・目安・流れ・読み替え・拒否時の扱いが入り、ツールごとの文章が他方に入らない", () => {
  const section = catalog.agentSections.find((item) => item.id === "subagent-delegation");
  assert.ok(section);
  const common = [
    "| 指揮役 | 実装・修正 | レビュー・デバッグ | 調査 |", "| Haiku（1） | 指揮役自身 | Luna | Luna |", "| Astra（4） | Sol | Opus | Sonnet |",
    "上限", "格 4", "medium", "high", "low", "複雑な調査", "1 つ上", "費用", "重大度", "強制しない",
    "別の提供元のレビュー 1 回", "同じ実装役が修正", "指摘箇所だけ再確認", "設計をレビュー", "判断を含む確認", "レビュー役", "原因調査", "テストで確かめ", "別のレビューを重ねない",
    "やり直さず", "差分", "未確認", "--orchestrator-model", "--resolve-model", "--to same", "レビューは 1 回",
    "~/.cache/cc-sdd-bootstrap-scratch/", "/tmp", "禁止する操作", "成果物の形式", "CLAUDE.md・AGENTS.md を読むことに頼らない",
    "書き込みは 1 つずつ", "読み取り専用の子も重ねない", "1 度だけ", "代わりに進めず", "利用者が許可する", "別の提供元が使えるまで待つ", "直接進めることを利用者が認める",
    "前もって与えない", "利用者の許可を求めない", ".kiro/steering/",
  ];
  for (const tool of ["claude", "codex"]) {
    for (const phrase of common) assert.ok(section[tool].includes(phrase), `${tool}: ${phrase}`);
    const commands = section[tool].match(/node \.agent-hooks\/cc-sdd-bootstrap\/delegate\.mjs[^\n`]*/g) ?? [];
    assert.ok(commands.length >= 3, `${tool}: 入口のコマンドの例が 3 つ以上`);
    for (const command of commands) assert.ok(command.includes("--orchestrator-model <今の自分のモデル>"), `${tool}: ${command}`);
    assert.ok(commands.some((c) => c.includes("--resolve-model")));
    assert.ok(commands.some((c) => c.includes("--to same") && !c.includes("--resolve-model")));
    assert.ok(commands.some((c) => !c.includes("--to same") && !c.includes("--resolve-model")));
    assert.ok(commands.every((c) => !/--to (?!same)/.test(c)));
  }
  const claudeOnly = ["CLAUDE_CODE_EFFORT_LEVEL", "subagent_type", "--effort <値>", "起動ごとに推論量を変えられず"];
  const codexOnly = ["`agent_type`", "cc_sdd_implement", "reasoning_effort", "fork_turns", "network_access=true", "通信の許可", "フックの信頼が承認されていない", "定義が優先"];
  for (const phrase of claudeOnly) { assert.ok(section.claude.includes(phrase), `claude: ${phrase}`); assert.ok(!section.codex.includes(phrase), `codex に入らない: ${phrase}`); }
  for (const phrase of codexOnly) { assert.ok(section.codex.includes(phrase), `codex: ${phrase}`); assert.ok(!section.claude.includes(phrase), `claude に入らない: ${phrase}`); }
});

test("subagent-delegation の区画は役割ごとのコマンド・候補が無い場合・推論量の上限の順・再試行の範囲・出力の形を正しく示す", () => {
  const section = catalog.agentSections.find((item) => item.id === "subagent-delegation");
  for (const tool of ["claude", "codex"]) {
    const body = section[tool];
    const commands = body.match(/node \.agent-hooks\/cc-sdd-bootstrap\/delegate\.mjs[^\n`]*/g) ?? [];
    for (const role of ["review", "debug", "investigate"]) {
      assert.ok(commands.some((c) => c.includes(`--role ${role} `) && !c.includes("--resolve-model") && !c.includes("--to same")), `${tool}: --role ${role} の委任の例`);
    }
    assert.ok(commands.some((c) => c.includes("--to same") && c.includes("--role review")), `${tool}: 同じ提供元の review の例`);
    assert.match(body, /デバッグの原因調査は `--role debug`/);
    assert.match(body, /調査は `--role investigate`/);
    assert.match(body, /レビューは `--role review`/);
    assert.ok(body.includes("同じ提供元に候補が無い（入口が指揮役自身で行うよう示す）ときは、その作業を指揮役が自分で行う"));
    assert.match(body, /subagents\.maxEffort\.<系統>.*subagents\.maxEffort\.default.*`high`/s);
    assert.ok(body.includes("subagents.maxModel.<提供元>"));
    assert.match(body, /指摘があるときだけ/);
    assert.match(body, /読み取り専用/);
    assert.match(body, /別の提供元による確認を兼ね/);
    assert.match(body, /組み込みの子の起動が利用環境の許可の判定で拒否された場合に限/);
    assert.match(body, /入口.*指示のファイル.*標準入力.*対象外/s);
    assert.ok(body.includes("`<名前> <推論量>`"));
    assert.ok(body.includes("`model`"));
  }
  assert.match(section.claude, /先頭の名前を `subagent_type`/);
  assert.match(section.codex, /名前を `model`、推論量.*を `reasoning_effort`/s);
  assert.match(section.codex, /`model` を明示すれば定義が無くても未指定の理由では拒否されず/);
  assert.match(section.codex, /`cc_sdd_implement` を指定しても `model` が無ければ拒否/);
  assert.doesNotMatch(section.codex, /--model <指揮役と異なるモデル>/);
  assert.match(section.codex, /--model <指揮役と異なり指揮役の格以下かつ子の上限以下のモデル>/);
});

test("subagent-delegation の Claude Code の文章は、モデル未指定の拒否の条件を正確に述べる", () => {
  const section = catalog.agentSections.find((item) => item.id === "subagent-delegation");
  assert.ok(section.claude.includes("起動の引数と定義のどちらにもモデルが無い起動は、未指定として拒否され、使う定義の名前を求めるコマンドが示される"));
  assert.doesNotMatch(section.claude, /名前を付けない起動/);
  assert.doesNotMatch(section.codex, /名前を付けない起動/);
});

// 文章の中の 1 項目を取り出す。項目は Codex の session-install では段落（"\n\n"）、委任の運用では行（"\n"）で区切られる
function pieceContaining(text, marker, separator) {
  return text.split(separator).find((piece) => piece.includes(marker)) ?? "";
}

// Codex の承認の項目に必要な要素。すべて同じ 1 項目の中になければならない
const CODEX_TRUST_CHECKS = [
  /承認の記録は導入・更新（`init`・`update`）と起動前の導入で自動で書かれます/,
  /`codex\.trustHooks` が false なら書かれません/,
  /「Hooks need review」の画面で承認/,
  /`codex exec` は未承認のフックを黙って飛ばします/,
  /プロジェクトを Codex が信頼していないとフックは読まれない/,
  /`codex exec --trust`/,
  /シンボリックリンク経由.*効かない場合/,
  /クラウド.*書けない場合/,
];

// 委任の承認を省く指定の項目に必要な要素
const DELEGATE_TRUST_CHECKS = [
  /`codex\.trustHooks` が false でなければ/,
  /その起動の間だけ/,
  /設定ファイルには保存されません/,
  /この Codex が指定を受け付けないときは子を起動せず案内します/,
];

function matchesAll(text, checks) {
  return checks.every((check) => check.test(text));
}

// 逆転の変異: 各句を意味が反対の句に置き換えた文章。検査は必ず落ちなければならない
const CODEX_TRUST_MUTATIONS = [
  ["書かれます", "書かれません"],
  ["false なら書かれません", "true なら書かれません"],
  ["「Hooks need review」の画面で承認", "「Hooks need review」の画面では承認しない"],
  ["黙って飛ばします", "実行します"],
  ["信頼していないと", "信頼していれば"],
  ["`codex exec --trust`", "`codex exec --no-trust`"],
  ["効かない場合", "効く場合"],
  ["書けない場合", "書ける場合"],
];

const DELEGATE_TRUST_MUTATIONS = [
  ["false でなければ", "false なら"],
  ["その起動の間だけ", "常に"],
  ["設定ファイルには保存されません", "設定ファイルに保存されます"],
  ["子を起動せず案内します", "子を起動します"],
];

test("Codex の session-install の承認の項目は各要素を同じ 1 項目に含み、句を逆転すると検査が落ちる", () => {
  const section = catalog.agentSections.find((item) => item.id === "session-install");
  assert.ok(section);
  const item = pieceContaining(section.codex, "Hooks need review", "\n\n");
  assert.notEqual(item, "", "承認の項目が見つかる");
  assert.equal(matchesAll(item, CODEX_TRUST_CHECKS), true, "正しい文章は検査を通る");
  for (const [from, to] of CODEX_TRUST_MUTATIONS) {
    assert.ok(item.includes(from), `変異の元の句がある: ${from}`);
    const mutated = item.replace(from, to);
    assert.equal(matchesAll(mutated, CODEX_TRUST_CHECKS), false, `逆転が通ってしまう: ${from} -> ${to}`);
  }
  assert.equal(section.claude.includes("Hooks need review"), false);
});

test("subagent-delegation の承認を省く指定の項目は各要素を同じ 1 項目に含み、句を逆転すると検査が落ちる", () => {
  const section = catalog.agentSections.find((item) => item.id === "subagent-delegation");
  assert.ok(section);
  const line = pieceContaining(section.claude, "--dangerously-bypass-hook-trust", "\n");
  assert.notEqual(line, "", "指定の項目が見つかる");
  assert.equal(matchesAll(line, DELEGATE_TRUST_CHECKS), true, "正しい文章は検査を通る");
  for (const [from, to] of DELEGATE_TRUST_MUTATIONS) {
    assert.ok(line.includes(from), `変異の元の句がある: ${from}`);
    const mutated = line.replace(from, to);
    assert.equal(matchesAll(mutated, DELEGATE_TRUST_CHECKS), false, `逆転が通ってしまう: ${from} -> ${to}`);
  }
  assert.equal(pieceContaining(section.codex, "--dangerously-bypass-hook-trust", "\n"), "", "Codex 向けに指定の案内が入らない");
  assert.equal(section.codex.includes("codex.trustHooks"), false, "Codex 向けに trustHooks の案内が入らない");
});
