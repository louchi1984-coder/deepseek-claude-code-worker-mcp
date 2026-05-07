#!/usr/bin/env node
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

const wrapperName = basename(process.argv[1] ?? "claude-deepseek");
const defaults = modelDefaults(wrapperName);
const claudeBin = process.env.CLAUDE_BIN || resolveExecutable("claude") || join(homedir(), ".local/bin/claude");
const keyFile = process.env.DEEPSEEK_API_KEY_FILE || join(homedir(), ".codex/secrets/deepseek_api_key");

if (!isExecutable(claudeBin)) {
  fail(`Claude Code not found or not executable: ${claudeBin}\nSet CLAUDE_BIN to your Claude Code CLI path.`);
}

const env = { ...process.env };
if (!env.ANTHROPIC_AUTH_TOKEN) {
  if (!existsSync(keyFile)) {
    fail([
      `DeepSeek API key not found. Expected: ${keyFile}`,
      "Set ANTHROPIC_AUTH_TOKEN, set DEEPSEEK_API_KEY_FILE, or save the key to ~/.codex/secrets/deepseek_api_key.",
    ].join("\n"));
  }
  const key = readFileSync(keyFile, "utf8").replace(/[\n\r]/g, "");
  if (!key) fail(`DeepSeek API key file is empty: ${keyFile}`);
  env.ANTHROPIC_AUTH_TOKEN = key;
}

if (!env.CLAUDE_DEEPSEEK_KEEP_ANTHROPIC_API_KEY) {
  delete env.ANTHROPIC_API_KEY;
}

env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL || "https://api.deepseek.com/anthropic";
env.ANTHROPIC_MODEL = env.ANTHROPIC_MODEL || defaults.model;
env.ANTHROPIC_DEFAULT_OPUS_MODEL = env.ANTHROPIC_DEFAULT_OPUS_MODEL || defaults.model;
env.ANTHROPIC_DEFAULT_SONNET_MODEL = env.ANTHROPIC_DEFAULT_SONNET_MODEL || defaults.model;
env.ANTHROPIC_DEFAULT_HAIKU_MODEL = env.ANTHROPIC_DEFAULT_HAIKU_MODEL || defaults.haikuModel;
env.CLAUDE_CODE_SUBAGENT_MODEL = env.CLAUDE_CODE_SUBAGENT_MODEL || "deepseek-v4-flash";
env.CLAUDE_CODE_EFFORT_LEVEL = env.CLAUDE_CODE_EFFORT_LEVEL || defaults.effort;
env.API_TIMEOUT_MS = env.API_TIMEOUT_MS || "600000";
env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || "1";

const child = spawn(claudeBin, process.argv.slice(2), {
  stdio: "inherit",
  env,
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  fail(error.message);
});

function modelDefaults(name) {
  if (name.includes("flash")) {
    return { model: "deepseek-v4-flash", haikuModel: "deepseek-v4-flash", effort: "high" };
  }
  return { model: "deepseek-v4-pro[1m]", haikuModel: "deepseek-v4-flash", effort: "max" };
}

function resolveExecutable(command) {
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(path) {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
