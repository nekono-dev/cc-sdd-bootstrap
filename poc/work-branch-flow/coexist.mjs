#!/usr/bin/env node
// PoC: 同じイベントに複数のフックが出力したとき、それぞれの理由・文脈が両方エージェントに届くか。
//   P: PreToolUse で 2 つのフックがどちらも拒否（理由が別）
//   U: UserPromptSubmit で 2 つのフックがどちらも追加の文脈を返す
//   B: UserPromptSubmit で 1 つが入力を止め（block）、もう 1 つが追加の文脈を返す
// 使い方: node poc/work-branch-flow/coexist.mjs
import { check, observe, summary, makeRepo, registerHooks, invoke, finalAnswer, succeeded } from './common.mjs';

const tools = ['claude', 'codex'];
const cases = [
  { id: 'P', entries: [{ event: 'PreToolUse', args: 'deny:理由ALPHA7-ブランチを切れ' }, { event: 'PreToolUse', args: 'deny:理由BRAVO9-手順書を読め' }],
    prompt: 'シェルで touch a.txt を実行してください。拒否されたら、拒否の理由を一字一句そのまま全部報告してください（実行を繰り返さなくてよい）。', marks: ['ALPHA7', 'BRAVO9'] },
  { id: 'U', entries: [{ event: 'UserPromptSubmit', args: 'context:文脈CHARLIE3-観点A' }, { event: 'UserPromptSubmit', args: 'context:文脈DELTA5-観点B' }],
    prompt: 'この入力に追加された追加の文脈（additional context）に書かれている「文脈」で始まる語を、すべてそのまま報告してください。ツールは使わないでください。', marks: ['CHARLIE3', 'DELTA5'] },
  { id: 'B', entries: [{ event: 'UserPromptSubmit', args: 'block:停止ECHO2-記録がありません' }, { event: 'UserPromptSubmit', args: 'context:文脈FOXTROT8-観点C' }],
    prompt: '追加の文脈に書かれた「文脈」で始まる語を報告してください。', marks: ['ECHO2', 'FOXTROT8'] },
];
for (const c of cases) {
  console.log(`\n## ${c.id}`);
  for (const tool of tools) {
    const dir = makeRepo(`co-${c.id}-${tool}`);
    registerHooks(dir, c.entries.map((e) => ({ ...e, matcher: '' })));
    const result = invoke(tool, dir, c.prompt);
    const text = `${finalAnswer(tool, result)}\n${result.stdout}`;
    observe(`${c.id} ${tool}: 最終の答え`, finalAnswer(tool, result).slice(0, 220).replace(/\n/g, ' '));
    for (const m of c.marks) {
      const inAnswer = finalAnswer(tool, result).includes(m);
      const anywhere = text.includes(m);
      (c.id === 'B' && m === 'FOXTROT8' ? observe : check)(`${c.id} ${tool}: ${m} が届いた（答え=${inAnswer}・出力のどこか=${anywhere}）`, ...(c.id === 'B' && m === 'FOXTROT8' ? [`答え=${inAnswer} 出力=${anywhere}`] : [inAnswer]));
    }
    if (!succeeded(result)) observe(`${c.id} ${tool}: 実行は異常終了`, String(result.status));
  }
}
summary();
