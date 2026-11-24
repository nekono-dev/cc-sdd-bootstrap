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
  DEFAULT_ROLES,
  effortCapFor,
  effortAbove,
  checkChildModel,
  compareTier,
  subagentsField,
  validateSubagents,
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
