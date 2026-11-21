import { test } from "node:test";
import assert from "node:assert/strict";
import { configFields } from "../lib/config-schema.mjs";
import { fillDefaults, findUnknownKeys, resolveValues, validateConfig } from "../lib/config.mjs";
import { readInstallConfig } from "../.agent-hooks/cc-sdd-bootstrap/install-rules.mjs";

const identity = { family: "pi", scope: "project", registrationName: "reviewer", registrationId: "opaque:1" };
const configWith = (delegation) => ({ format: 1, ccSdd: { version: "3.1.0", lang: "ja" }, clients: "both", codex: { enabled: true }, models: {}, delegation });

test("delegation は任意で、未指定と明示的な空候補列を区別して更新補完でも保持する", () => {
  const fields = configFields;
  const absent = fillDefaults(configWith(undefined), fields).config;
  delete absent.delegation;
  assert.equal(validateConfig(absent, fields), null);
  assert.equal(absent.codex.enabled, true);
  const explicit = configWith({ pi: { local: [], cloud: [] } });
  assert.equal(validateConfig(explicit, fields), null);
  assert.deepEqual(fillDefaults(explicit, fields).config.delegation, explicit.delegation);
  assert.deepEqual(resolveValues({ base: explicit, given: {}, prompted: {}, fields }).config.delegation, explicit.delegation);
  assert.deepEqual(findUnknownKeys(explicit, fields), []);
});

test("delegation は候補順と役割ごとの固定値または互換 ID を受理する", () => {
  const delegation = { pi: { local: [{ ...identity, models: { review: { compatibleIds: [] } } }, { ...identity, registrationId: "opaque:2", models: { manufacture: { fixed: "model-x" } } }], cloud: [] } };
  assert.equal(validateConfig(configWith(delegation), configFields), null);
  const parsed = readInstallConfig(JSON.stringify(configWith(delegation)));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.config.delegation, delegation);
  assert.equal(parsed.config.codex.enabled, true);
});

test("delegation の破損・相反するモデル指定・重複 ID・候補識別情報重複を拒否する", () => {
  const candidate = { ...identity, models: { review: { fixed: "m", compatibleIds: ["m"] } } };
  const cases = [
    { pi: { local: [candidate], cloud: [] } },
    { pi: { local: [{ ...identity, models: { review: { compatibleIds: ["m", "m"] } } }], cloud: [] } },
    { pi: { local: [{ ...identity, models: {} }, { ...identity, models: {} }], cloud: [] } },
    { pi: { local: [{ ...identity, models: { review: { compatibleIds: "m" } } }], cloud: [] } },
  ];
  for (const delegation of cases) {
    assert.notEqual(validateConfig(configWith(delegation), configFields), null);
    assert.equal(readInstallConfig(JSON.stringify(configWith(delegation))).ok, false);
  }
});
