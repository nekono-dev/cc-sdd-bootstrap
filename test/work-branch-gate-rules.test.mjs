import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPrompt,
  classifyToolCall,
  decidePreToolUse,
  isBaseBranch,
  messageDeny,
  messageGuidance,
  parseBaseBranches,
} from "../.agent-hooks/cc-sdd-bootstrap/work-branch-gate-rules.mjs";

const BASES = ["main", "master", "develop"];

test("対象の 5 つの入力を、先頭のコマンドとして分類する", () => {
  assert.deepEqual(classifyPrompt("/kiro-discovery 新機能"), { kind: "target", skill: "kiro-discovery" });
  assert.deepEqual(classifyPrompt("$kiro-spec-init 説明"), { kind: "target", skill: "kiro-spec-init" });
  assert.deepEqual(classifyPrompt("/kiro-spec-quick foo --auto"), { kind: "target", skill: "kiro-spec-quick" });
  assert.deepEqual(classifyPrompt("/kiro-spec-batch"), { kind: "target", skill: "kiro-spec-batch" });
  assert.deepEqual(classifyPrompt("  /kiro-impl foo 1.2"), { kind: "target", skill: "kiro-impl" });
});

test("対象外のコマンド・文中の言及・直後が空白でない形は対象にしない", () => {
  assert.equal(classifyPrompt("/kiro-spec-requirements foo"), null);
  assert.equal(classifyPrompt("/kiro-validate-design foo"), null);
  assert.equal(classifyPrompt("/kiro-spec-status foo"), null);
  assert.equal(classifyPrompt("/kiro-steering"), null);
  assert.equal(classifyPrompt("文中の /kiro-impl は対象外"), null);
  assert.equal(classifyPrompt("/kiro-impl:"), null);
  assert.equal(classifyPrompt("通常の依頼"), null);
});

test("基底ブランチの判定: 一覧に含まれる名前、ブランチなし、origin の既定を基底とする", () => {
  assert.equal(isBaseBranch("main", BASES, null), true);
  assert.equal(isBaseBranch("develop", BASES, null), true);
  assert.equal(isBaseBranch("", BASES, null), true);
  assert.equal(isBaseBranch("feature/x", BASES, null), false);
  assert.equal(isBaseBranch("trunk", ["trunk"], null), true);
  assert.equal(isBaseBranch("main", ["trunk"], null), false);
  assert.equal(isBaseBranch("release", BASES, "release"), true);
});

test("設定の基底ブランチの値を一覧にする（前後の空白と空の要素を除く）", () => {
  assert.deepEqual(parseBaseBranches("main,master,develop"), ["main", "master", "develop"]);
  assert.deepEqual(parseBaseBranches(" trunk , release "), ["trunk", "release"]);
});

test("操作を読み取り・ブランチの作成や切り替え・作業に分類する", () => {
  for (const [name, input] of [
    ["Read", { file_path: "/a" }], ["Glob", {}], ["Grep", {}], ["LS", {}], ["ToolSearch", {}],
    ["WebFetch", {}], ["WebSearch", {}], ["TodoWrite", {}],
    ["Bash", { command: "git status" }], ["Bash", { command: "ls -la" }], ["Bash", { command: "cat a.md" }],
    ["Bash", { command: "git remote -v" }], ["Bash", { command: "find . -name x" }],
    ["shell", { command: ["bash", "-lc", "git status"] }], ["exec_command", { command: "git log -1" }],
  ]) {
    assert.equal(classifyToolCall(name, input), "read", `${name} ${JSON.stringify(input)}`);
  }
  for (const command of ["git switch -c feature/x", "git checkout -b x", "git branch x", "git worktree add ../w x"]) {
    assert.equal(classifyToolCall("Bash", { command }), "branch", command);
  }
  assert.equal(classifyToolCall("exec_command", { command: "git switch -c x" }), "branch");
  for (const [name, input] of [
    ["Write", { file_path: "/a" }], ["Edit", { file_path: "/a" }], ["NotebookEdit", {}], ["apply_patch", { command: "*** Begin Patch" }],
    ["Bash", { command: "touch a" }], ["Bash", { command: "echo a > b" }], ["Bash", { command: "git switch -c a && echo" }],
    ["Bash", { command: "cat a | tee b" }], ["Bash", { command: "echo $(git status)" }], ["Bash", { command: "find . -delete" }],
    ["Bash", { command: "git remote add o url" }], ["Bash", {}], ["Foo", {}],
    ["shell", { command: ["bash", "-lc", "echo a > b"] }],
  ]) {
    assert.equal(classifyToolCall(name, input), "work", `${name} ${JSON.stringify(input)}`);
  }
});

