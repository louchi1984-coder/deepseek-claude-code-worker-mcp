import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const jobId = "dsw_restore_smoke";
const jobDir = `/tmp/deepseek-code-worker/jobs/${jobId}`;
const cwd = "/tmp/deepseek-worker-restore-smoke";

rmSync(jobDir, { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });
mkdirSync(jobDir, { recursive: true });
mkdirSync(cwd, { recursive: true });

writeFileSync(join(cwd, "sample.js"), "export const value = 2;\n");
writeFileSync(join(jobDir, "before-snapshot.json"), JSON.stringify([
  [
    "sample.js",
    {
      kind: "file",
      size: 24,
      hash: "smoke-before",
      content: "export const value = 1;\n",
    },
  ],
]));
writeFileSync(join(jobDir, "status.json"), JSON.stringify({
  id: jobId,
  status: "running",
  started_at: new Date(Date.now() - 60_000).toISOString(),
  updated_at: new Date(Date.now() - 30_000).toISOString(),
  cwd,
  use_case: "auto",
  worker_profile: "implementation",
  permission_mode: "acceptEdits",
  phase: "model_running",
  phase_message: "restore smoke",
  process_alive: true,
  process_pid: 99999999,
  output_format: "stream-json",
  ignored_dirs: [".git", "node_modules"],
  allowedRoots: [cwd],
  forbiddenPaths: [],
  checks: [],
  allow_docs_only: false,
}, null, 2));

const server = spawn("node", ["src/deepseek-worker-mcp.mjs"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});

const responses = [];
let stderr = "";
createInterface({ input: server.stdout }).on("line", (line) => {
  if (line.trim()) responses.push(JSON.parse(line));
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

send(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {} });
await waitForResponseId(1, 5000);
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
send(2, "tools/call", {
  name: "deepseek_get_job",
  arguments: { job_id: jobId },
});
send(3, "tools/call", {
  name: "deepseek_wait_for_job",
  arguments: { job_id: jobId, max_wait_ms: 10 },
});

const getJob = parseToolPayload(await waitForResponseId(2, 5000));
const waitJob = parseToolPayload(await waitForResponseId(3, 5000));
server.kill("SIGTERM");
rmSync(jobDir, { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });

console.log(JSON.stringify({
  get_status: getJob.status,
  get_observed_state: getJob.progress?.observed_state,
  wait_status: waitJob.status,
  wait_reason: waitJob.reason,
  changed_files: getJob.progress?.changed_files_so_far ?? [],
}, null, 2));

if (stderr) process.stderr.write(stderr);
if (
  getJob.status !== "orphaned"
  || getJob.progress?.observed_state !== "orphaned_after_mcp_restart"
  || waitJob.status !== "needs_review"
  || waitJob.reason !== "orphaned_after_mcp_restart"
  || !getJob.progress?.changed_files_so_far?.includes("sample.js")
) {
  process.exitCode = 1;
}

function send(id, method, params = {}) {
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
}

function parseToolPayload(response) {
  const text = response.result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

function waitForResponseId(id, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const interval = setInterval(() => {
      const response = responses.find((item) => item.id === id);
      if (response) {
        clearInterval(interval);
        resolvePromise(response);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(interval);
        server.kill("SIGTERM");
        reject(new Error(`Timed out waiting for response ${id}`));
      }
    }, 50);
  });
}
