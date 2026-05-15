import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const config = {
  cwd: "/tmp/deepseek-worker-permission-smoke",
  allowed_dirs: ["/tmp/deepseek-worker-permission-smoke/src"],
  generated_paths: ["/tmp/deepseek-worker-permission-smoke/docs/WORKFLOW_EVAL_RESULTS.md"],
  forbidden_paths: ["/tmp/deepseek-worker-permission-smoke/.env"],
  checks: ["node --check src/index.js"],
  worker_profile: "scoped_patch",
  safety_mode: "safe",
};

const permissiveConfig = { ...config, safety_mode: "permissive" };

const cases = [
  {
    name: "approved check",
    input: { tool_name: "Bash", tool_input: { command: "node --check src/index.js" } },
    expect: "allow",
  },
  {
    name: "safe readonly wc",
    input: { tool_name: "Bash", tool_input: { command: "wc -l src/index.js" } },
    expect: "allow",
  },
  {
    name: "safe readonly rg",
    input: { tool_name: "Bash", tool_input: { command: "rg \"function\" src" } },
    expect: "allow",
  },
  {
    name: "unapproved scoped bash",
    input: { tool_name: "Bash", tool_input: { command: "cat src/index.js" } },
    expect: "deny",
  },
  {
    name: "readonly command with redirect is denied",
    input: { tool_name: "Bash", tool_input: { command: "rg \"x\" src > out.txt" } },
    expect: "deny",
  },
  {
    name: "dangerous bash",
    input: { tool_name: "Bash", tool_input: { command: "rm -rf src" } },
    expect: "deny",
  },
  {
    name: "write inside allowed dirs",
    input: { tool_name: "Edit", tool_input: { file_path: "/tmp/deepseek-worker-permission-smoke/src/index.js" } },
    expect: null,
  },
  {
    name: "write outside allowed dirs",
    input: { tool_name: "Edit", tool_input: { file_path: "/tmp/deepseek-worker-permission-smoke/other.js" } },
    expect: "deny",
  },
  {
    name: "write generated side-effect path",
    input: { tool_name: "Edit", tool_input: { file_path: "/tmp/deepseek-worker-permission-smoke/docs/WORKFLOW_EVAL_RESULTS.md" } },
    expect: null,
  },
  {
    name: "forbidden path read",
    input: { tool_name: "Read", tool_input: { file_path: "/tmp/deepseek-worker-permission-smoke/.env" } },
    expect: "deny",
  },
];

const permissiveCases = [
  {
    name: "permissive allows ordinary bash",
    config: permissiveConfig,
    input: { tool_name: "Bash", tool_input: { command: "cat src/index.js" } },
    expect: "allow",
  },
  {
    name: "permissive still denies dangerous bash",
    config: permissiveConfig,
    input: { tool_name: "Bash", tool_input: { command: "rm -rf src" } },
    expect: "deny",
  },
];

const failures = [];
for (const item of cases) {
  const result = await runHook(item.input, item.config ?? config);
  const decision = result.output?.hookSpecificOutput?.permissionDecision ?? null;
  if (decision !== item.expect) {
    failures.push({ name: item.name, expected: item.expect, actual: decision, stderr: result.stderr });
  }
}

for (const item of permissiveCases) {
  const result = await runHook(item.input, item.config);
  const decision = result.output?.hookSpecificOutput?.permissionDecision ?? null;
  if (decision !== item.expect) {
    failures.push({ name: item.name, expected: item.expect, actual: decision, stderr: result.stderr });
  }
}

const hookLogDir = mkdtempSync(join(tmpdir(), "deepseek-worker-hook-log-"));
const toolEventsPath = join(hookLogDir, "tool-events.jsonl");
const postToolResult = await runHook({
  hook_event_name: "PostToolUse",
  tool_name: "Edit",
  tool_input: {
    file_path: "/tmp/deepseek-worker-permission-smoke/src/index.js",
    old_string: "secret old content",
    new_string: "secret new content",
  },
  tool_response: { success: true, duration_ms: 12 },
}, { ...config, tool_events_path: toolEventsPath });
if (postToolResult.stdout.trim() !== "") {
  failures.push({ name: "PostToolUse emits no permission decision", expected: "empty stdout", actual: postToolResult.stdout });
}
const hookLog = readFileSync(toolEventsPath, "utf8").trim();
const hookEvent = hookLog ? JSON.parse(hookLog.split(/\r?\n/).at(-1)) : null;
if (hookEvent?.event !== "PostToolUse" || hookEvent?.tool_name !== "Edit" || hookEvent?.path !== "src/index.js") {
  failures.push({ name: "tool hook summary", expected: "PostToolUse Edit src/index.js", actual: hookEvent });
}
if (/secret old content|secret new content/.test(hookLog)) {
  failures.push({ name: "tool hook redacts edit content", expected: "no edit content in hook log", actual: hookLog });
}
const postToolDangerous = await runHook({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf src" },
  tool_response: { success: true },
}, { ...config, tool_events_path: toolEventsPath });
if (postToolDangerous.stdout.trim() !== "") {
  failures.push({ name: "PostToolUse dangerous Bash is log-only", expected: "empty stdout", actual: postToolDangerous.stdout });
}
rmSync(hookLogDir, { recursive: true, force: true });

console.log(JSON.stringify({ cases: cases.length + permissiveCases.length + 2, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;

function runHook(input, hookConfig) {
  return new Promise((resolvePromise) => {
    const child = spawn("node", ["src/deepseek-worker-mcp.mjs", "--permission-hook"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        DEEPSEEK_WORKER_HOOK_CONFIG: JSON.stringify(hookConfig),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (exitCode) => {
      let output = null;
      if (stdout.trim()) output = JSON.parse(stdout);
      resolvePromise({ exitCode, output, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(input));
  });
}