test("作業場所が null の状態（対象の入力の前）は判断しない", () => {
  const decision = decidePreToolUse(null, { toolName: "Write", toolInput: {} }, { branch: "main", bases: BASES, originDefault: null });
  assert.deepEqual(decision, { allow: true, turn: null });
});

test("基底ブランチで作業を拒否し、拒否の回数を 1 増やす", () => {
  const turn = { skill: "kiro-impl", denials: 0, switchTried: false };
  const decision = decidePreToolUse(turn, { toolName: "Write", toolInput: { file_path: "/a" } }, { branch: "main", bases: BASES, originDefault: null });
  assert.equal(decision.allow, false);
  assert.equal(decision.turn.denials, 1);
  assert.equal(decision.turn.skill, "kiro-impl");
  assert.match(decision.reason, /main/);
});

test("拒否は 2 回まで。3 回目以降は通す", () => {
  const turn = { skill: "kiro-discovery", denials: 2, switchTried: false };
  const decision = decidePreToolUse(turn, { toolName: "Edit", toolInput: {} }, { branch: "main", bases: BASES, originDefault: null });
  assert.equal(decision.allow, true);
  assert.equal(decision.turn.denials, 2);
});

test("ブランチの作成・切り替えを試みたら切り替え済みにし、以後の作業は拒否しない", () => {
  const facts = { branch: "main", bases: BASES, originDefault: null };
  const tried = decidePreToolUse({ skill: "kiro-impl", denials: 0, switchTried: false },
    { toolName: "Bash", toolInput: { command: "git switch -c feature/x" } }, facts);
  assert.deepEqual(tried, { allow: true, turn: { skill: "kiro-impl", denials: 0, switchTried: true } });
  const after = decidePreToolUse(tried.turn, { toolName: "Write", toolInput: { file_path: "/a" } }, facts);
  assert.equal(after.allow, true);
  assert.equal(after.turn.denials, 0);
});

test("読み取りは基底ブランチでも通し、回数を変えない", () => {
  const turn = { skill: "kiro-impl", denials: 1, switchTried: false };
  const decision = decidePreToolUse(turn, { toolName: "Read", toolInput: { file_path: "/a" } }, { branch: "main", bases: BASES, originDefault: null });
  assert.deepEqual(decision, { allow: true, turn });
});

test("現在のブランチを判定できない（null）・作業ブランチ・基底以外では作業を通す", () => {
  const turn = { skill: "kiro-impl", denials: 0, switchTried: false };
  const call = { toolName: "Write", toolInput: { file_path: "/a" } };
  assert.equal(decidePreToolUse(turn, call, { branch: null, bases: BASES, originDefault: null }).allow, true);
  assert.equal(decidePreToolUse(turn, call, { branch: "feature/x", bases: BASES, originDefault: null }).allow, true);
});

test("detached HEAD（空のブランチ名）は基底として拒否する", () => {
  const turn = { skill: "kiro-impl", denials: 0, switchTried: false };
  const decision = decidePreToolUse(turn, { toolName: "Bash", toolInput: { command: "touch a" } }, { branch: "", bases: BASES, originDefault: null });
  assert.equal(decision.allow, false);
});

test("案内と拒否の理由に、現在のブランチ・作業用ブランチへの切り替え・尋ねること・作れない場合を含む", () => {
  for (const text of [messageGuidance("kiro-discovery", "main"), messageDeny("kiro-discovery", "main")]) {
    assert.match(text, /main/);
    assert.match(text, /作業用ブランチ/);
    assert.match(text, /切り替え/);
    assert.match(text, /新しく|新規/);
    assert.match(text, /利用者に尋ね/);
    assert.match(text, /作れない/);
    assert.doesNotMatch(text, /リモート/);
  }
});

