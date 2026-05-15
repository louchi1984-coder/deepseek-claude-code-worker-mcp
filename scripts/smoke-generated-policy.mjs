import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JOB_ROOT } from "../src/core/config.mjs";

const jobId = "dsw_generated_policy_smoke";
const jobDir = join(JOB_ROOT, jobId);
const cwd = join(tmpdir(), "deepseek-worker-generated-policy-smoke");
const generated = "docs/WORKFLOW_EVAL_RESULTS.md";
const placeholder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: "ignore",
});

rmSync(jobDir, { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });
mkdirSync(jobDir, { recursive: true });
mkdirSync(join(cwd, "src"), { recursive: true });
mkdirSync(join(cwd, "docs"), { recursive: true });
writeFileSync(join(cwd, generated), "# generated eval output\n");
writeFileSync(join(jobDir, "before-snapshot.json"), JSON.stringify([]));
writeFileSync(join(jobDir, "status.json"), JSON.stringify({
  id: jobId,
  status: "running",
  started_at: new Date(Date.now() - 5_000).toISOString(),
  updated_at: new Date(Date.now() - 1_000).toISOString(),
  cwd,
  use_case: "auto",
  worker_profile: "scoped_patch",
  permission_mode: "dontAsk",
  phase: "model_running",
  phase_message: "generated policy smoke",
  process_alive: true,
  process_pid: placeholder.pid,
  output_format: "stream-json",
  ignored_dirs: [".git", "node_modules"],
  allowedRoots: [join(cwd, "src")],
  generatedRoots: [join(cwd, generated)],
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
server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
send(2, "tools/call", {
  name: "deepseek_get_job",
  arguments: { job_id: jobId },
});

const response = await waitForResponseId(2, 5000);
server.kill("SIGTERM");
placeholder.kill("SIGTERM");
rmSync(jobDir, { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });

const payload = parseToolPayload(response);
const policy = payload.progress?.policy_so_far ?? {};
const summary = payload.progress?.review_summary ?? {};
const checks = {
  policy_ok: policy.ok === true,
  generated_reported: policy.generated_changed?.includes(generated),
  not_outside_allowed: !policy.outside_allowed?.includes(generated),
  summary_reports_generated: summary.generated_changed?.includes(generated),
};

process.stdout.write(`${JSON.stringify({ ok: Object.values(checks).every(Boolean), checks, policy, summary }, null, 2)}\n`);
if (stderr) process.stderr.write(stderr);
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;

function send(id, method, params = {}) {
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function waitForResponseId(id, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const interval = setInterval(() => {
      const response = responses.find((item) => item.id === id);
      if (response) {
        clearInterval(interval);
        resolvePromise(response);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(interval);
        server.kill("SIGTERM");
        rejectPromise(new Error(`Timed out waiting for response ${id}`));
      }
    }, 100);
  });
}

function parseToolPayload(response) {
  const text = response.result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`No text payload: ${JSON.stringify(response)}`);
  return JSON.parse(text);
}
