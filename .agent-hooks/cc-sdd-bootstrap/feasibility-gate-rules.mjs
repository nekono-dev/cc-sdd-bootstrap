// 実現性の確認の判定（純粋な処理）。
// ファイル・git・環境変数を読まず、入力（コマンド・記録の解析結果など）から結果だけを計算する。
import { detectCommand } from "./kiro-gate-rules.mjs";

/** 対象にする kiro コマンド（分類の対象。停止するかは STOP_TARGETS で決める） */
const TARGET_SKILLS = new Set([
  "kiro-spec-requirements",
  "kiro-spec-design",
  "kiro-validate-design",
  "kiro-spec-tasks",
  "kiro-impl",
  "kiro-spec-quick",
  "kiro-spec-batch",
]);

/**
 * 入力時に止めるコマンドと、止めるのに必要な段階。
 * 段階は "design"（設計）か "tasks"（タスク計画）。後続の spec で対象を足しやすいようデータにしている。
 */
const STOP_TARGETS = {
  "kiro-spec-tasks": "design",
  "kiro-impl": "tasks",
};

/** spec 名の規則。パスの意図しない解決を防ぐため、この規則に合うものだけ採る */
const SPEC_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 記録の節の見出しと、段階の対応 */
const SECTION_HEADINGS = {
  need: "実機検証の要否",
  design: "設計の確認",
  tasks: "タスク計画の確認",
};

/** 判定の語と、解析結果の値の対応 */
const NEED_WORDS = { 必要: "required", 不要: "unneeded" };
const STAGE_WORDS = { 通過: "pass", 未通過: "fail" };

/**
 * 水平線・下線つきの見出しの行（前後の空白を除いた形）。
 * `=` だけの行（下線つきの見出し）、`-`・`*`・`_` が 3 個以上（水平線）。
 */
