import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TIERS,
  FAMILY_VENDOR,
  CHILD_MAX_TIER,
  EFFORT_ORDER,
  DEFAULT_MAX_EFFORT,
  familyOf,
  vendorOfFamily,
  childMaxTier,
  defaultEffortFor,
  defaultModelFor,
  resolveRole,
  resolveEffort,
  resolveModelName,
  definitionNameFor,
  renderDefinitions,
  DEFAULT_ROLES,
  effortCapFor,
  effortAbove,
  checkChildModel,
  compareTier,
  decideSpawn,
  messageSpawnDenied,
  messageConfigBroken,
  subagentsField,
  validateSubagents,
  VENDOR_EFFORTS,
  effortSupported,
  buildCliCommand,
} from "../.agent-hooks/cc-sdd-bootstrap/subagent-roles.mjs";

// 検証の失敗の理由を 1 つにまとめて返す補助
const problemsOf = (value) => {
  const r = validateSubagents(value);
  assert.equal(r.ok, false, "誤りが返るはず");
  return r.problems.join("\n");
};

test("既定の格と系統ごとの提供元", () => {
  assert.deepEqual(DEFAULT_TIERS, {
    haiku: 1, luna: 1, sonnet: 2, terra: 2, opus: 3, sol: 3, fable: 4, astra: 4,
  });
  assert.equal(FAMILY_VENDOR.sonnet, "claude");
  assert.equal(FAMILY_VENDOR.terra, "codex");
  assert.equal(CHILD_MAX_TIER, 3);
  assert.deepEqual(EFFORT_ORDER, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(DEFAULT_MAX_EFFORT, "high");
});

test("familyOf: 版の違う名前が同じ系統になる", () => {
  assert.equal(familyOf("gpt-6.1-terra", DEFAULT_TIERS), "terra");
  assert.equal(familyOf("gpt-6.2-terra", DEFAULT_TIERS), "terra");
  assert.equal(familyOf("claude-sonnet-5-5", DEFAULT_TIERS), "sonnet");
  assert.equal(familyOf("Claude-Sonnet-5-6", DEFAULT_TIERS), "sonnet");
  assert.equal(familyOf("opus", DEFAULT_TIERS), "opus");
  assert.equal(familyOf("gpt-4o", DEFAULT_TIERS), null);
});

test("familyOf: 長い語を先に照合する", () => {
  const tiers = { ...DEFAULT_TIERS, sol: 3, solar: 2 };
  assert.equal(familyOf("gpt-6-solar", tiers), "solar");
  assert.equal(familyOf("gpt-6-sol", tiers), "sol");
});

test("vendorOfFamily: 既定の系統は提供元を返し、足した語は null", () => {
  assert.equal(vendorOfFamily("haiku"), "claude");
  assert.equal(vendorOfFamily("astra"), "codex");
  assert.equal(vendorOfFamily("custom"), null);
});

test("childMaxTier: 未設定は格 3、maxModel の系統の格、格 3 を超えない", () => {
  assert.equal(childMaxTier("claude", {}), 3);
  assert.equal(childMaxTier("codex", {}), 3);
  assert.equal(childMaxTier("claude", { maxModel: { claude: "sonnet" } }), 2);
  assert.equal(childMaxTier("codex", { maxModel: { claude: "sonnet" } }), 3);
  assert.equal(childMaxTier("codex", { maxModel: { codex: "gpt-6.1-terra" } }), 2);
  assert.equal(childMaxTier("claude", { maxModel: { claude: "fable" } }), 3);
  // 設定で足した格も使える
  assert.equal(childMaxTier("claude", { tiers: { sonnet: 1 }, maxModel: { claude: "sonnet" } }), 1);
});

test("effortAbove: 弱い順の位置で比べる", () => {
  assert.equal(effortAbove("xhigh", "high"), true);
  assert.equal(effortAbove("high", "high"), false);
  assert.equal(effortAbove("low", "high"), false);
  assert.equal(effortAbove("ultra", "max"), true);
});

test("effortCapFor: 系統ごと → 共通 → 既定 high の順", () => {
  assert.equal(effortCapFor("sonnet", {}), "high");
  assert.equal(effortCapFor("sonnet", { maxEffort: { default: "xhigh" } }), "xhigh");
  assert.equal(
    effortCapFor("sonnet", { maxEffort: { default: "xhigh", sonnet: "medium" } }),
    "medium"
  );
  assert.equal(
    effortCapFor("opus", { maxEffort: { default: "xhigh", sonnet: "medium" } }),
    "xhigh"
  );
  assert.equal(effortCapFor(null, { maxEffort: { default: "max" } }), "max");
});

test("defaultEffortFor: 格 1 は high、ほかは medium、上限で下がる", () => {
  assert.equal(defaultEffortFor("haiku", {}), "high");
  assert.equal(defaultEffortFor("luna", {}), "high");
  assert.equal(defaultEffortFor("sonnet", {}), "medium");
  assert.equal(defaultEffortFor("opus", {}), "medium");
  assert.equal(defaultEffortFor("sol", {}), "medium");
  assert.equal(defaultEffortFor("haiku", { maxEffort: { haiku: "medium" } }), "medium");
  assert.equal(defaultEffortFor("sonnet", { maxEffort: { default: "low" } }), "low");
  // 設定で格を上書きすると既定の推論量も変わる
  assert.equal(defaultEffortFor("sonnet", { tiers: { sonnet: 1 } }), "high");
});

test("checkChildModel: 格 4・上限より上を判定する", () => {
  assert.deepEqual(checkChildModel("fable", {}), { ok: false, kind: "tier4", family: "fable" });
  assert.deepEqual(checkChildModel("gpt-7-astra", {}), { ok: false, kind: "tier4", family: "astra" });
  assert.deepEqual(checkChildModel("opus", {}), { ok: true });
  const cfg = { maxModel: { claude: "sonnet", codex: "sol" } };
  assert.deepEqual(checkChildModel("claude-opus-5", cfg), { ok: false, kind: "above-cap", family: "opus" });
  assert.deepEqual(checkChildModel("claude-sonnet-5-5", cfg), { ok: true });
  assert.deepEqual(checkChildModel("gpt-6.1-sol", cfg), { ok: true });
  assert.deepEqual(checkChildModel("gpt-6.1-terra", cfg), { ok: true });
  // 系統・提供元が分からなければ問題なし
  assert.deepEqual(checkChildModel("gpt-4o", cfg), { ok: true });
  assert.deepEqual(checkChildModel("mymodel", { tiers: { mymodel: 3 } }), { ok: true });
  assert.deepEqual(checkChildModel("mymodel", { tiers: { mymodel: 4 } }), {
    ok: false, kind: "tier4", family: "mymodel",
  });
});

test("compareTier: 上・同じ系統・問題なし・確認できない", () => {
  assert.equal(compareTier("opus", "sonnet", DEFAULT_TIERS), "higher");
  assert.equal(compareTier("claude-sonnet-5-5", "sonnet", DEFAULT_TIERS), "same-model");
  assert.equal(compareTier("haiku", "opus", DEFAULT_TIERS), "ok");
  assert.equal(compareTier("terra", "claude-sonnet-5-5", DEFAULT_TIERS), "ok");
  assert.equal(compareTier("gpt-4o", "opus", DEFAULT_TIERS), "unknown");
  assert.equal(compareTier("sonnet", null, DEFAULT_TIERS), "unknown");
  assert.equal(compareTier("sonnet", "mystery", DEFAULT_TIERS), "unknown");
});

test("validateSubagents: 空・未指定は成功", () => {
  assert.deepEqual(validateSubagents({}), { ok: true, config: {} });
  assert.deepEqual(validateSubagents(undefined), { ok: true, config: {} });
});

test("validateSubagents: 正しい設定は成功する", () => {
  const cfg = {
    tiers: { mymodel: 2 },
    modelIds: { sonnet: "claude-sonnet-5-5" },
    maxModel: { claude: "sonnet", codex: "sol" },
    maxEffort: { default: "high", sonnet: "medium" },
    roles: {
      claude: {
        implement: { provider: "same", model: "haiku", effort: "high", permission: "write" },
        review: { provider: "other", model: "gpt-6.1-terra", effort: "medium" },
      },
      codex: { review: { permission: "read-only" } },
    },
  };
  assert.deepEqual(validateSubagents(cfg), { ok: true, config: cfg });
});

test("validateSubagents: オブジェクトでなければ誤り", () => {
  assert.match(problemsOf("x"), /^subagents/);
  assert.match(problemsOf([]), /^subagents/);
  assert.match(problemsOf(null), /^subagents/);
});

test("validateSubagents: 格は正の整数", () => {
  for (const bad of [0, -1, 1.5, "2", null]) {
    assert.match(problemsOf({ tiers: { foo: bad } }), /subagents\.tiers\.foo/);
  }
  assert.match(problemsOf({ tiers: { "": 1 } }), /subagents\.tiers/);
  assert.match(problemsOf({ tiers: [1] }), /subagents\.tiers/);
});

test("validateSubagents: modelIds は空でない文字列", () => {
  assert.match(problemsOf({ modelIds: { sonnet: "" } }), /subagents\.modelIds\.sonnet/);
  assert.match(problemsOf({ modelIds: { sonnet: 3 } }), /subagents\.modelIds\.sonnet/);
});

test("validateSubagents: maxModel は自分の提供元の系統で格 3 以下", () => {
  assert.match(problemsOf({ maxModel: { gemini: "sonnet" } }), /subagents\.maxModel\.gemini/);
  assert.match(problemsOf({ maxModel: { claude: "terra" } }), /subagents\.maxModel\.claude/);
  assert.match(problemsOf({ maxModel: { codex: "sonnet" } }), /subagents\.maxModel\.codex/);
  assert.match(problemsOf({ maxModel: { claude: "fable" } }), /subagents\.maxModel\.claude/);
  assert.match(problemsOf({ maxModel: { claude: "unknown-thing" } }), /subagents\.maxModel\.claude/);
  // 系統の語と完全に一致するものだけを受け付ける（版付き・部分一致は誤り）
  assert.match(problemsOf({ maxModel: { claude: "claude-sonnet-5-5" } }), /subagents\.maxModel\.claude/);
  assert.match(problemsOf({ maxModel: { claude: "not-a-sonnet-model" } }), /subagents\.maxModel\.claude/);
  assert.match(problemsOf({ maxModel: { codex: "gpt-6.1-terra" } }), /subagents\.maxModel\.codex/);
  assert.match(problemsOf({ maxModel: { claude: "" } }), /subagents\.maxModel\.claude/);
  assert.match(problemsOf({ maxModel: { claude: 1 } }), /subagents\.maxModel\.claude/);
  // 設定で格を下げれば fable も上限にできる
  assert.equal(validateSubagents({ tiers: { fable: 3 }, maxModel: { claude: "fable" } }).ok, true);
});

test("validateSubagents: 明示のモデルを委任先の提供元の上限と比べる", () => {
  const base = { tiers: { nova: 3 }, maxModel: { codex: "terra" } };
  // other の委任先は codex。提供元が分からない系統でも格で比べる
  assert.match(
    problemsOf({ ...base, roles: { claude: { review: { provider: "other", model: "gpt-7-nova" } } } }),
    /subagents\.roles\.claude\.review\.model/
  );
  // provider の明示が無ければ既定（review は other）
  assert.match(
    problemsOf({ ...base, roles: { claude: { review: { model: "gpt-7-nova" } } } }),
    /subagents\.roles\.claude\.review\.model/
  );
  // same の委任先は claude（上限は未設定で格 3）なので通る
  assert.equal(
    validateSubagents({ ...base, roles: { claude: { implement: { provider: "same", model: "nova" } } } }).ok,
    true
  );
  // codex が指揮役で other なら委任先は claude
  assert.match(
    problemsOf({
      tiers: { nova: 3 }, maxModel: { claude: "haiku" },
      roles: { codex: { review: { model: "nova" } } },
    }),
    /subagents\.roles\.codex\.review\.model/
  );
  // 格 4 以上も誤り
  assert.match(
    problemsOf({ tiers: { nova: 4 }, roles: { claude: { review: { model: "nova" } } } }),
    /subagents\.roles\.claude\.review\.model/
  );
});

test("validateSubagents: maxEffort のキーと値", () => {
  assert.match(problemsOf({ maxEffort: { default: "turbo" } }), /subagents\.maxEffort\.default/);
  assert.match(problemsOf({ maxEffort: { nothing: "high" } }), /subagents\.maxEffort\.nothing/);
  assert.match(problemsOf({ maxEffort: { sonnet: 5 } }), /subagents\.maxEffort\.sonnet/);
  assert.equal(validateSubagents({ maxEffort: { default: "ultra", opus: "low" } }).ok, true);
});

test("validateSubagents: 役割・提供元の名前、各項目の型", () => {
  assert.match(problemsOf({ roles: { gemini: {} } }), /subagents\.roles\.gemini/);
  assert.match(problemsOf({ roles: { claude: { design: {} } } }), /subagents\.roles\.claude\.design/);
  assert.match(
    problemsOf({ roles: { claude: { review: { provider: "both" } } } }),
    /subagents\.roles\.claude\.review\.provider/
  );
  assert.match(
    problemsOf({ roles: { claude: { review: { effort: "turbo" } } } }),
    /subagents\.roles\.claude\.review\.effort/
  );
  assert.match(
    problemsOf({ roles: { claude: { review: { permission: "rw" } } } }),
    /subagents\.roles\.claude\.review\.permission/
  );
  assert.match(
    problemsOf({ roles: { claude: { review: { model: "" } } } }),
    /subagents\.roles\.claude\.review\.model/
  );
  assert.match(
    problemsOf({ roles: { claude: { review: { unknownKey: 1 } } } }),
    /subagents\.roles\.claude\.review\.unknownKey/
  );
  assert.match(problemsOf({ roles: { claude: { review: "x" } } }), /subagents\.roles\.claude\.review/);
});

test("validateSubagents: 明示のモデルが格 4・上限より上なら誤り", () => {
  assert.match(
    problemsOf({ roles: { claude: { implement: { model: "fable" } } } }),
    /subagents\.roles\.claude\.implement\.model/
  );
  assert.match(
    problemsOf({
      maxModel: { claude: "sonnet" },
      roles: { claude: { implement: { model: "claude-opus-5" } } },
    }),
    /subagents\.roles\.claude\.implement\.model/
  );
  assert.equal(
    validateSubagents({
      maxModel: { claude: "sonnet" },
      roles: { claude: { implement: { model: "claude-sonnet-5-5" } } },
    }).ok,
    true
  );
});

test("validateSubagents: 明示の推論量が明示のモデルの系統の上限より上なら誤り", () => {
  assert.match(
    problemsOf({
      maxEffort: { sonnet: "medium" },
      roles: { claude: { implement: { model: "sonnet", effort: "high" } } },
    }),
    /subagents\.roles\.claude\.implement\.effort/
  );
  // モデルが無ければ共通の上限（既定 high）と比べる
  assert.match(
    problemsOf({ roles: { claude: { review: { effort: "xhigh" } } } }),
    /subagents\.roles\.claude\.review\.effort/
  );
  // モデルが無いとき、系統ごとの上限は誤りにしない（定義と入口で下げる）
  assert.equal(
    validateSubagents({
      maxEffort: { sonnet: "low" },
      roles: { claude: { review: { effort: "high" } } },
    }).ok,
    true
  );
  assert.equal(
    validateSubagents({
      maxEffort: { default: "xhigh" },
      roles: { claude: { review: { effort: "xhigh" } } },
    }).ok,
    true
  );
});

test("validateSubagents: 複数の誤りは道筋つきですべて返る", () => {
  const text = problemsOf({
    tiers: { a: 0 },
    maxModel: { claude: "terra" },
    roles: { claude: { review: { permission: "rw" } } },
  });
  assert.match(text, /subagents\.tiers\.a/);
  assert.match(text, /subagents\.maxModel\.claude/);
  assert.match(text, /subagents\.roles\.claude\.review\.permission/);
});

test("subagentsField: 項目の形と検証", () => {
  assert.equal(subagentsField.path, "subagents");
  assert.equal(subagentsField.kind, "map");
  assert.deepEqual(subagentsField.defaultValue, {});
  assert.equal(subagentsField.validate({}), null);
  const msg = subagentsField.validate({ maxModel: { claude: "terra" }, tiers: { a: 0 } });
  assert.equal(typeof msg, "string");
  assert.match(msg, /subagents\.maxModel\.claude/);
  assert.match(msg, /subagents\.tiers\.a/);
  assert.match(msg, /、/);
});

// ---- 2.1 既定のモデルの決め方・役割の解決・起動の名前 ----

const ORCH = {
  haiku: { vendor: "claude", model: "claude-haiku-4-5" },
  sonnet: { vendor: "claude", model: "claude-sonnet-5-5" },
  opus: { vendor: "claude", model: "claude-opus-5" },
  fable: { vendor: "claude", model: "fable" },
  luna: { vendor: "codex", model: "gpt-6.1-luna" },
  terra: { vendor: "codex", model: "gpt-6.1-terra" },
  sol: { vendor: "codex", model: "gpt-6.1-sol" },
  astra: { vendor: "codex", model: "gpt-6.1-astra" },
};
const other = (v) => (v === "claude" ? "codex" : "claude");
// 提供元の違う子（既定の分担）の系統。自分で行うときは "self"
const familyFor = (cfg, orch, role, to) => {
  const r = resolveRole(cfg, orch.vendor, role, orch.model, to ? { to } : undefined);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.selfImplement ? "self" : familyOf(r.setting.model, DEFAULT_TIERS);
};

test("defaultModelFor: 例の表（8 人の指揮役 × 実装・レビュー/デバッグ・調査、上限なし）", () => {
  const table = {
    haiku: ["self", "luna", "luna"],
    sonnet: ["haiku", "terra", "luna"],
    opus: ["sonnet", "sol", "luna"],
    fable: ["opus", "sol", "terra"],
    luna: ["self", "haiku", "haiku"],
    terra: ["luna", "sonnet", "haiku"],
    sol: ["terra", "opus", "haiku"],
    astra: ["sol", "opus", "sonnet"],
  };
  for (const [name, [impl, rev, inv]] of Object.entries(table)) {
    const o = ORCH[name];
    assert.equal(familyFor({}, o, "implement"), impl, `${name} 実装`);
    assert.equal(familyFor({}, o, "review"), rev, `${name} レビュー`);
    assert.equal(familyFor({}, o, "debug"), rev, `${name} デバッグ`);
    assert.equal(familyFor({}, o, "investigate"), inv, `${name} 調査`);
  }
});

test("defaultModelFor: 直接呼ぶと family・self・none の形で返る", () => {
  const o = { vendor: "claude", tier: 2, family: "sonnet" };
  assert.deepEqual(defaultModelFor("implement", "claude", o, {}), { kind: "family", family: "haiku" });
  assert.deepEqual(defaultModelFor("review", "claude", { ...o, family: "haiku", tier: 1 }, {}), { kind: "self" });
  // 上限が低すぎて委任先に候補が無い（別の提供元）
  const cfg = { tiers: { luna: 5, terra: 5, sol: 5 }, maxModel: {} };
  const r = defaultModelFor("review", "codex", o, cfg);
  assert.equal(r.kind, "none");
  assert.ok(r.reason.length > 0);
});

test("1.3 の表: 格 2 の指揮役の既定（モデルと推論量）", () => {
  const claude = ORCH.sonnet;
  const codex = ORCH.terra;
  const expectClaude = { implement: ["haiku", "high"], review: ["terra", "medium"], investigate: ["luna", "high"], debug: ["terra", "medium"] };
  const expectCodex = { implement: ["luna", "high"], review: ["sonnet", "medium"], investigate: ["haiku", "high"], debug: ["sonnet", "medium"] };
  for (const [o, exp] of [[claude, expectClaude], [codex, expectCodex]]) {
    for (const [role, [fam, eff]] of Object.entries(exp)) {
      const r = resolveRole({}, o.vendor, role, o.model);
      assert.equal(r.ok, true);
      assert.equal(familyOf(r.setting.model, DEFAULT_TIERS), fam, `${o.vendor} ${role}`);
      assert.equal(r.effort, eff, `${o.vendor} ${role} 推論量`);
    }
  }
  const r = resolveRole({}, "claude", "implement", ORCH.sonnet.model);
  assert.equal(r.target, "claude");
  assert.equal(r.setting.permission, "write");
  assert.equal(resolveRole({}, "claude", "review", ORCH.sonnet.model).target, "codex");
  assert.equal(resolveRole({}, "claude", "review", ORCH.sonnet.model).setting.permission, "read-only");
});

test("子の上限（Claude Sonnet・Codex Sol）で下がる", () => {
  const cfg = { maxModel: { claude: "sonnet", codex: "sol" } };
  assert.equal(familyFor(cfg, ORCH.fable, "implement"), "sonnet");
  assert.equal(familyFor(cfg, ORCH.sol, "review"), "sonnet");
  assert.equal(familyFor(cfg, ORCH.astra, "review"), "sonnet");
  assert.equal(familyFor(cfg, ORCH.fable, "review"), "sol");
});

test("上限なしでも格 4 は選ばない", () => {
  for (const o of Object.values(ORCH)) {
    for (const role of ["implement", "review", "investigate", "debug"]) {
      const r = resolveRole({}, o.vendor, role, o.model);
      if (r.selfImplement) continue;
      assert.ok(DEFAULT_TIERS[familyOf(r.setting.model, DEFAULT_TIERS)] <= 3);
    }
  }
});

test("同じ提供元（--to same）は指揮役の系統を外す", () => {
  assert.equal(familyFor({}, ORCH.sonnet, "review", "same"), "haiku");
  assert.equal(familyFor({}, ORCH.opus, "review", "same"), "sonnet");
  assert.equal(familyFor({}, ORCH.haiku, "review", "same"), "self");
  assert.equal(familyFor({}, ORCH.luna, "investigate", "same"), "self");
  const r = resolveRole({}, "claude", "review", ORCH.sonnet.model, { to: "same" });
  assert.equal(r.target, "claude");
  assert.equal(r.setting.permission, "read-only");
});

test("自分で行う扱い: 実装の目標が格 1 未満", () => {
  const r = resolveRole({}, "claude", "implement", ORCH.haiku.model);
  assert.equal(r.ok, true);
  assert.equal(r.selfImplement, true);
});

test("指揮役のモデルが分からないときは格 2 として計算する", () => {
  const r = resolveRole({}, "claude", "review", null);
  assert.equal(familyOf(r.setting.model, DEFAULT_TIERS), "terra");
  const i = resolveRole({}, "codex", "implement", null);
  assert.equal(familyOf(i.setting.model, DEFAULT_TIERS), "luna");
  // 同じ提供元で系統が分からないときは指揮役の格（2）の系統を外す
  const s = resolveRole({}, "claude", "review", null, { to: "same" });
  assert.equal(familyOf(s.setting.model, DEFAULT_TIERS), "haiku");
});

test("候補が無いときは理由を返す", () => {
  const cfg = { tiers: { luna: 5, terra: 5, sol: 5 } };
  const r = resolveRole(cfg, "claude", "review", ORCH.sonnet.model);
  assert.equal(r.ok, false);
  assert.ok(r.reason.length > 0);
});

test("役割設定の明示値は置き換えず使う（完全な名前も保つ）", () => {
  const cfg = { roles: { claude: { review: { model: "gpt-6.1-sol", effort: "low", permission: "write" } } } };
  const r = resolveRole(cfg, "claude", "review", ORCH.sonnet.model);
  assert.equal(r.ok, true);
  assert.equal(r.setting.model, "gpt-6.1-sol");
  assert.equal(r.setting.permission, "write");
  assert.equal(r.setting.effort, "low");
  assert.equal(r.effort, "low");
  assert.deepEqual(r.notices, []);
  const p = resolveRole({ roles: { claude: { implement: { provider: "other" } } } }, "claude", "implement", ORCH.sonnet.model);
  assert.equal(p.target, "codex");
  assert.equal(familyOf(p.setting.model, DEFAULT_TIERS), "luna");
});

test("明示の推論量 high が Sonnet の上限 low で下がり知らせが出る（元の推論量は保つ）", () => {
  const cfg = {
    maxEffort: { default: "high", sonnet: "low" },
    roles: { codex: { review: { model: "sonnet", effort: "high" } } },
  };
  const r = resolveRole(cfg, "codex", "review", ORCH.terra.model);
  assert.equal(r.effort, "low");
  assert.equal(r.setting.effort, "high");
  assert.equal(r.notices.length, 1);
  assert.match(r.notices[0], /low/);
});

test("既定の推論量は上限まで下がる", () => {
  const cfg = { maxEffort: { haiku: "medium" } };
  const r = resolveRole(cfg, "claude", "implement", ORCH.sonnet.model);
  assert.equal(r.effort, "medium");
  assert.deepEqual(r.notices, []);
});

test("resolveEffort: 確定した子のモデルで推論量を求め直す", () => {
  const cfg = { maxEffort: { default: "high", sonnet: "low" } };
  assert.deepEqual(resolveEffort("high", "claude-sonnet-5-5", cfg).effort, "low");
  assert.equal(resolveEffort("high", "claude-sonnet-5-5", cfg).notices.length, 1);
  assert.deepEqual(resolveEffort("high", "claude-opus-5", cfg), { effort: "high", notices: [] });
  assert.deepEqual(resolveEffort(undefined, "claude-haiku-4-5", cfg), { effort: "high", notices: [] });
  assert.deepEqual(resolveEffort(undefined, "sonnet", cfg), { effort: "low", notices: [] });
  assert.equal(resolveEffort(undefined, "claude-opus-5", {}).effort, "medium");
});

test("同じ提供元への切り替えで、別の提供元の明示モデルは使わず知らせる", () => {
  const cfg = { roles: { claude: { review: { model: "gpt-6.1-sol" } } } };
  const r = resolveRole(cfg, "claude", "review", ORCH.opus.model, { to: "same" });
  assert.equal(r.ok, true);
  assert.equal(r.target, "claude");
  assert.equal(familyOf(r.setting.model, DEFAULT_TIERS), "sonnet");
  assert.notEqual(r.setting.model, "gpt-6.1-sol");
  assert.equal(r.notices.length, 1);
  assert.match(r.notices[0], /gpt-6\.1-sol/);
  // 明示が同じ提供元のモデルなら使う
  const ok = resolveRole({ roles: { claude: { review: { model: "claude-haiku-4-5" } } } }, "claude", "review", ORCH.opus.model, { to: "same" });
  assert.equal(ok.setting.model, "claude-haiku-4-5");
  assert.deepEqual(ok.notices, []);
});

test("definitionNameFor", () => {
  assert.equal(definitionNameFor("claude", "implement", "haiku"), "cc-sdd-implement-haiku");
  assert.equal(definitionNameFor("codex", "implement", "luna"), "cc_sdd_implement");
  const r = resolveRole({}, "claude", "implement", ORCH.sonnet.model);
  assert.equal(r.definitionName, "cc-sdd-implement-haiku");
});

test("DEFAULT_ROLES は役割ごとの提供元と権限", () => {
  assert.equal(DEFAULT_ROLES.claude.implement.provider, "same");
});

const CATALOG = [
  { slug: "gpt-6.2-sol", visibility: "list", priority: 1, levels: ["low", "high"] },
  { slug: "gpt-6.1-sol", visibility: "list", priority: 5, levels: [] },
  { slug: "gpt-6-luna", visibility: "list", priority: 8, levels: [] },
  { slug: "gpt-7-sol", visibility: "hide", priority: 0, levels: [] },
];

test("resolveModelName: Claude Code は別名、Codex は一覧の最新", () => {
  assert.deepEqual(resolveModelName("sonnet", "claude", {}, null), { ok: true, name: "sonnet" });
  assert.deepEqual(resolveModelName("sol", "codex", {}, CATALOG), { ok: true, name: "gpt-6.2-sol" });
  assert.deepEqual(resolveModelName("luna", "codex", {}, CATALOG), { ok: true, name: "gpt-6-luna" });
});

test("resolveModelName: 完全な名前 → modelIds の順で優先", () => {
  const cfg = { modelIds: { sol: "gpt-6.1-sol", sonnet: "claude-sonnet-5-5" } };
  assert.deepEqual(resolveModelName("sol", "codex", cfg, CATALOG), { ok: true, name: "gpt-6.1-sol" });
  assert.deepEqual(resolveModelName("sonnet", "claude", cfg, null), { ok: true, name: "claude-sonnet-5-5" });
  assert.deepEqual(resolveModelName("gpt-6.0-sol", "codex", cfg, CATALOG), { ok: true, name: "gpt-6.0-sol" });
  assert.deepEqual(resolveModelName("claude-opus-5", "claude", cfg, null), { ok: true, name: "claude-opus-5" });
});

test("resolveModelName: 一覧が無い・合うものが無いときは理由を返す", () => {
  for (const cat of [null, [], [{ slug: "gpt-6-luna", visibility: "list", priority: 1, levels: [] }]]) {
    const r = resolveModelName("sol", "codex", {}, cat);
    assert.equal(r.ok, false);
    assert.ok(r.reason.length > 0);
  }
  // modelIds があれば一覧が無くても求まる
  assert.equal(resolveModelName("sol", "codex", { modelIds: { sol: "x-sol" } }, null).name, "x-sol");
});

test("定義の名前は、生成される Claude の系統（上限以下）のときだけ返す", () => {
  // Codex の系統を明示した Claude 側の役割 → 定義は作られない
  const cfg = { roles: { claude: { implement: { model: "terra" } } } };
  const r = resolveRole(cfg, "claude", "implement", ORCH.opus.model);
  assert.equal(r.ok, true);
  assert.equal(r.setting.model, "terra");
  assert.equal(r.definitionName, null);
  assert.ok(r.notices.some((n) => /定義/.test(n)));
  // 子の上限より上の Claude の系統も対象外
  const up = resolveRole({ maxModel: { claude: "sonnet" }, roles: { claude: { implement: { model: "opus" } } } }, "claude", "implement", ORCH.fable.model);
  assert.equal(up.definitionName, null);
  // 対象内
  const ok = resolveRole({ roles: { claude: { implement: { model: "haiku" } } } }, "claude", "implement", ORCH.opus.model);
  assert.equal(ok.definitionName, "cc-sdd-implement-haiku");
  // Codex は書き込み可だけ
  assert.equal(resolveRole({}, "claude", "review", ORCH.sonnet.model).definitionName, null);
  assert.equal(resolveRole({}, "codex", "implement", ORCH.terra.model).definitionName, "cc_sdd_implement");
});

test("to: other で委任先と明示のモデルの提供元が食い違うときは黙って置き換えず理由を返す", () => {
  const cfg = { roles: { claude: { implement: { model: "haiku" } } } };
  const r = resolveRole(cfg, "claude", "implement", ORCH.opus.model, { to: "other" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /haiku/);
  // 指定なしは明示をそのまま使う
  const n = resolveRole(cfg, "claude", "implement", ORCH.opus.model);
  assert.equal(n.setting.model, "haiku");
  // 設定どおりの委任先への to: other は明示を使う
  const same = resolveRole({ roles: { claude: { review: { model: "gpt-6.1-sol" } } } }, "claude", "review", ORCH.opus.model, { to: "other" });
  assert.equal(same.setting.model, "gpt-6.1-sol");
});

// ---- 2.2 子の起動の判定と拒否の文言 ----
const spawn = (childModel, extra = {}) => ({
  vendor: "claude", childModel, childEffort: null, orchestratorModel: "claude-opus-5", ...extra,
});

test("decideSpawn: 未指定・inherit は拒否し、未指定の文言にコマンドが入る", () => {
  const a = decideSpawn(spawn(null), {});
  assert.equal(a.deny, true);
  assert.match(a.reason, /node \.agent-hooks\/cc-sdd-bootstrap\/delegate\.mjs --resolve-model --from claude --role <役割> --orchestrator-model <自分のモデル>/);
  const b = decideSpawn(spawn("inherit"), {});
  assert.equal(b.deny, true);
  assert.match(b.reason, /inherit/);
});

test("decideSpawn: 格 4（Fable・Astra）の子は拒否", () => {
  for (const m of ["claude-fable-5", "gpt-6.1-astra"]) {
    const r = decideSpawn(spawn(m, { orchestratorModel: null }), {});
    assert.equal(r.deny, true, m);
  }
});

test("decideSpawn: 上限 Sonnet で Opus の子は拒否", () => {
  const cfg = { maxModel: { claude: "sonnet" } };
  assert.equal(decideSpawn(spawn("claude-opus-5", { orchestratorModel: "claude-fable-5" }), cfg).deny, true);
  assert.equal(decideSpawn(spawn("claude-sonnet-5-5", { orchestratorModel: "claude-fable-5" }), cfg).deny, false);
});

test("decideSpawn: 上限 medium の系統で high は拒否、推論量が不明なら通す", () => {
  const cfg = { maxEffort: { sonnet: "medium" } };
  const base = { orchestratorModel: "claude-opus-5" };
  assert.equal(decideSpawn(spawn("claude-sonnet-5-5", { ...base, childEffort: "high" }), cfg).deny, true);
  assert.equal(decideSpawn(spawn("claude-sonnet-5-5", { ...base, childEffort: "medium" }), cfg).deny, false);
  assert.equal(decideSpawn(spawn("claude-sonnet-5-5", { ...base, childEffort: null }), cfg).deny, false);
});

test("decideSpawn: Sonnet の指揮役で sonnet・opus の子は拒否、haiku は通す", () => {
  const o = { orchestratorModel: "claude-sonnet-5-5" };
  assert.equal(decideSpawn(spawn("claude-sonnet-5-5", o), {}).deny, true);
  assert.equal(decideSpawn(spawn("claude-opus-5", o), {}).deny, true);
  assert.equal(decideSpawn(spawn("claude-haiku-5", o), {}).deny, false);
});

test("decideSpawn: 指揮役が不明、子の系統が不明なら通す", () => {
  assert.equal(decideSpawn(spawn("claude-opus-5", { orchestratorModel: null }), {}).deny, false);
  assert.equal(decideSpawn(spawn("mystery-model"), {}).deny, false);
});

test("messageSpawnDenied: 各種類の文言に理由と明示の必要が入る", () => {
  for (const kind of ["missing", "inherit", "same-model", "higher", "tier4", "above-cap", "effort"]) {
    const m = messageSpawnDenied(kind, { child: "c-model", orchestrator: "o-model", effort: "high", cap: "medium" });
    assert.match(m, /指揮役と異なる/, kind);
    assert.match(m, /指揮役の格以下/, kind);
    assert.match(m, /推論量の上限以下/, kind);
  }
  assert.match(messageSpawnDenied("effort", { child: "c", orchestrator: null, effort: "high", cap: "medium" }), /high.*medium/s);
  assert.doesNotMatch(messageSpawnDenied("tier4", { child: "c", orchestrator: null }), /--resolve-model/);
});

test("messageConfigBroken: 起動しないことと問題の項目と直し方が入る", () => {
  const m = messageConfigBroken(["subagents.maxModel.claude: 不正", "subagents.roles: 不正"]);
  assert.match(m, /起動しません/);
  assert.match(m, /subagents\.maxModel\.claude: 不正/);
  assert.match(m, /subagents\.roles: 不正/);
  assert.match(m, /\.cc-sdd-bootstrap\.json/);
  assert.match(m, /npx github:nekono-dev\/cc-sdd-bootstrap update/);
  assert.match(m, /node bin\/cc-sdd-bootstrap\.mjs update/);
});

// 各拒否の場合の reason に、その場合に固有の理由と共通の案内の条件が入る（3.7）
const GUIDE = ["指揮役と異なる", "指揮役の格以下", "子の上限以下", "推論量の上限以下"];
const denyCases = [
  ["missing", () => decideSpawn(spawn(null), {}), [/モデルが指定されていません/, /--resolve-model/]],
  ["inherit", () => decideSpawn(spawn("inherit"), {}), [/inherit/, /引き継ぎ/]],
  ["same-model", () => decideSpawn(spawn("claude-sonnet-5-5", { orchestratorModel: "claude-sonnet-5-5" }), {}), [/同じ系統/, /claude-sonnet-5-5/]],
  ["higher", () => decideSpawn(spawn("claude-opus-5", { orchestratorModel: "claude-sonnet-5-5" }), {}), [/上の格/, /claude-opus-5/, /claude-sonnet-5-5/]],
  ["tier4", () => decideSpawn(spawn("claude-fable-5", { orchestratorModel: null }), {}), [/格 4 以上/, /子に使いません/, /fable/]],
  ["above-cap", () => decideSpawn(spawn("claude-opus-5", { orchestratorModel: "claude-fable-5" }), { maxModel: { claude: "sonnet" } }), [/子の上限（maxModel）より上/, /子の系統: opus/]],
  ["effort", () => decideSpawn(spawn("claude-sonnet-5-5", { childEffort: "high" }), { maxEffort: { sonnet: "medium" } }), [/子の推論量: high/, /上限: medium/, /sonnet/]],
];
for (const [name, run, specific] of denyCases) {
  test(`decideSpawn の reason（${name}）: 固有の理由と案内の条件が入る`, () => {
    const r = run();
    assert.equal(r.deny, true);
    for (const re of specific) assert.match(r.reason, re);
    for (const g of GUIDE) assert.ok(r.reason.includes(g), `${g} が無い`);
    // 他の場合の理由とは混ざらない
    for (const [other, , res] of denyCases) {
      if (other === name) continue;
      assert.ok(!res.every((re) => re.test(r.reason)), `${other} の理由と区別できない`);
    }
  });
}
test("decideSpawn の reason: --resolve-model は未指定のときだけ", () => {
  for (const [name, run] of denyCases) {
    assert.equal(/--resolve-model/.test(run().reason), name === "missing", name);
  }
});

// ---- タスク 2.3: 役割定義の中身 ----

const claudeDefs = (cfg) => renderDefinitions(cfg).files.filter((f) => f.path.startsWith(".claude/agents/"));
const defByPath = (cfg, path) => renderDefinitions(cfg).files.find((f) => f.path === path);
const field = (content, key) => new RegExp(`^${key}: (.*)$`, "m").exec(content)?.[1];

test("renderDefinitions: 上限なしで 12・Sonnet で 8・Haiku で 4 の Claude Code の定義が出来て Fable は無い", () => {
  assert.equal(claudeDefs({}).length, 12);
  assert.equal(claudeDefs({ maxModel: { claude: "sonnet" } }).length, 8);
  assert.equal(claudeDefs({ maxModel: { claude: "haiku" } }).length, 4);
  assert.ok(!claudeDefs({}).some((f) => f.path.includes("fable")));
  assert.ok(defByPath({}, ".claude/agents/cc-sdd-implement-sonnet.md"));
});

test("renderDefinitions: 各定義の推論量（既定と系統ごとの上限）", () => {
  const eff = (cfg, p) => field(defByPath(cfg, p).content, "effort");
  assert.equal(eff({}, ".claude/agents/cc-sdd-review-haiku.md"), "high");
  assert.equal(eff({}, ".claude/agents/cc-sdd-review-sonnet.md"), "medium");
  assert.equal(eff({}, ".claude/agents/cc-sdd-review-opus.md"), "medium");
  const cfg = { maxEffort: { default: "high", sonnet: "low" } };
  assert.equal(eff(cfg, ".claude/agents/cc-sdd-review-sonnet.md"), "low");
  assert.equal(eff(cfg, ".claude/agents/cc-sdd-review-opus.md"), "medium");
  assert.equal(eff(cfg, ".claude/agents/cc-sdd-review-haiku.md"), "high");
  const low = { maxEffort: { default: "low" } };
  for (const f of claudeDefs(low)) assert.equal(field(f.content, "effort"), "low");
});

test("renderDefinitions: frontmatter・読み取り専用の道具・説明文", () => {
  const impl = defByPath({}, ".claude/agents/cc-sdd-implement-sonnet.md").content;
  assert.match(impl, /^---\n/);
  assert.equal(field(impl, "name"), "cc-sdd-implement-sonnet");
  assert.equal(field(impl, "model"), '"sonnet"');
  assert.ok(!/^tools:/m.test(impl));
  assert.match(field(impl, "description"), /Opus の指揮役/);
  assert.match(field(impl, "description"), /実装/);
  const rev = defByPath({}, ".claude/agents/cc-sdd-review-opus.md").content;
  assert.equal(field(rev, "tools"), "Read, Grep, Glob");
  assert.match(field(rev, "description"), /レビュー/);
  assert.match(field(rev, "description"), /別の提供元が使えないとき/);
});

test("renderDefinitions: 明示のモデルでその系統だけ・完全な名前はそのまま", () => {
  const cfg = { roles: { claude: { implement: { model: "claude-sonnet-5-5" } } } };
  const r = renderDefinitions(cfg);
  const impls = r.files.filter((f) => f.path.includes("cc-sdd-implement-"));
  assert.deepEqual(impls.map((f) => f.path), [".claude/agents/cc-sdd-implement-sonnet.md"]);
  assert.equal(field(impls[0].content, "model"), '"claude-sonnet-5-5"');
  assert.equal(r.files.filter((f) => f.path.includes("cc-sdd-review-")).length, 3);
});

test("renderDefinitions: Codex のモデルを明示した予備の役割は系統ごとに作られ知らせが出る", () => {
  const cfg = { roles: { claude: { review: { model: "sol" } } } };
  const r = renderDefinitions(cfg);
  assert.equal(r.files.filter((f) => f.path.includes("cc-sdd-review-")).length, 3);
  assert.ok(r.notices.some((n) => n.includes("sol") && n.includes("review")));
});

test("renderDefinitions: 2.1 の解決と定義の推論量が一致する", () => {
  const cfg = { maxEffort: { default: "high", sonnet: "low" }, roles: { claude: { implement: { model: "sonnet", effort: "high" } } } };
  const r = resolveRole(cfg, "claude", "implement", "opus");
  const def = defByPath(cfg, `.claude/agents/${r.definitionName}.md`);
  assert.equal(field(def.content, "effort"), r.effort);
  assert.equal(r.effort, "low");
  assert.ok(renderDefinitions(cfg).notices.some((n) => n.includes("low")));
  for (const fam of ["haiku", "sonnet", "opus"]) {
    const rr = resolveRole({ maxEffort: { sonnet: "low" } }, "claude", "review", fam === "opus" ? "fable" : "opus", { to: "same" });
    if (rr.ok && rr.definitionName) {
      const d = defByPath({ maxEffort: { sonnet: "low" } }, `.claude/agents/${rr.definitionName}.md`);
      assert.equal(field(d.content, "effort"), rr.effort);
    }
  }
});

test("renderDefinitions: ultra は作らず知らせる", () => {
  const cfg = { maxEffort: { default: "ultra" }, roles: { claude: { implement: { model: "sonnet", effort: "ultra" } } } };
  const r = renderDefinitions(cfg);
  assert.ok(!r.files.some((f) => f.path.includes("cc-sdd-implement-sonnet")));
  assert.ok(r.notices.some((n) => n.includes("ultra")));
});

test("renderDefinitions: Codex の定義は実装だけでモデルも推論量も持たない", () => {
  const r = renderDefinitions({});
  const codex = r.files.filter((f) => f.path.startsWith(".codex/agents/"));
  assert.deepEqual(codex.map((f) => f.path), [".codex/agents/cc_sdd_implement.toml"]);
  const c = codex[0].content;
  assert.match(c, /^name = "cc_sdd_implement"/m);
  assert.match(c, /^description = /m);
  assert.match(c, /^developer_instructions = /m);
  assert.ok(!/model/.test(c.replace(/developer_instructions.*/s, "")));
  for (const role of ["review", "investigate", "debug"]) {
    assert.ok(r.notices.includes(`Codex の組み込みの子では読み取り専用を適用できない（${role}）`));
  }
});

test("renderDefinitions: 引数に指揮役のモデルを取らず結果が決まる", () => {
  assert.equal(renderDefinitions.length, 1);
  assert.deepEqual(renderDefinitions({}), renderDefinitions({}));
});

// ---- タスク 2.3 の差し戻し対応 ----

test("renderDefinitions: 予備のレビューの説明文は同じ提供元の指揮役の系統の逆引き", () => {
  const d = (fam) => field(defByPath({}, `.claude/agents/cc-sdd-review-${fam}.md`).content, "description");
  assert.match(d("sonnet"), /Opus の指揮役/);
  assert.match(d("opus"), /Fable の指揮役/);
  assert.match(d("haiku"), /Sonnet の指揮役/);
  assert.match(d("sonnet"), /別の提供元が使えないとき/);
  assert.ok(!/Codex|Sol/.test(d("sonnet")));
  assert.match(field(defByPath({}, ".claude/agents/cc-sdd-implement-sonnet.md").content, "description"), /Opus の指揮役が実装・修正を任せるとき/);
});

test("renderDefinitions: roles.codex を変えても Claude Code の定義は変わらない", () => {
  const a = claudeDefs({});
  const b = claudeDefs({ roles: { codex: { review: { provider: "same", permission: "write" }, implement: { provider: "other" } } } });
  assert.deepEqual(a, b);
});

test("renderDefinitions: 明示のモデルの名前は YAML の文字列として保たれる", () => {
  const cfg = { roles: { claude: { implement: { model: "claude-sonnet-5-5 # fixed" } } } };
  const c = defByPath(cfg, ".claude/agents/cc-sdd-implement-sonnet.md").content;
  assert.equal(field(c, "model"), JSON.stringify("claude-sonnet-5-5 # fixed"));
});

test("renderDefinitions: 権限の設定が本文に反映される", () => {
  const body = (c) => c.split("---\n").pop();
  const w = defByPath({ roles: { claude: { review: { permission: "write" } } } }, ".claude/agents/cc-sdd-review-sonnet.md").content;
  assert.ok(!/^tools:/m.test(w));
  assert.match(body(w), /編集/);
  assert.ok(!/変更しません/.test(body(w)));
  const r = defByPath({ roles: { claude: { implement: { permission: "read-only" } } } }, ".claude/agents/cc-sdd-implement-sonnet.md").content;
  assert.match(body(r), /変更しません/);
  const cx = renderDefinitions({ roles: { codex: { review: { permission: "write" } } } }).files.find((f) => f.path === ".codex/agents/cc_sdd_review.toml");
  assert.ok(cx);
  assert.match(cx.content, /編集/);
  const cr = renderDefinitions({ roles: { codex: { implement: { permission: "read-only" } } } });
  assert.ok(!cr.files.some((f) => f.path.includes("cc_sdd_implement")));
});

test("VENDOR_EFFORTS: Claude Code は 5 つ、Codex は 6 つ", () => {
  assert.deepEqual(VENDOR_EFFORTS.claude, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(VENDOR_EFFORTS.codex, EFFORT_ORDER);
});

test("effortSupported: Claude Code は ultra を受け付けない", () => {
  for (const e of ["low", "medium", "high", "xhigh", "max"]) assert.equal(effortSupported("claude", e, null), true);
  assert.equal(effortSupported("claude", "ultra", null), false);
  // Claude Code では一覧があっても使わない
  assert.equal(effortSupported("claude", "ultra", ["low", "ultra"]), false);
});

test("effortSupported: Codex はモデルの一覧があればそれ、無ければ 6 つ", () => {
  const luna = ["low", "medium", "high", "xhigh", "max"];
  assert.equal(effortSupported("codex", "max", luna), true);
  assert.equal(effortSupported("codex", "ultra", luna), false);
  assert.equal(effortSupported("codex", "ultra", null), true);
  assert.equal(effortSupported("codex", "low", null), true);
  assert.equal(effortSupported("codex", "medium", ["high"]), false);
});

test("buildCliCommand: Codex の書き込み可・読み取り専用", () => {
  const w = buildCliCommand("codex", { permission: "write", effort: "high" }, "gpt-6.1-sol", "/work");
  assert.equal(w.command, "codex");
  assert.deepEqual(w.args, ["-a", "never", "exec", "--sandbox", "workspace-write", "--model", "gpt-6.1-sol",
    "--config", 'model_reasoning_effort="high"', "--cd", "/work", "-"]);
  const r = buildCliCommand("codex", { permission: "read-only", effort: "medium" }, "m", "/r");
  assert.equal(r.args[4], "read-only");
  assert.equal(r.args[8], 'model_reasoning_effort="medium"');
});

test("buildCliCommand: Claude Code の書き込み可・読み取り専用", () => {
  const w = buildCliCommand("claude", { permission: "write", effort: "high" }, "sonnet", "/work");
  assert.equal(w.command, "claude");
  assert.deepEqual(w.args, ["-p", "--model", "sonnet", "--effort", "high", "--permission-mode", "acceptEdits", "--allowedTools", "Bash"]);
  const r = buildCliCommand("claude", { permission: "read-only", effort: "low" }, "haiku", "/r");
  assert.deepEqual(r.args, ["-p", "--model", "haiku", "--effort", "low", "--tools", "Read,Grep,Glob"]);
});

test("buildCliCommand: Codex で bypassHookTrust が true のとき exec の直後に承認を省く指定を足す", () => {
  const w = buildCliCommand("codex", { permission: "write", effort: "high", bypassHookTrust: true }, "gpt-6.1-sol", "/work");
  assert.deepEqual(w.args, ["-a", "never", "exec", "--dangerously-bypass-hook-trust", "--sandbox", "workspace-write",
    "--model", "gpt-6.1-sol", "--config", 'model_reasoning_effort="high"', "--cd", "/work", "-"]);
  const r = buildCliCommand("codex", { permission: "read-only", effort: "medium", bypassHookTrust: true }, "m", "/r");
  assert.deepEqual(r.args, ["-a", "never", "exec", "--dangerously-bypass-hook-trust", "--sandbox", "read-only",
    "--model", "m", "--config", 'model_reasoning_effort="medium"', "--cd", "/r", "-"]);
});

test("buildCliCommand: bypassHookTrust が無い・false・true 以外のとき Codex の引数は今までと同じ", () => {
  const base = buildCliCommand("codex", { permission: "write", effort: "high" }, "gpt-6.1-sol", "/work");
  for (const value of [undefined, false, "true", 1, null]) {
    const got = buildCliCommand("codex", { permission: "write", effort: "high", bypassHookTrust: value }, "gpt-6.1-sol", "/work");
    assert.deepEqual(got.args, base.args, `bypassHookTrust=${JSON.stringify(value)} で引数が変わった`);
    assert.equal(got.args.includes("--dangerously-bypass-hook-trust"), false);
  }
  assert.deepEqual(base.args, ["-a", "never", "exec", "--sandbox", "workspace-write", "--model", "gpt-6.1-sol",
    "--config", 'model_reasoning_effort="high"', "--cd", "/work", "-"]);
});

test("buildCliCommand: 承認を省く指定のとき --config の値に hook・trust を含めない（設定に保存しない）", () => {
  const got = buildCliCommand("codex", { permission: "write", effort: "high", bypassHookTrust: true }, "m", "/work");
  for (let i = 0; i < got.args.length; i++) {
    if (got.args[i] !== "--config") continue;
    assert.doesNotMatch(got.args[i + 1], /hook|trust/i);
  }
  assert.equal(got.args.filter((a) => a === "--config").length, 1);
});

test("buildCliCommand: Claude で bypassHookTrust が true でも引数は今までと同じ", () => {
  const w = buildCliCommand("claude", { permission: "write", effort: "high", bypassHookTrust: true }, "sonnet", "/work");
  assert.deepEqual(w.args, ["-p", "--model", "sonnet", "--effort", "high", "--permission-mode", "acceptEdits", "--allowedTools", "Bash"]);
  const r = buildCliCommand("claude", { permission: "read-only", effort: "low", bypassHookTrust: true }, "haiku", "/r");
  assert.deepEqual(r.args, ["-p", "--model", "haiku", "--effort", "low", "--tools", "Read,Grep,Glob"]);
});
