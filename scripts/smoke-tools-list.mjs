import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

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

send(1, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "tools-list-smoke", version: "0.1.0" },
});
await waitForResponseId(1, 5000);
server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
send(2, "tools/list");

const response = await waitForResponseId(2, 5000);
server.kill("SIGTERM");

const tools = response.result?.tools ?? [];
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const start = byName.get("deepseek_start_implementation");
const get = byName.get("deepseek_get_job");
const wait = byName.get("deepseek_wait_for_job");
const schema = start?.inputSchema?.properties ?? {};

const checks = {
  has_six_tools: tools.length === 6,
  start_mentions_async: /async DeepSeek V4 coding worker/.test(start?.description ?? ""),
  start_mentions_one_worker_per_task: /one clearly scoped implementation task/.test(start?.description ?? "")
    && /Do not start a second worker for the same task while the first job is running/.test(start?.description ?? ""),
  start_avoids_polling_instruction: !/poll compact status with deepseek_get_job/.test(start?.description ?? ""),
  start_mentions_default_max: /reasoning_effort=max/.test(start?.description ?? ""),
  start_has_title: start?.title === "Start DeepSeek worker job",
  start_has_output_schema: start?.outputSchema?.type === "object",
  get_mentions_omit_evidence: /omits stdout\/stderr, stream events, per-file diffs/.test(get?.description ?? ""),
  wait_mentions_not_main_loop: /not the main polling loop/.test(wait?.description ?? ""),
  task_schema_keeps_review_in_host: /final review in the host agent/.test(schema.task?.description ?? ""),
  task_schema_mentions_followup_context: /previous job_id, terminal status, failure\/check result, and current diff summary/.test(schema.task?.description ?? ""),
  generated_paths_schema_mentions_eval: /validation commands may generate, such as eval reports/.test(schema.generated_paths?.description ?? ""),
  use_case_schema_mentions_auto_max: /Defaults to auto.*reasoning_effort=max/.test(schema.use_case?.description ?? ""),
  start_schema_hides_poll_after: schema.poll_after_ms == null,
  no_extra_properties: start?.inputSchema?.additionalProperties === false,
};

process.stdout.write(`${JSON.stringify({
  ok: Object.values(checks).every(Boolean),
  checks,
  tool_names: tools.map((tool) => tool.name),
}, null, 2)}\n`);

if (stderr) process.stderr.write(stderr);
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;

function send(id, method, params = {}) {
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function waitForResponseId(id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const interval = setInterval(() => {
      const response = responses.find((item) => item.id === id);
      if (response) {
        clearInterval(interval);
        resolve(response);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(interval);
        server.kill("SIGTERM");
        reject(new Error(`Timed out waiting for response ${id}`));
      }
    }, 100);
  });
}
