#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const setupScript = resolve(root, "bin/deepseek-code-worker-setup.mjs");
const isGlobalInstall = process.env.npm_config_global === "true"
  || process.env.npm_config_location === "global";

if (process.env.DEEPSEEK_WORKER_SKIP_POSTINSTALL === "1") {
  process.exit(0);
}

if (!isGlobalInstall) {
  printNextSteps("Package installed locally.");
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  printNextSteps("Package installed globally.");
  process.exit(0);
}

if (!existsSync(setupScript)) {
  printNextSteps("Setup script was not found.");
  process.exit(0);
}

process.stdout.write("\nDeepSeek Code Worker MCP postinstall\n\n");
const result = spawnSync(process.execPath, [setupScript], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  process.stderr.write(`Postinstall setup could not start: ${result.error.message}\n`);
  printNextSteps("Run setup manually.");
  process.exit(0);
}

if (result.status !== 0) {
  printNextSteps("Setup did not complete.");
  process.exit(0);
}

printMcpConfig();

function printNextSteps(reason) {
  process.stdout.write(`\n${reason}\n`);
  process.stdout.write("Next steps:\n");
  process.stdout.write("  deepseek-code-worker-setup\n");
  process.stdout.write("  deepseek-code-worker-mcp --doctor\n\n");
  printMcpConfig();
}

function printMcpConfig() {
  process.stdout.write("MCP config:\n");
  process.stdout.write(JSON.stringify({
    mcpServers: {
      "deepseek-code-worker": {
        command: "deepseek-code-worker-mcp",
      },
    },
  }, null, 2));
  process.stdout.write("\n");
}