const RULE_PATTERN = /^(?:=+|(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/;

/**
 * 先頭の kiro コマンドを、対象のコマンドと spec 名に分ける。対象外・コマンドなしは null。
 * spec 名は、コマンド名の後の語のうち `-` で始まらない最初の語（規則に合わなければ null）。
 * @param {unknown} prompt - 利用者の入力
 * @returns {{ skill: string, spec: string | null } | null}
 */
export function classifyPrompt(prompt) {
  if (typeof prompt !== "string") return null;
  const command = detectCommand(prompt);
  if (!command || !TARGET_SKILLS.has(command.skill)) return null;

  // detectCommand は先頭の空白を除いてから照合するので、同じ前提で後ろの文字列を切り出す
  const trimmed = prompt.trimStart();
  const rest = trimmed.slice(1 + command.skill.length);
  // `-` で始まる引数（例: -y）は読み飛ばし、最初の語を spec 名の候補にする
  const firstWord = rest.trim().split(/\s+/).find((word) => word !== "" && !word.startsWith("-"));
  const spec = firstWord !== undefined && SPEC_NAME_PATTERN.test(firstWord) ? firstWord : null;
  return { skill: command.skill, spec };
}

/**
 * 記録（feasibility.md）の本文を解析する。
 * 3 つの `## ` の節ごとに、行頭（空白なし）の `- 判定: <語>` の行がちょうど 1 つあるときだけ、語を値にする。
 * 節が無い・判定の行が無い・2 つ以上・語が違うときは null。
 * コードブロック（CommonMark のフェンス）と HTML コメントの中は読まない。
 * 迷う形は読まず null（止める側）に倒す。
 * @param {unknown} text - 記録の本文
 * @returns {{ need: "required" | "unneeded" | null, design: "pass" | "fail" | null, tasks: "pass" | "fail" | null }}
 */
export function parseRecord(text) {
  const sections = readSections(typeof text === "string" ? text : "");
  return {
    need: judgementOf(sections, SECTION_HEADINGS.need, NEED_WORDS),
    design: judgementOf(sections, SECTION_HEADINGS.design, STAGE_WORDS),
    tasks: judgementOf(sections, SECTION_HEADINGS.tasks, STAGE_WORDS),
  };
}

/**
 * 本文を節ごとに分け、各節の判定の語（trim 済み）を集める。
 * 同じ見出しの節が 2 つあるときは、どちらが正か決められないので無効にする（null を入れる）。
 * 節の境界は、レベル 1・2 の見出し、水平線・下線つきの見出し、前置きのあるコメントの開始、対象外の見出し。
 * 4 個以上の空白・タブで始まる行は判定として読まない（見出しに見えるものは境界にする）。
 * @param {string} text
 * @returns {Map<string, string[] | null>}
 */
function readSections(text) {
  const sections = new Map();
  let current = null;
  // 開いているフェンス（コードブロック）。null なら外。CommonMark に合わせ、文字・長さ（閉じるには開始以上）を覚える
  let fence = null;
  // HTML コメントの中か（閉じの `-->` が来るまで読まない）
  let comment = false;

  for (const line of text.split(/\r?\n/)) {
    if (fence !== null) {
      // フェンスの中の行は見出しにも判定にも使わない。同じ文字で開始以上の長さの閉じ行だけがフェンスを閉じる
      const closing = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) fence = null;
      continue;
    }

    if (comment) {
      // コメントの中の行は見出しにも判定にも使わない
      if (line.includes("-->")) comment = false;
      continue;
    }

    // 行頭（0〜3 個の空白・タブの後）の 3 文字以上の並びで開始する。バッククォートの開始行は情報文字列に ` を含めない
    const opening = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      fence = { char: opening[1][0], length: opening[1].length };
      continue;
    }

    // HTML コメントの開始。前に文字があるなら、その行は節の境界として扱う（保守的に終わらせる）
    const commentStart = line.indexOf("<!--");
    if (commentStart !== -1) {
      if (line.slice(0, commentStart).trim() !== "") current = null;
      comment = !line.slice(commentStart + 4).includes("-->");
      continue;
    }

    const trimmedStart = line.replace(/^[ \t]+/, "");
    // 4 個以上の空白・タブで始まる行は読まない。見出しや水平線に見えるものだけは境界にする
    if (line.startsWith("\t") || line.length - trimmedStart.length >= 4) {
      if (/^#{1,6}(?:[ \t]|$)/.test(trimmedStart) || RULE_PATTERN.test(trimmedStart)) current = null;
      continue;
    }

    // 水平線・下線つきの見出しは、直前の節を終わらせる
    if (RULE_PATTERN.test(trimmedStart)) {
      current = null;
      continue;
    }

    // レベル 1・2 の見出しは節を終わらせる。レベル 3 以上は節の中に含める
    const heading = /^(#{1,6})(?:[ \t]|$)(.*)$/.exec(trimmedStart);
    if (heading) {
      if (heading[1].length === 1) {
        current = null;
        continue;
      }
      if (heading[1].length >= 3) continue;
      // 閉じの `#` つき（`## 名前 ##`）は、名前から除く
      const name = heading[2].trim().replace(/(?:^|[ \t]+)#+$/, "").trim();
      if (sections.has(name)) {
        sections.set(name, null);
        current = null;
      } else {
        sections.set(name, []);
        current = name;
      }
      continue;
    }

    // 判定の行は、行頭（空白なし）の `- 判定:` だけを数える（半角コロン）
    const judgement = /^-[ \t]*判定:(.*)$/.exec(line);
    if (judgement && current !== null) {
      sections.get(current).push(judgement[1].trim());
    }
  }
  return sections;
}

/**
 * 節の判定の語を値に直す。節が無効・判定が 1 つでない・語が対応表に無いときは null。
 * @param {Map<string, string[] | null>} sections
 * @param {string} heading - 節の見出し
 * @param {Record<string, string>} words - 語と値の対応
 * @returns {string | null}
 */
function judgementOf(sections, heading, words) {
  const values = sections.get(heading);
  if (!values || values.length !== 1) return null;
  return Object.hasOwn(words, values[0]) ? words[values[0]] : null;
}

/**
 * 入力を止めるかを判断する。
 * 止めるのは、spec 名が特定でき、停止の対象のコマンドで、必要な段階が通過でないとき（記録が無い・読めないときも止める）。
 * 要否（need）は判断に使わない（5.9）。想定外の型は止めない側に倒す。
 * @param {{ skill: string, spec: string | null } | null} command - classifyPrompt の結果
 * @param {boolean} specFound - spec のディレクトリが特定できたか
 * @param {{ need: unknown, design: unknown, tasks: unknown } | null} record - 記録の解析結果。読めなければ null
 * @returns {{ kind: "none" } | { kind: "block", reason: string }}
 */
export function decideInput(command, specFound, record) {
  if (!command || typeof command !== "object") return { kind: "none" };
  if (typeof command.spec !== "string" || specFound !== true) return { kind: "none" };
  if (!Object.hasOwn(STOP_TARGETS, command.skill)) return { kind: "none" };

  const stage = STOP_TARGETS[command.skill];
  if (!record || typeof record !== "object") {
    return { kind: "block", reason: messageBlock(command.spec, stage, "no-record", command.skill) };
  }
  if (record[stage] !== "pass") {
    return { kind: "block", reason: messageBlock(command.spec, stage, "not-passed", command.skill) };
  }
  return { kind: "none" };
}

/**
 * 利用者向けの停止の理由（日本語）。spec 名・段階・通す手順・記録の場所を示す。
 * @param {string} spec - spec 名
 * @param {"design" | "tasks"} stage - 段階
 * @param {"no-record" | "not-passed"} reason - 記録が無い・判定が通過でない
 * @param {string} skill - 止められたコマンド名
 * @returns {string}
 */
export function messageBlock(spec, stage, reason, skill) {
  const stageName = stage === "tasks" ? "タスク計画" : "設計";
  const section = stage === "tasks" ? SECTION_HEADINGS.tasks : SECTION_HEADINGS.design;
  const review = stage === "tasks" ? "`/kiro-spec-tasks`" : "`/kiro-spec-design`・`/kiro-validate-design`";
  const cause = reason === "no-record" ? "記録がありません" : "判定が通過ではありません";
  const path = `.kiro/specs/${spec}/feasibility.md`;
  const lines = [
    `spec \`${spec}\` の${stageName}の実現性の確認が通っていません（${cause}）。`,
    `${review}で前提ごとの根拠を確認し、\`${path}\` の \`## ${section}\` の \`- 判定:\` を \`通過\` にしてから、もう一度同じ入力を送ってください。`,
    "実機検証が不要なら、`## 実機検証の要否` に `- 判定: 不要` と理由を書いてください。",
  ];
  if (skill === "kiro-spec-quick" || skill === "kiro-spec-batch") {
    lines.push("このコマンドは設計とタスク計画を続けて作るため、個別の段階のコマンドで確認を済ませてから送ってください。");
  }
  return lines.join("\n");
}

/**
 * `git worktree list --porcelain -z` の出力から worktree の根を取り出す（純粋な処理）。
 * -z の出力は NUL 区切りの生のパスなので、引用も改行の折り返しも無い。
 * 空のフィールド（NUL が続く）で 1 つの worktree のまとまりが終わる。bare と prunable のまとまりは外す。
 * @param {unknown} text - git の標準出力
 * @returns {string[]} worktree の根（絶対パス）
 */
export function parseWorktreeListZ(text) {
  const roots = [];
  let block = [];
  for (const field of typeof text === "string" ? text.split("\0") : []) {
    if (field === "") {
      pushWorktree(block, roots, false);
      block = [];
    } else {
      block.push(field);
    }
  }
  pushWorktree(block, roots, false);
  return roots;
}

/**
 * `git worktree list --porcelain` の出力から worktree の根を取り出す（-z が使えない git のフォールバック。純粋な処理）。
 * 特殊文字を含むパスは `worktree "..."` の形で引用されうるため、引用符で始まるものは候補に入れない（誤った場所を作らない）。
 * @param {unknown} text - git の標準出力
 * @returns {string[]} 引用されていない worktree の根
 */
export function parseWorktreeListPorcelain(text) {
  const roots = [];
  let block = [];
  for (const line of typeof text === "string" ? text.split(/\r?\n/) : []) {
    if (line === "") {
      pushWorktree(block, roots, true);
      block = [];
    } else {
      block.push(line);
    }
  }
  pushWorktree(block, roots, true);
  return roots;
}

/**
 * worktree の 1 つのまとまりから根を足す。bare と prunable は外す。
 * rejectQuoted が真（porcelain）なら、引用符で始まるパスも外す。
 */
function pushWorktree(block, roots, rejectQuoted) {
  const line = block.find((item) => item.startsWith("worktree "));
  if (line === undefined) return;
  if (block.some((item) => item === "bare" || item.startsWith("prunable"))) return;
  const root = line.slice("worktree ".length);
  if (rejectQuoted && root.startsWith("\"")) return;
  roots.push(root);
}
