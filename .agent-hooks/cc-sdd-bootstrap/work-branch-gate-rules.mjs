// 作業前のブランチ確保の判定（純粋な処理）。
// ファイル・git・環境変数を読まず、入力（ブランチ・状態・設定）から結果だけを計算する。
import { detectCommand } from "./kiro-gate-rules.mjs";

/** 作業前のブランチ確保の対象にする新機能追加系の入力 */
const TARGET_SKILLS = new Set(["kiro-discovery", "kiro-spec-init", "kiro-spec-quick", "kiro-spec-batch", "kiro-impl"]);

/** 同じ入力の間に拒否する最大の回数 */
const MAX_DENIALS = 2;

/** 読み取り専用の道具名（Claude Code・Codex 共通） */
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "ToolSearch", "WebFetch", "WebSearch", "TodoWrite"]);

/** シェルの道具名（Claude Code の Bash、Codex の shell 系） */
const SHELL_TOOLS = new Set(["Bash", "shell", "local_shell", "exec_command"]);

/** find の中で書き込みや実行をする引数。付いていたら読み取りではないとする */
const FIND_WRITE_ARGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/**
 * 入力の先頭のコマンドを分類する。対象の 5 つ以外は null（2.6）。
 * @param {unknown} prompt - 利用者の入力
 * @returns {{ kind: "target", skill: string } | null}
 */
export function classifyPrompt(prompt) {
  if (typeof prompt !== "string") return null;
  const command = detectCommand(prompt);
  if (!command || !TARGET_SKILLS.has(command.skill)) return null;
  return { kind: "target", skill: command.skill };
}

/**
 * 基底ブランチか。ブランチなし（空の名前・detached HEAD）は基底と同じに扱う（3.2）。
 * @param {string} branch - 現在のブランチ名（空はブランチなし）
 * @param {string[]} bases - 設定の基底ブランチの一覧
 * @param {string | null} originDefault - origin の既定ブランチ。無ければ null
 */
export function isBaseBranch(branch, bases, originDefault) {
  if (branch === "") return true;
  return bases.includes(branch) || (originDefault !== null && originDefault === branch);
}

/**
 * 設定の基底ブランチの値（カンマ区切り）を一覧にする。空の要素と前後の空白は除く。
 * @param {string} value
 * @returns {string[]}
 */
export function parseBaseBranches(value) {
  return value.split(",").map((name) => name.trim()).filter((name) => name !== "");
}

/**
 * シェルのコマンドを 1 行の文字列にする。配列の形は、`sh -lc 本文` なら本文、それ以外は空白で連結する。
 * @returns {string | null} 取り出せなければ null
 */
function shellCommandOf(toolInput) {
  const value = toolInput?.command;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
    const isShellWrapper = value.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(value[0]) && (value[1] === "-lc" || value[1] === "-c");
    return isShellWrapper ? value[2] : value.join(" ");
  }
  return null;
}

/**
 * 単純なシェルのコマンドを「読み取り」「ブランチの作成・切り替え」「作業」に分類する。
 * 区切りで分けた各部分を分類し、1 つでも作業があれば作業、無くて切り替えがあれば branch、全部読み取りなら read。
 * 分類できない構造（引用符の外の単独の &・リダイレクト・コマンド置換・${ の展開・閉じていない引用符・
 * 区切りの前後が空・`()`）は作業に倒す。
 * @param {string} command
 * @returns {"read" | "branch" | "work"}
 */
function classifyShell(command) {
  const tokens = tokenize(joinLineContinuations(command));
  if (tokens === null) return "work";
  const sequence = normalizeNewlines(tokens);
  if (!isValidSequence(sequence)) return "work";
  const kinds = sequence.filter((token) => token.seg !== undefined).map((token) => classifyPart(token.seg));
  if (kinds.includes("work")) return "work";
  return kinds.includes("branch") ? "branch" : "read";
}

/**
 * 行継続（引用符の外、または二重引用符の中の「バックスラッシュ＋改行」）を取り除く。
 * 単一引用符の中は取り除かない。取り除いた後の文字列で分類し直すため、先に行う。
 * @param {string} command
 * @returns {string}
 */
function joinLineContinuations(command) {
  let result = "";
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    const next = command[index + 1];
    if (quote === "'") {
      if (ch === "'") quote = null;
      result += ch;
      continue;
    }
    if (ch === "\\" && next === "\n") {
      index += 1;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      result += ch + next;
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      result += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    result += ch;
  }
  return result;
}