test("kiro-impl の案内は、リモートの作業用ブランチへの切り替えと、ローカルに spec が無い可能性を含む", () => {
  for (const text of [messageGuidance("kiro-impl", "main"), messageDeny("kiro-impl", "main")]) {
    assert.match(text, /リモート/);
    assert.match(text, /spec/);
    assert.match(text, /ローカル/);
  }
});

test("読み取りに見えても、外部の実行や書き込みを伴うオプションつきは作業に分類する", () => {
  for (const command of [
    "rg --pre=touch foo", "rg --pre touch foo", "rg --pre-glob '*.gz' --pre cat foo",
    "git diff --output=out", "git diff --output out", "git log --output=out", "git show --output out",
    "git diff --ext-diff", "git log --textconv", "git show --textconv",
    "sort -o out in", "sort --output=out in", "sort -ro out in", "sort --compress-program=gzip in",
  ]) {
    assert.equal(classifyToolCall("Bash", { command }), "work", command);
  }
});

test("書き込みや実行を伴わない通常の読み取りは読み取りのまま", () => {
  for (const command of ["rg foo", "rg -n foo src", "git diff", "git log -1", "git show HEAD", "sort -n in", "sort -r in"]) {
    assert.equal(classifyToolCall("Bash", { command }), "read", command);
  }
});

test("一覧表示だけの git branch は読み取り、名前の作成・変更・削除は branch に分類する", () => {
  for (const command of [
    "git branch", "git branch -a", "git branch -r", "git branch -l", "git branch --list", "git branch -v", "git branch -vv",
    "git branch --show-current", "git branch --contains HEAD", "git branch --contains=HEAD", "git branch -avv",
    "git branch -l 'feat*'", "git branch --list feat*",
  ]) {
    assert.equal(classifyToolCall("Bash", { command }), "read", command);
  }
  for (const command of [
    "git branch x", "git branch -c a b", "git branch -C a b", "git branch -m a b", "git branch -M a b",
    "git branch -d x", "git branch -D x", "git branch --delete x", "git branch -f x HEAD",
    "git branch --set-upstream-to=origin/x", "git branch -u origin/x", "git branch -t x origin/x",
    "git branch --copy a b", "git branch --move a b",
  ]) {
    assert.equal(classifyToolCall("Bash", { command }), "branch", command);
  }
});

test("git worktree の一覧は読み取り、追加・削除・整理・移動は branch、それ以外は作業に分類する", () => {
  for (const command of ["git worktree list", "git worktree list --porcelain"]) {
    assert.equal(classifyToolCall("Bash", { command }), "read", command);
  }
  for (const command of ["git worktree add ../w x", "git worktree remove w", "git worktree prune", "git worktree move a b"]) {
    assert.equal(classifyToolCall("Bash", { command }), "branch", command);
  }
  for (const command of ["git worktree lock x", "git worktree"]) {
    assert.equal(classifyToolCall("Bash", { command }), "work", command);
  }
});

test("git checkout は -- を含む形やファイル指定をファイルの書き換え（作業）、ブランチの切り替えだけを branch に分類する", () => {
  for (const command of ["git checkout -- a.md", "git checkout -- .", "git checkout .", "git checkout HEAD -- a.md"]) {
    assert.equal(classifyToolCall("Bash", { command }), "work", command);
  }
  for (const command of ["git checkout main", "git checkout -b x", "git checkout -B x", "git checkout --track origin/x"]) {
    assert.equal(classifyToolCall("Bash", { command }), "branch", command);
  }
});

