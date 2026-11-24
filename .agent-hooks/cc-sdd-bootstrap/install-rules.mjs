import { configFields, formatProblem } from "./config-schema.mjs";

export const CONFIG_FILE = ".cc-sdd-bootstrap.json";
export const UPDATE_COMMAND = "npx github:nekono-dev/cc-sdd-bootstrap update";
export const INIT_COMMAND = "npx github:nekono-dev/cc-sdd-bootstrap init";
export const FAILURE_RECORD = ".cache/cc-sdd-install.failed";
export const STATE_PATH = ".cache/cc-sdd-install.state.json";
/** 標準文書に書き足した運用の区画の開始目印（installer-core の値と合わせる） */
export const SECTION_BEGIN_MARKER = "<!-- cc-sdd-bootstrap:begin（この区画は cc-sdd の導入のたびに書き足される。編集しない） -->";
/** 導入中の印（同時の実行を防ぐ）。作成時に排他的に作り、導入の終わりに消す */
export const LOCK_PATH = ".cache/cc-sdd-install.lock";
export const RETRY_COMMAND = "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs";
export const INSTALL_DEADLINE_MS = 540000;
/** 既存の規則試験との互換名。新しい導入処理は INSTALL_DEADLINE_MS を使う */
export const NPX_TIMEOUT_MS = INSTALL_DEADLINE_MS;
/** 導入中の印が古いとみなす経過時間（導入全体の期限＋120秒。UserPromptSubmit の時間切れ 600 秒より長い） */
export const STALE_LOCK_MS = 660000;

/** 道筋（"a.b"）で値を読む。無ければ undefined */
function getPath(obj, path) {
  let cur = obj;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur) || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** 道筋の途中に、あるのに普通のオブジェクトでない値があれば、その道筋を返す（installer-core の規則と同じ） */
function findBlockedPrefix(obj, path) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur !== "object" || cur === null || !Object.hasOwn(cur, keys[i])) return null;
    cur = cur[keys[i]];
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return keys.slice(0, i + 1).join(".");
  }
  return null;
}

/**
 * 設定ファイルのテキストを解析し、有効な設定（版・言語）または失敗理由を返す。
 * installer-core と同じ扱い: 必須は format だけ。項目定義（configFields）の項目は値があれば検証し、無ければ既定値を使う。
 * 雛形の保持は扱わない。
 * @param {string | null} text
 * @returns {{ ok: true, config: { version: string, lang: string } } | { ok: false, reason: string }}
 */
export function readInstallConfig(text) {
  const fail = (detail) => ({
    ok: false,
    reason: `${detail} ${CONFIG_FILE} を直すか、${UPDATE_COMMAND} で設定を新しくしてください。`
  });

  if (text === null) {
    return { ok: false, reason: `${CONFIG_FILE} がありません。${INIT_COMMAND} で作成してください。` };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(`${CONFIG_FILE} が JSON として読めません。`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(`${CONFIG_FILE} がオブジェクトではありません。`);
  }

  const fmtProb = formatProblem(parsed.format);
  if (typeof fmtProb === "string") {
    return fail(`${CONFIG_FILE} の ${fmtProb}`);
  }

  for (const field of configFields) {
    const blocked = findBlockedPrefix(parsed, field.path);
    if (blocked) return fail(`${CONFIG_FILE} の ${blocked}: オブジェクトで指定してください。`);
    const value = getPath(parsed, field.path);
    if (value === undefined) continue;
    const err = field.validate(value);
    if (typeof err === "string") {
      return fail(`${CONFIG_FILE} の ${field.path}: ${err}`);
    }
  }

  const resolve = (path) => {
    const value = getPath(parsed, path);
    return value === undefined ? configFields.find((f) => f.path === path).defaultValue : value;
  };
  return { ok: true, config: { version: resolve("ccSdd.version"), lang: resolve("ccSdd.lang") } };
}

/**
 * 導入状態の記録を組み立てる。files は導入に成功したときの導入物の相対の道筋の一覧（中身は持たない）。
 * @param {{ version: string, lang: string }} config
 * @param {string[]} files
 */
export function buildState(config, files) {
  return { format: 2, version: config.version, lang: config.lang, files: [...files] };
}

/** parseState: 導入状態の記録の文字列を厳密に検証して返す。読めない・形が違う・format が 2 でなければ null（旧版の指紋つきの記録も含む） */
export function parseState(text) {
  if (text === null) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const { format, version, lang, files } = obj;
  if (format !== 2) return null;
  if (typeof version !== "string" || version.length === 0) return null;
  if (typeof lang !== "string" || lang.length === 0) return null;
  if (!Array.isArray(files)) return null;
  for (const path of files) {
    if (!isRelativePath(path)) return null;
  }
  return { format, version, lang, files: [...files] };
}

/** 相対の道筋か（絶対・`\` を含む・`..` や `.`・空の区間を含むものは外） */
function isRelativePath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.startsWith("/") || p.includes("\\")) return false;
  return !p.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

