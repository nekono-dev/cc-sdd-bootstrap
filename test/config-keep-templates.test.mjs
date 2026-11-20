import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configFields } from '../lib/config-schema.mjs';
import { fillDefaults } from '../lib/config.mjs';

// 検証用の文字列
const NOTICE_TEXT = '雛形（`.kiro/settings/templates/`）は cc-sdd の成果物（MIT ライセンス）。コミットする場合はそのライセンスに従う。保持すると cc-sdd の版を上げても雛形は入れ替わらない（入れ替えるには `.kiro/settings/templates/` を消して新しいセッションを開く）';
const ERROR_MESSAGE = 'true か false で指定してください';

test('ccSdd.keepTemplates の項目が存在し、正しいプロパティを持つ', () => {
  const field = configFields.find(f => f.path === 'ccSdd.keepTemplates');
  assert.ok(field, 'ccSdd.keepTemplates が見つかりません');
  assert.equal(field.flag, 'keep-templates');
  assert.equal(field.kind, 'boolean');
  assert.equal(field.defaultValue, false);
  assert.equal(field.question, 'cc-sdd の雛形（.kiro/settings/templates/）を上書きせずに保持し、コミットできるようにしますか');
});

test('ccSdd.keepTemplates が ccSdd.lang の直後に並ぶ', () => {
  const paths = configFields.map(f => f.path);
  const langIndex = paths.indexOf('ccSdd.lang');
  const keepTemplatesIndex = paths.indexOf('ccSdd.keepTemplates');

  assert.notEqual(langIndex, -1, 'ccSdd.lang が存在しません');
  assert.notEqual(keepTemplatesIndex, -1, 'ccSdd.keepTemplates が存在しません');
  assert.equal(keepTemplatesIndex, langIndex + 1, 'ccSdd.keepTemplates は ccSdd.lang の直後に来るべきです');
});

test('validate で true と false は null を返す', () => {
  const field = configFields.find(f => f.path === 'ccSdd.keepTemplates');
  assert.equal(field.validate(true), null);
  assert.equal(field.validate(false), null);
});

test('validate で不正な値はエラーメッセージを返す', () => {
  const field = configFields.find(f => f.path === 'ccSdd.keepTemplates');
  for (const value of ['yes', 1, null, undefined]) {
    assert.equal(field.validate(value), ERROR_MESSAGE, `value: ${String(value)}`);
  }
});

test('notice の文が完全に一致し、MIT と ライセンス を含む', () => {
  const field = configFields.find(f => f.path === 'ccSdd.keepTemplates');
  assert.ok(field.notice, 'notice プロパティが見つかりません');
  assert.equal(field.notice, NOTICE_TEXT);
  assert.ok(field.notice.includes('MIT'), 'notice に "MIT" を含むべきです');
  assert.ok(field.notice.includes('ライセンス'), 'notice に "ライセンス" を含むべきです');
});

test('notice を持つ項目は keepTemplates だけ', () => {
  const fieldsWithNotice = configFields.filter(f => f.notice !== undefined);
  assert.equal(fieldsWithNotice.length, 1, 'notice を持つ項目は 1 つだけです');
  assert.equal(fieldsWithNotice[0].path, 'ccSdd.keepTemplates');
});

test('fillDefaults で ccSdd.keepTemplates が既定値 false で補われる', () => {
  const config = { format: 1, ccSdd: { version: '3.1.0', lang: 'ja' }, clients: 'both', codex: { enabled: false }, models: {} };
  const { config: filledConfig, filled } = fillDefaults(config, configFields);
  assert.equal(filledConfig.ccSdd.keepTemplates, false);
  assert.deepEqual(filled, ['ccSdd.keepTemplates']);
});

test('fillDefaults は keepTemplates がすでにあれば上書きしない', () => {
  const config = { format: 1, ccSdd: { version: '3.1.0', lang: 'ja', keepTemplates: true }, clients: 'both', codex: { enabled: false }, models: {} };
  const { config: filledConfig, filled } = fillDefaults(config, configFields);
  assert.equal(filledConfig.ccSdd.keepTemplates, true);
  assert.deepEqual(filled, []);
});