/**
 * コマンドを、引用符の外の区切り（&&・||・;・|・改行・( )）と部分（seg）の列にする。
 * 引用符（' と "）の中の記号では区切らない。分類できない構造（引用符の外の単独の &・リダイレクト・
 * コマンド置換・${ の展開、閉じていない引用符）を見つけたら null を返す。
 * @param {string} command
 * @returns {Array<{ seg: string } | { op: string }> | null}
 */
function tokenize(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  const flush = () => {
    const text = current.trim();
    if (text !== "") tokens.push({ seg: text });
    current = "";
  };
  const operator = (name) => {
    flush();
    tokens.push({ op: name });
  };
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    const next = command[index + 1];
    // 単一引用符の中は、バックスラッシュも記号も文字として扱う
    if (quote === "'") {
      if (ch === "'") quote = null;
      current += ch;
      continue;
    }
    // バックスラッシュは次の 1 文字を文字として扱う
    if (ch === "\\" && next !== undefined) {
      current += ch + next;
      index += 1;
      continue;
    }
    // コマンド置換と ${ の展開は、引用符の中でも分類できない構造として扱う
    if (ch === "$" && (next === "(" || next === "{")) return null;
    if (ch === "`") return null;
    if (quote === '"') {
      if (ch === '"') quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "<" || ch === ">") return null;
    // 単独の & は背景実行なので分類しない
    if (ch === "&") {
      if (next !== "&") return null;
      operator("&&");
      index += 1;
      continue;
    }
    if (ch === "|") {
      if (next === "|") {
        operator("||");
        index += 1;
      } else {
        operator("|");
      }
      continue;
    }
    if (ch === ";") {
      operator(";");
      continue;
    }
    if (ch === "(" || ch === ")") {
      operator(ch);
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      operator("\n");
      continue;
    }
    current += ch;
  }
  // 閉じていない引用符は分類しない
  if (quote !== null) return null;
  flush();
  return tokens;
}

/** 改行の扱い: 連続する改行は 1 つにまとめる。前が部分か `)`、後ろがあるときだけ区切りとして残し、それ以外（先頭・末尾・操作の後など）は捨てる */
function normalizeNewlines(tokens) {
  const merged = [];
  for (const token of tokens) {
    if (token.op === "\n" && merged.at(-1)?.op === "\n") continue;
    merged.push(token);
  }
  return merged.filter((token, index) => {
    if (token.op !== "\n") return true;
    const previous = merged[index - 1];
    const following = merged[index + 1];
    return previous !== undefined && following !== undefined && isOperandEnd(previous);
  });
}

/** 部分の末尾になれるか（部分、または `)`） */
function isOperandEnd(token) {
  return token.seg !== undefined || token.op === ")";
}

/**
 * 部分と区切りの並びが正しいか。区切りの前後が空（先頭・末尾・連続・`()`）なら誤りとする。
 * 空の部分の代わりに使える形は、部分・`(`・`)` の組み合わせだけ。
 * @param {Array<{ seg: string } | { op: string }>} sequence
 */
function isValidSequence(sequence) {
  if (sequence.length === 0) return false;
  let expectOperand = true;
  for (const token of sequence) {
    if (token.seg !== undefined) {
      if (!expectOperand) return false;
      expectOperand = false;
    } else if (token.op === "(") {
      if (!expectOperand) return false;
    } else if (token.op === ")") {
      if (expectOperand) return false;
      expectOperand = false;
    } else {
      // && || | ; 改行
      if (expectOperand) return false;
      expectOperand = true;
    }
  }
  return !expectOperand;
}

/**
 * 部分（区切りで分けた 1 つ分のコマンド）を分類する。語は引用符を外した値で規則に照らす。
 * 引用符を外せない形（閉じていない・変数の展開を含む）は作業にする。
 */
function classifyPart(part) {
  const raw = splitWords(part);
  if (raw === null) return "work";
  const words = raw.map(unquoteWord);
  if (words.includes(null)) return "work";
  const [executable] = words;
  if (!executable) return "work";
  // 変数の代入つきの実行は分類しない
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(executable)) return "work";
  if (executable === "git") return classifyGit(words.slice(1));
  if (executable === "find") return words.some((word) => FIND_WRITE_ARGS.has(word)) ? "work" : "read";
  if (READ_EXECUTABLES.has(executable)) return hasRiskyOption(executable, words.slice(1)) ? "work" : "read";
  return "work";
}

/**
 * 部分を、引用符の外の空白で語に分ける（語は引用符を残したまま）。閉じていない引用符は null。
 * @returns {string[] | null}
 */
function splitWords(text) {
  const words = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const next = text[index + 1];
    if (quote === "'") {
      if (ch === "'") quote = null;
      current += ch;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      current += ch + next;
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== "") words.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote !== null) return null;
  if (current !== "") words.push(current);
  return words;
}

