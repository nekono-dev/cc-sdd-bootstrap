import { configFields, formatProblem } from "./config-schema.mjs";

export const CONFIG_FILE = ".cc-sdd-bootstrap.json";
export const UPDATE_COMMAND = "npx github:nekono-dev/cc-sdd-bootstrap update";
export const INIT_COMMAND = "npx github:nekono-dev/cc-sdd-bootstrap init";
export const FAILURE_RECORD = ".cache/cc-sdd-install.failed";
export const STATE_PATH = ".cache/cc-sdd-install.state.json";
export const RETRY_COMMAND = "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs";
export const NPX_TIMEOUT_MS = 540000;
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

/** 導入開始時に失敗の記録へ書く案内文 */
export const RECORD_IN_PROGRESS = `cc-sdd の導入が完了していません（導入中、または中断）。再試行: ${RETRY_COMMAND}（Claude の外で実行する）`;

/** 導入成功を利用者へ知らせる */
export function messageInstalled(config) {
  return `cc-sdd ${config.version}（言語: ${config.lang}）の導入物を更新しました（.claude/skills/kiro-*・.kiro/settings/）。\nCLAUDE.md は変更していません。`;
}

/** 入れ直しを省いたことを利用者へ知らせる */
export function messageSkipped(config) {
  return `cc-sdd ${config.version}（言語: ${config.lang}）は揃っているため、入れ直しを省きました。`;
}

/** 一覧に載らないスキルの使い方を案内する */
export function messageGuide() {
  return "スキル一覧に載らないスキル（kiro-discovery・kiro-impl など）は、依頼に対応する .claude/skills/<名前>/SKILL.md を Read して、その手順を最後まで実行してください。";
}

/** 失敗の理由と再試行方法を記録する文 */
export function failureRecordText(reason) {
  return `cc-sdd の導入に失敗しました。\n理由: ${reason}\n再試行: ${RETRY_COMMAND}（Claude の外で実行する）`;
}

/** セッション開始時に導入失敗を利用者へ知らせる */
export function messageFailed(reason) {
  return `cc-sdd の導入に失敗しました。理由: ${reason}\n次の入力は止まります。再試行: ${RETRY_COMMAND}（Claude の外で実行する）。新しいセッションを開くと再試行されます。`;
}
