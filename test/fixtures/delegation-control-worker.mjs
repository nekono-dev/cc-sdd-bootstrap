import { runWorkerProcess, createJobWorker } from "../../.agent-hooks/cc-sdd-bootstrap/delegation-job-worker.mjs";
import { createDelegationJobStore } from "../../.agent-hooks/cc-sdd-bootstrap/delegation-job-store.mjs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";

let state = "running";
const project = resolve(process.argv[2]);
const runtime = process.env.XDG_RUNTIME_DIR;
const projectKey = createHash("sha256").update(project).digest("hex").slice(0, 24);
const store = createDelegationJobStore({ root: join(runtime, "cc-sdd-bootstrap", projectKey), writableRoots: [project], resolveWorktreeRoot: async () => project });
const worker = createJobWorker({
  select: async (request) => ({ kind: "mcp", access: request.access, model: "test-model", effort: "off", candidate: {} }),
  connect: async () => ({
    capabilities: async () => ({ kind: "agent", harness: "test", tier: "local", models: [{ id: "test-model", accepted: [{ access: "workspace-write", effort: "off" }, { access: "read-only", effort: "off" }] }] }),
    models: async () => ["test-model"],
    start: async () => ({ kind: "started", job: { serverId: "server-test", connectionId: "connection-test", jobId: "job-real-1" } }),
    status: async (jobId) => ({ jobId, status: state }),
    stop: async (jobId) => { state = "stopped"; return { jobId, status: "stopped" }; },
    close: async () => {},
  }), store, now: Date.now,
});

process.send?.({ event: "ready" });
process.once("message", (request) => {
  const stdin = new PassThrough();
  const stdout = new Writable({ write(chunk, encoding, callback) { process.send?.({ event: "output", text: String(chunk) }); callback(); } });
  const running = runWorkerProcess({ stdin, stdout, deps: { worker }, wait: () => new Promise((resolve) => setImmediate(resolve)) });
  stdin.end(`${JSON.stringify(request)}\n`);
  running.then(() => { setImmediate(() => process.send?.({ event: "stopped" })); })
    .catch((error) => { process.send?.({ event: "error", message: String(error) }); process.exitCode = 1; });
});
