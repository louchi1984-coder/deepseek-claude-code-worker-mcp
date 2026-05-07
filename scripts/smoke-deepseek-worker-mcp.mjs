import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const server = spawn("node", ["src/deepseek-worker-mcp.mjs"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});

const responses = [];
let nextId = 1;
let stderr = "";

createInterface({ input: server.stdout }).on("line", (line) => {
  if (line.trim()) responses.push(JSON.parse(line));
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

function send(method, params = {}) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return id;
}

mkdirSync("deepseek-worker-smoke", { recursive: true });
writeFileSync("deepseek-worker-smoke/math.js", "export function add(a, b) {\n  return a + b;\n}\n");

send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0.1.0" },
});
await waitForResponseId(1, 5000);
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
send("tools/call", {
  name: "deepseek_implement_in_workspace",
  arguments: {
    cwd: process.cwd(),
    task: "Edit deepseek-worker-smoke/math.js and add an exported divide(a, b) function that returns a / b. Do not create docs.",
    allowed_dirs: ["deepseek-worker-smoke"],
    timeout_ms: 300000,
  },
});

const response = await waitForResponseId(2, 330000);
server.kill("SIGTERM");
const text = response.result?.content?.[0]?.text ?? "";
const result = JSON.parse(text);
const file = readFileSync(resolve("deepseek-worker-smoke/math.js"), "utf8");
console.log(JSON.stringify({
  mcp_status: result.status,
  failure_reason: result.failure_reason,
  files_changed: result.files_changed,
  contains_divide: file.includes("function divide"),
}, null, 2));

if (stderr) process.stderr.write(stderr);
if (result.status !== "changed_files" || !file.includes("function divide")) {
  process.exitCode = 1;
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
    }, 100);
  });
}
