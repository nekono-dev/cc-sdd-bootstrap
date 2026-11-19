import { configFields, formatProblem } from "./config-schema.mjs";

export const CONFIG_FILE = ".cc-sdd-bootstrap.json";
export const UPDATE_COMMAND = "npx github:nekono-dev/cc-sdd-bootstrap update";
export const INIT_COMMAND = "npx github:nekono-dev/cc-sdd-bootstrap init";

const own = (o, k) => Object.hasOwn(o, k) ? o[k] : undefined;

/**
 * 設定ファイルのテキストを解析し、有効な設定オブジェクトまたは失敗理由を返す。
 * 不正な形式や欠損項目は日本語のメッセージで報告する。
 * @param {string | null} text
 * @returns {{ ok: true, config: { version: any, lang: any, keepTemplates: boolean } } | { ok: false, reason: string }}
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

  const ccSdd = (parsed.ccSdd && typeof parsed.ccSdd === "object" && !Array.isArray(parsed.ccSdd))
    ? parsed.ccSdd
    : {};

  const version = own(ccSdd, "version");
  const lang = own(ccSdd, "lang");
  const keepRaw = own(ccSdd, "keepTemplates");
  const keepTemplates = keepRaw === undefined ? false : keepRaw;

  const checks = [
    { path: "ccSdd.version", val: version },
    { path: "ccSdd.lang", val: lang },
    ...(keepRaw === undefined ? [] : [{ path: "ccSdd.keepTemplates", val: keepTemplates }])
  ];

  for (const c of checks) {
    const field = configFields.find((f) => f.path === c.path);
    if (field) {
      const err = field.validate(c.val);
      if (typeof err === "string") {
        return fail(`${CONFIG_FILE} の ${c.path}: ${err}`);
      }
    }
  }

  return { ok: true, config: { version, lang, keepTemplates } };
}

/** buildState: 設定と導入したファイルの指紋から、導入状態の記録を組み立てる */
export function buildState({ config, files }) {
  return {
    format: 1,
    version: config.version,
    lang: config.lang,
    keepTemplates: config.keepTemplates,
    files: { ...files }
  };
}

/** parseState: 導入状態の記録の文字列を厳密に検証して返す。読めない・形が違えば null */
export function parseState(text) {
  if (text === null) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const { format, version, lang, keepTemplates, files } = obj;
  if (format !== 1) return null;
  if (typeof version !== "string" || version.length === 0) return null;
  if (typeof lang !== "string" || lang.length === 0) return null;
  if (typeof keepTemplates !== "boolean") return null;
  if (typeof files !== "object" || files === null || Array.isArray(files)) return null;
  for (const [path, fp] of Object.entries(files)) {
    if (typeof fp !== "string" || !/^[0-9a-f]{64}$/.test(fp)) return null;
    if (!isRelativePath(path)) return null;
  }
  return { format, version, lang, keepTemplates, files };
}

/** 相対の道筋か（絶対・`\` を含む・`..` や `.`・空の区間を含むものは外） */
function isRelativePath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.startsWith("/") || p.includes("\\")) return false;
  return !p.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

/** isFingerprintTarget: 指紋を取る対象かどうか。保持を選んだときは雛形の下を外す */
export function isFingerprintTarget(path, keepTemplates) {
  if (path.startsWith(".claude/skills/kiro-")) return true;
  if (path === ".kiro/settings/cc-sdd-guide.md") return true;
  if (path.startsWith(".kiro/settings/templates/")) return !keepTemplates;
  return false;
}