/**
 * 語から引用符を外した値を返す（シェルと同じ規則の範囲）。
 * 閉じていない引用符、末尾のバックスラッシュ、変数の展開（$・`）を含む形は null（分類しない）。
 */
function unquoteWord(raw) {
  let value = "";
  let quote = null;
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index];
    const next = raw[index + 1];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else value += ch;
      continue;
    }
    if (ch === "\\") {
      if (next === undefined) return null;
      // 二重引用符の中では、特別な文字の前だけバックスラッシュが消える
      if (quote === '"' && !["$", "`", '"', "\\"].includes(next)) value += ch;
      value += next;
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else value += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    value += ch;
  }
  if (quote !== null) return null;
  if (value.includes("$") || value.includes("`")) return null;
  return value;
}

/** 読み取りとして扱う実行ファイル（オプションによって作業に変わるものは RISKY_OPTIONS で見る）。cd・true・false・test・[ は状態を変えない */
const READ_EXECUTABLES = new Set(["ls", "cat", "head", "tail", "nl", "pwd", "grep", "rg", "sort", "cd", "true", "false", "test", "["]);

/**
 * 読み取りに見えても、外部の実行やファイルへの書き込みを伴うオプションの形。
 * 見つけたら作業に分類する（迷う形も作業に倒す）。`=` つきと空白区切りの両方を、前置きの一致で見る。
 */
const RISKY_OPTIONS = {
  rg: [/^--pre/],
  "git:log": [/^--(output|ext-diff|textconv)/],
  "git:diff": [/^--(output|ext-diff|textconv)/],
  "git:show": [/^--(output|ext-diff|textconv)/],
  sort: [/^-[a-zA-Z]*o/, /^--output/, /^--compress-program/],
};

/** 引数の並びに危険なオプションがあるか */
function hasRiskyOption(key, args) {
  const patterns = RISKY_OPTIONS[key] ?? [];
  return args.some((word) => patterns.some((pattern) => pattern.test(word)));
}

/** git の下位コマンドを分類する（引数は git の後ろ） */
function classifyGit(args) {
  const [subcommand, ...rest] = args;
  if (["log", "diff", "show"].includes(subcommand)) return hasRiskyOption(`git:${subcommand}`, rest) ? "work" : "read";
  if (["status", "fetch", "rev-parse", "ls-remote", "show-ref"].includes(subcommand)) return "read";
  if (subcommand === "remote") return rest.length === 0 || ["-v", "show", "get-url"].includes(rest[0]) ? "read" : "work";
  if (subcommand === "switch") return "branch";
  if (subcommand === "checkout") return classifyCheckout(rest);
  if (subcommand === "branch") return classifyBranch(rest);
  if (subcommand === "worktree") return classifyWorktree(rest);
  return "work";
}

/**
 * git checkout: `--` を含む形と `.` はファイルの書き換えなので作業。ブランチの切り替え・作成は branch。
 * `git checkout <ファイル>`（`--` なし）はブランチとの区別ができないため branch とする（残る注意点）。
 */
function classifyCheckout(args) {
  return args.includes("--") || args.includes(".") ? "work" : "branch";
}

/** 一覧表示に使う短いオプションの文字（a: 全部、r: リモート、l: 一覧、v: 詳しい、q: 静か、i: 大文字小文字を無視） */
const LIST_SHORT = new Set(["a", "r", "l", "v", "q", "i"]);
/** 一覧表示に使う長いオプション（値を取らない形） */
const LIST_LONG = new Set(["--all", "--remotes", "--list", "--verbose", "--show-current", "--quiet", "--ignore-case", "--color", "--no-color", "--column", "--no-column", "--abbrev", "--no-abbrev"]);
/** 一覧表示で、次の語を値として取る長いオプション（空白区切りの形） */
const LIST_VALUE_LONG = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]);

/** 短いオプションの束（例 -avv）が、すべて一覧表示の文字だけでできているか */
function isListingCluster(word) {
  return /^-[a-zA-Z]+$/.test(word) && [...word.slice(1)].every((letter) => LIST_SHORT.has(letter));
}

/**
 * git branch: 引数なし・一覧表示だけの形は読み取り。名前を作る・変える・消す形（`-c`・`-m`・`-d`・`-f` など）や
 * 一覧以外の位置の語は branch。`-l`・`--list` の後の語はパターンとして読み取りにする。
 */