/**
 * 判断: 材料（InstallFacts）から、導入するか・省くか・止めるかを返す（内容は比べない。4.4）。
 * 順序: 設定の誤り → 導入中の印 → 失敗の記録 → 状態の欠け → 版・言語 → 記録した道筋の欠け → 運用の区画の欠け → 省く。
 * @param {{
 *   config: { ok: true, config: { version: string, lang: string } } | { ok: false, reason: string },
 *   state: { version: string, lang: string, files: string[] } | null,
 *   lock: { present: false } | { present: true, ageMs: number },
 *   failure: { present: false } | { present: true, text: string | null },
 *   missingFiles: string[],
 *   sectionPresent: { claude: boolean, codex: boolean }
 * }} facts
 */
export function decideInstall(facts) {
  if (!facts.config.ok) return { action: "fail", reason: facts.config.reason };
  if (facts.lock.present) return { action: "busy", stale: facts.lock.ageMs > STALE_LOCK_MS };
  if (facts.failure.present) return { action: "install", reason: "failed" };
  if (facts.state === null) return { action: "install", reason: "no-state" };
  const { version, lang } = facts.config.config;
  if (version !== facts.state.version || lang !== facts.state.lang) {
    return { action: "install", reason: "config-changed" };
  }
  if (facts.missingFiles.length > 0) return { action: "install", reason: "files-missing" };
  if (!facts.sectionPresent.claude || !facts.sectionPresent.codex) {
    return { action: "install", reason: "section-missing" };
  }
  return { action: "skip" };
}

/**
 * 消す対象の道筋を返す。両ツールのスキルのうち名前が kiro- で始まるものと、.kiro/settings。
 * 独自のスキル・.kiro/specs・.kiro/steering・.codex/agents は含めない（3.3）。
 * @param {{ claude: string[], codex: string[] }} entries ツールごとのスキルの名前（.claude/skills・.agents/skills の下）
 */
export function removalTargets(entries) {
  const kiroOnly = (names) => names.filter((name) => name.startsWith("kiro-"));
  return [
    ...kiroOnly(entries.claude).map((name) => `.claude/skills/${name}`),
    ...kiroOnly(entries.codex).map((name) => `.agents/skills/${name}`),
    ".kiro/settings"
  ];
}

/**
 * cc-sdd が解釈する manifest をツールごとに組み立てる。
 * スキル・標準の文書（Claude Code は CLAUDE.md、Codex は AGENTS.md。リポジトリの直下へ）・設定の雛形。Codex の既定のエージェント定義は含めない。
 * @param {"claude" | "codex"} tool
 */
export function buildManifest(tool) {
  const doc = tool === "claude" ? "CLAUDE.md" : "AGENTS.md";
  return {
    version: 1,
    artifacts: [
      {
        id: "skills",
        source: { type: "templateDir", fromDir: "templates/agents/{{AGENT}}/skills", toDir: "{{AGENT_COMMANDS_DIR}}" }
      },
      {
        id: "doc_main",
        source: { type: "templateFile", from: `templates/agents/{{AGENT}}/docs/${doc}`, toDir: "." }
      },
      {
        id: "settings_templates",
        source: { type: "templateDir", fromDir: "templates/shared/settings/templates", toDir: "{{KIRO_DIR}}/settings/templates" }
      }
    ]
  };
}

/**
 * npx に渡す引数をシェル展開なしで配列として返す。ツールごとにスキルの指定だけが変わる。
 * @param {{ version: string, lang: string }} config
 * @param {"claude" | "codex"} tool
 * @param {string} manifestPath
 */
export function npxArgs(config, tool, manifestPath) {
  const skills = tool === "claude" ? "--claude-skills" : "--codex-skills";
  return ["--yes", `cc-sdd@${config.version}`, "--yes", "--overwrite", "force", "--manifest", manifestPath, skills, "--lang", config.lang];
}