test("つないだ複合コマンドは、部分ごとの分類を合わせて判定する（実機で見つかった形）", () => {
  for (const command of [
    "git branch --list 'dev/demo' && git status --short && git rev-parse --abbrev-ref HEAD",
    "git status && git branch --list && pwd",
    "git status | cat",
    "git status || true",
    "git branch --list 'a&&b'",
    "cd /x && git status",
  ]) {
    assert.equal(classifyToolCall("Bash", { command }), "read", command);
  }
  for (const command of [
    "(git show-ref --verify --quiet refs/heads/dev/demo && git switch dev/demo || git switch -c dev/demo) && git rev-parse --abbrev-ref HEAD",
    "cd /x && git switch -c a",
    "(git switch -c a)",
    "git status && git switch -c a",
  ]) {
    assert.equal(classifyToolCall("Bash", { command }), "branch", command);
  }
});

test("つないだ複合コマンドでも、作業を含む部分や分類できない構造が 1 つでもあれば作業", () => {
  for (const command of [
    "git switch -c a && echo hi",
    "git switch -c a; rm -rf x",
    "git switch -c a > /tmp/o",
    "git switch -c a >> /tmp/o",
    "git switch -c a < /tmp/i",
    "git switch -c a $(echo b)",
    "git switch -c a `echo b`",
    "git status | sh",
    "git switch -c a & ",
    "git switch -c a\nrm x",
    "X=1 git status",
    "eval git status",
    "git status && git commit -m x",
    "git branch --list 'abc",
    "git status && echo \"$(whoami)\"",
    "echo ${HOME}",
  ]) {
    assert.equal(classifyToolCall("Bash", { command }), "work", JSON.stringify(command));
  }
});

test("作業ブランチの案内・拒否の理由に、ブランチ操作は単独のコマンドで実行することを 1 文含む", () => {
  for (const text of [messageGuidance("kiro-impl", "main"), messageDeny("kiro-impl", "main")]) {
    assert.match(text, /他のコマンドとつながず/);
    assert.match(text, /単独のコマンド/);
    assert.match(text, /git switch -c/);
  }
});

test("引用符で囲んだ引数は、引用符を外した値で規則に照らす", () => {
  for (const command of [
    "git status && git checkout '--' file",
    "git checkout \"--\" file",
    "git status && find . \"-delete\"",
    "git status && sort '-o' f",
    "git status && sort -\"o\" f",
  ]) {
    assert.equal(classifyToolCall("Bash", { command }), "work", command);
  }
  for (const command of ["git branch --list 'a&&b'", "git branch --list \"feat\"", "git 'status'"]) {
    assert.equal(classifyToolCall("Bash", { command }), "read", command);
  }
  assert.equal(classifyToolCall("Bash", { command: "git switch -c a" }), "branch");
});

test("区切りの前後が空の不正な構文は作業に分類し、改行や前後の空白による空の部分は許す", () => {
  for (const command of [
    "git status;;", "&& git status", "git status &&", "| git status", "git status |", "git status ||",
    "()", "git status ( )",
  ]) {
    assert.equal(classifyToolCall("Bash", { command }), "work", JSON.stringify(command));
  }
  for (const command of ["git status\n", "\ngit status\n", "git status &&\n git status", "git status\n\ngit status", "git status; git status", "(git status)"]) {
    assert.equal(classifyToolCall("Bash", { command }), "read", JSON.stringify(command));
  }
});

test("二重引用符の中で、バックスラッシュと改行の行継続を除いてからコマンド置換を判定する", () => {
  assert.equal(classifyToolCall("Bash", { command: "git branch --list \"$\\\n(touch f)\"" }), "work");
  assert.equal(classifyToolCall("Bash", { command: "git branch --list \"$\\\n{HOME}\"" }), "work");
  assert.equal(classifyToolCall("Bash", { command: "git branch --list \"feat\"\\\n" }), "read");
});

test("ブランチなしの案内は空の名前を見せず、特定の別の仕組みの名前を含まない", () => {
  const text = messageGuidance("kiro-spec-init", "");
  assert.match(text, /（ブランチなし）/);
  for (const text of [messageGuidance("kiro-impl", "main"), messageDeny("kiro-impl", "main"), messageGuidance("kiro-discovery", "")]) {
    assert.doesNotMatch(text, /brw|branch-release-workflow|release/i);
  }
});
