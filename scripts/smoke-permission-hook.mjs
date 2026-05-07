import { spawn } from "node:child_process";

const config = {
  cwd: "/tmp/deepseek-worker-permission-smoke",
  allowed_dirs: ["/tmp/deepseek-worker-permission-smoke/src"],
  forbidden_paths: ["/tmp/deepseek-worker-permission-smoke/.env"],
  checks: ["node --check src/index.js"],
  worker_profile: "scoped_patch",
};

const cases = [
  {
    name: "approved check",
    input: { tool_name: "Bash", tool_input: { command: "node --check src/index.js" } },
    expect: "allow",
  },
  {
    name: "unapproved scoped bash",
    input: { tool_name: "Bash", tool_input: { command: "cat src/index.js" } },
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
    name: "forbidden path read",
    input: { tool_name: "Read", tool_input: { file_path: "/tmp/deepseek-worker-permission-smoke/.env" } },
    expect: "deny",
  },
];

const failures = [];
for (const item of cases) {
  const result = await runHook(item.input);
  const decision = result.output?.hookSpecificOutput?.permissionDecision ?? null;
  if (decision !== item.expect) {
    failures.push({ name: item.name, expected: item.expect, actual: decision, stderr: result.stderr });
  }
}

console.log(JSON.stringify({ cases: cases.length, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;

function runHook(input) {
  return new Promise((resolvePromise) => {
    const child = spawn("node", ["src/deepseek-worker-mcp.mjs", "--permission-hook"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        DEEPSEEK_WORKER_HOOK_CONFIG: JSON.stringify(config),
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
      resolvePromise({ exitCode, output, stderr });
    });
    child.stdin.end(JSON.stringify(input));
  });
}