/** 導入成功を利用者へ知らせる。Claude Code 向けと Codex 向けの導入物と両文書を書き換えたことを伝える */
export function messageInstalled(config) {
  return `cc-sdd ${config.version}（言語: ${config.lang}）を導入しました。Claude Code・Codex の両方について、スキル（.claude/skills/kiro-*・.agents/skills/kiro-*）、.kiro/settings/、CLAUDE.md・AGENTS.md を書き換え、運用の区画を末尾へ書き足しました。`;
}

/** 入れ直しを省いたことを利用者へ知らせる */
export function messageSkipped(config) {
  return `cc-sdd ${config.version}（言語: ${config.lang}）は揃っているため、入れ直しを省きました。`;
}

/** 手順書の置き場所（ツールごと）。Claude Code は .claude/skills、Codex は .agents/skills */
const SKILL_DIRS = { claude: ".claude/skills", codex: ".agents/skills" };

/**
 * 一覧に載らないスキルの手順書を直接読む旨を伝える。
 * 入力の先頭の空白を除いて /kiro-xxx または $kiro-xxx で始まるなら、その手順書の道筋を名指しする。
 * @param {"claude" | "codex"} tool
 * @param {string} prompt 利用者の入力
 */
export function messageReadSkillDirectly(tool, prompt) {
  const dir = SKILL_DIRS[tool];
  if (dir === undefined) throw new TypeError(`未知のツールです: ${tool}`);
  const generic = `スキル一覧に載らないスキル（kiro-discovery・kiro-impl など）は、依頼に対応する ${dir}/<名前>/SKILL.md を Read して、その手順を最後まで実行してください。`;
  const named = /^\s*[/$](kiro-[A-Za-z0-9_-]+)/.exec(prompt);
  if (named === null) return generic;
  return `${generic}\n今回の依頼は ${named[1]} なので、${dir}/${named[1]}/SKILL.md を Read して手順を最後まで実行してください。`;
}

/**
 * 導入が止まった理由と復旧の方法を示す。
 * 失敗は詳細（無ければ完了を確認できない旨）と再試行のコマンド。導入中は別のセッション、古い印は中断の可能性と、印を消して再試行する 1 行。
 * @param {{ kind: "failed", detail: string | null } | { kind: "busy", stale: boolean }} input
 */
export function messageBlocked(input) {
  if (input.kind === "failed") {
    const why = input.detail === null
      ? "理由の詳細は取得できず、導入の完了を確認できない。"
      : `理由: ${input.detail}`;
    return `cc-sdd の導入が完了していないため、入力を止めています。${why}\n通常の端末で次を実行して再試行してください（Claude の外で実行する）: ${RETRY_COMMAND}`;
  }
  if (!input.stale) {
    return `別のセッションで導入中のため、入力を止めています。導入が終わってから、通常の端末で次を実行して再試行してください（Claude の外で実行する）: ${RETRY_COMMAND}`;
  }
  return `導入中の印が残っています。中断した可能性があるため、入力を止めています。ほかに導入が進んでいないことを確かめてから、通常の端末で次の 1 行を実行してください（Claude の外で実行する）:\nrm ${LOCK_PATH} && ${RETRY_COMMAND}`;
}

/** クラウドの準備スクリプトに置く 1 行（<リポジトリ> は導入先のリポジトリのディレクトリ名） */
const PREPARE_LINE = `if [ -d <リポジトリ> ]; then (cd <リポジトリ> && ${RETRY_COMMAND}); fi`;

/** 利用手順: 準備スクリプトの 1 行、手元での初回の始め方、未導入の /kiro-* が拒否されたときの扱い */
export function messageUsage() {
  return [
    "【クラウド】環境の準備スクリプトに次の 1 行を足すと、Claude Code・Codex の起動前に cc-sdd を導入します。",
    `  ${PREPARE_LINE}`,
    "【手元】通常の文章による最初の入力で導入が始まります。",
    "最初から /kiro-* を使うなら、起動前に次のコマンドで導入を済ませてください。",
    `  ${RETRY_COMMAND}`,
    "未導入の /kiro-* が「Unknown command」などで拒否されたら、通常の文章で入力するか、起動前に導入し直してください。"
  ].join("\n");
}
