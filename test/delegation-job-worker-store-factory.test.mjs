import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegationJobStore } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-store.mjs";
import { createDefaultJobWorker } from "../.agent-hooks/cc-sdd-bootstrap/delegation-job-worker.mjs";

test("実 job store は既定 worker factory で動き、不正 track を起動前に拒否する", async () => {
  const root = await mkdtemp(join(tmpdir(), "delegation-default-factory-"));
  const project = join(root, "project"), runtime = join(root, "runtime");
  await Promise.all([mkdir(project), mkdir(runtime, { mode: 0o700 })]);
  try {
    const store = createDelegationJobStore({ root: runtime, writableRoots: [project], resolveWorktreeRoot: async () => project });
    let selected = 0;
    const worker = createDefaultJobWorker({ store, select: async () => { selected++; return { kind: "unavailable", reasons: ["適格候補なし"] }; } });
    const request = { requestId: "factory-store", project, cwd: project, role: "review", instruction: "確認", skill: "kiro-implement", taskId: "4.4", access: "read-only" };
    assert.deepEqual(await worker.start(request), { kind: "unavailable", reasons: ["適格候補なし"] }, "実 store の releaseTrack を含む契約で factory を構築する");
    assert.equal(selected, 1, "既定 worker が依頼を選択処理へ届ける");
    let malformedSelect = 0;
    const malformed = createDefaultJobWorker({ store: { ...store, track: 42 }, select: async () => { malformedSelect++; return { kind: "unavailable", reasons: [] }; } });
    assert.deepEqual(await malformed.start({ ...request, requestId: "factory-invalid-track" }),
      { kind: "unavailable", reasons: ["worker の依存関係が不正です"] });
    assert.equal(malformedSelect, 0, "不正な track 関数は選択や接続の前に拒否する");
  } finally { await rm(root, { recursive: true, force: true }); }
});