function classifyBranch(args) {
  if (args.length === 0) return "read";
  const listing = args.some((word) => word === "--list" || (isListingCluster(word) && word.slice(1).includes("l")));
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === "--list" || isListingCluster(word) || LIST_LONG.has(word)) continue;
    if (/^--(contains|no-contains|merged|no-merged|points-at|sort|format|abbrev|column|color)=/.test(word)) continue;
    if (LIST_VALUE_LONG.has(word)) {
      index += 1;
      continue;
    }
    if (listing && !word.startsWith("-")) continue;
    return "branch";
  }
  return "read";
}

/** git worktree: 一覧は読み取り、追加・削除・整理・移動は branch、それ以外は作業 */
function classifyWorktree(args) {
  const [subcommand] = args;
  if (subcommand === "list") return "read";
  if (["add", "remove", "prune", "move"].includes(subcommand)) return "branch";
  return "work";
}

/**
 * 道具の呼び出しを粗く分類する。読み取り専用は read、ブランチの作成・切り替えは branch、それ以外（分からない道具名を含む）は work。
 * @param {string} toolName - 道具名
 * @param {unknown} toolInput - 道具への入力
 * @returns {"read" | "branch" | "work"}
 */
export function classifyToolCall(toolName, toolInput) {
  if (typeof toolName !== "string") return "work";
  if (READ_TOOLS.has(toolName)) return "read";
  if (SHELL_TOOLS.has(toolName)) {
    const command = shellCommandOf(toolInput);
    return command === null ? "work" : classifyShell(command);
  }
  return "work";
}

/**
 * 操作の前の判断。turn が無ければ判断しない。
 * - 読み取りは通す。ブランチの作成・切り替えを試みたら switchTried を真にして通す（3.6・3.7）。
 * - 作業は、切り替えを試みておらず、拒否が 2 回未満で、現在のブランチが基底のときだけ拒否し、回数を 1 増やす（3.1・3.5）。
 * - 現在のブランチが判定できない（null）・基底でないときは通す（3.9・3.10）。
 * @param {{ skill: string, denials: number, switchTried: boolean } | null} turn
 * @param {{ toolName: string, toolInput: unknown }} call
 * @param {{ branch: string | null, bases: string[], originDefault: string | null }} facts
 * @returns {{ allow: true, turn: object | null } | { allow: false, reason: string, turn: object }}
 */
export function decidePreToolUse(turn, call, facts) {
  if (turn === null) return { allow: true, turn: null };
  const kind = classifyToolCall(call.toolName, call.toolInput);
  if (kind === "read") return { allow: true, turn };
  if (kind === "branch") return { allow: true, turn: { ...turn, switchTried: true } };
  if (turn.switchTried || turn.denials >= MAX_DENIALS) return { allow: true, turn };
  if (facts.branch === null || !isBaseBranch(facts.branch, facts.bases, facts.originDefault)) return { allow: true, turn };
  return {
    allow: false,
    reason: messageDeny(turn.skill, facts.branch),
    turn: { ...turn, denials: turn.denials + 1 },
  };
}

/** 現在のブランチの表示。空の名前はブランチなしと書く */
function branchLabel(branch) {
  return branch === "" ? "（ブランチなし）" : `「${branch}」`;
}

/** 案内と拒否の理由に共通の本文 */
function body(skill, branch) {
  const lines = [
    `現在のブランチ ${branchLabel(branch)} は基底ブランチです。cc-sdd の作業（${skill}）を始める前に、作業用ブランチへ切り替えてから続けてください。`,
    "- 既存の作業用ブランチがあれば、そのブランチへ切り替えてください。",
    "- 無ければ、新しく作業用ブランチを作成し、そこへ切り替えてください（例: git switch -c <ブランチ名>）。",
    "- ブランチの作成・切り替えは、他のコマンドとつながず単独のコマンド（例: `git switch -c <名前>`）で実行してください。",
    "- どのブランチを使えばよいか分からなければ、利用者に尋ねてください。",
    "- ブランチを作れない場合（実行環境の制約など）は、作れない理由を利用者に伝えて作業を止めてください。",
  ];
  if (skill === "kiro-impl") {
    lines.splice(2, 0, "- kiro-impl の場合は、その spec を格納した作業用ブランチがリモートにあれば、そのブランチへ切り替えてください。ローカルに spec が無い可能性があります。");
  }
  return lines.join("\n");
}

/**
 * 入力を受けたときの追加の文脈（案内）。
 * @param {string} skill
 * @param {string} branch
 * @returns {string}
 */
export function messageGuidance(skill, branch) {
  return `【作業前のブランチ確保】\n${body(skill, branch)}`;
}

/**
 * 操作を拒否するときの理由。
 * @param {string} skill
 * @param {string} branch
 * @returns {string}
 */
export function messageDeny(skill, branch) {
  return `【作業前のブランチ確保】作業を拒否しました。\n${body(skill, branch)}`;
}
