#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface, emitKeypressEvents } from "node:readline";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DANGEROUS_BASH_DENY_RULES,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_CLAUDE_DEEPSEEK,
  DEFAULT_FORBIDDEN_PATHS,
  DEFAULT_FOREGROUND_WAIT_CAP_MS,
  DEFAULT_IDLE_AFTER_MS,
  DEFAULT_IGNORED_DIRS,
  DEFAULT_POLL_AFTER_MS,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SYNC_TIMEOUT_MS,
  JOB_ROOT,
  MAX_DIFF_CONTENT_BYTES,
  MAX_DIFF_LINES,
  MAX_FILE_BYTES,
  MAX_OUTPUT_CHARS,
  MAX_STREAM_EVENTS,
  SELF_SCRIPT,
  SERVER_VERSION,
  USE_CASES,
  WORKER_PROFILES,
} from "./core/config.mjs";
import {
  classifyClaudeEvent,
  compactClaudeEvent,
  consumeJsonLines,
  phaseFromClaudeEvent,
  summarizeClaudeEvent,
} from "./core/stream-events.mjs";

const jobs = new Map();
let shuttingDown = false;

const tools = [
  {
    name: "deepseek_implement_in_workspace",
    description:
      "Pure execution worker. Runs Claude Code through claude-deepseek in a real workspace, requires real file changes, and returns changed files plus validation status. Use for implementation tasks, not advice.",
    annotations: {
      title: "Run DeepSeek worker synchronously",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: implementationSchema({ includeAsync: false }),
  },
  {
    name: "deepseek_start_implementation",
    description:
      "Start a long-running pure execution worker job and return immediately with a job id. Poll with deepseek_get_job.",
    annotations: {
      title: "Start DeepSeek worker job",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: implementationSchema({ includeAsync: true }),
  },
  {
    name: "deepseek_get_job",
    description: "Get the current status/result of a deepseek_start_implementation job.",
    annotations: {
      title: "Read DeepSeek worker status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        include_logs: { type: "boolean", description: "Include stdout/stderr tails. Defaults to false to save caller tokens." },
        include_events: { type: "boolean", description: "Include recent stream-json events. Defaults to false." },
        include_diff: { type: "boolean", description: "Include per-file unified diffs from the final result. Defaults to false." },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "deepseek_tail_job",
    description: "Return compact running job progress and files changed so far. Logs/events are opt-in to save caller tokens.",
    annotations: {
      title: "Read DeepSeek worker tail",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        include_logs: { type: "boolean", description: "Include stdout/stderr tails. Defaults to false." },
        include_events: { type: "boolean", description: "Include recent stream-json events. Defaults to false." },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "deepseek_wait_for_job",
    description:
      "Observe a running DeepSeek worker job for a short foreground window. Returns completion/failure if done; otherwise returns running status and recent activity. Does not cancel or review the worker.",
    annotations: {
      title: "Observe DeepSeek worker job",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        max_wait_ms: {
          type: "number",
          description:
            "Caller-requested observation window. This is only a foreground observation helper; it does not control worker lifetime.",
        },
        poll_interval_ms: {
          type: "number",
          description: "Polling interval while observing. Defaults to the job's recommended poll interval.",
        },
        include_logs: { type: "boolean", description: "Include stdout/stderr tails if the job reaches a terminal state. Defaults to false." },
        include_events: { type: "boolean", description: "Include recent stream-json events. Defaults to false." },
        include_diff: { type: "boolean", description: "Include per-file unified diffs if the job reaches a terminal state. Defaults to false." },
        quiet_with_changes_ms: {
          type: "number",
          description: "Deprecated compatibility field. Running jobs are not marked needs_review by quiet time.",
        },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "deepseek_cancel_job",
    description: "Request cancellation of a running DeepSeek worker job.",
    annotations: {
      title: "Cancel DeepSeek worker job",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
];

if (process.argv.includes("--setup")) {
  runSetup().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
} else if (process.argv.includes("--doctor")) {
  runDoctor().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
} else if (process.argv.includes("--permission-hook")) {
  runPermissionHook().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
} else {
  installServerLifecycleHandlers();
  const rl = createInterface({ input: process.stdin });
  rl.on("close", () => {
    shutdownServer("stdio_closed", 0);
  });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `Parse error: ${error.message}` },
      });
      return;
    }

    if (!("id" in message)) return;

    try {
      const result = await handleRequest(message);
      write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error.message,
          data: error.data ?? undefined,
        },
      });
    }
  });
}

function installServerLifecycleHandlers() {
  process.stdin.on("end", () => {
    shutdownServer("stdin_ended", 0);
  });
  process.stdin.on("close", () => {
    shutdownServer("stdin_closed", 0);
  });
  process.on("SIGTERM", () => {
    shutdownServer("sigterm", 0);
  });
  process.on("SIGINT", () => {
    shutdownServer("sigint", 130);
  });
}

function shutdownServer(reason, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const job of jobs.values()) {
    if (!job || !["running", "cancel_requested"].includes(job.status)) continue;
    job.updated_at = new Date().toISOString();
    job.phase = "server_shutdown";
    job.phase_message = `MCP server shutting down: ${reason}`;
    job.last_error_kind = "mcp_server_shutdown";
    if (job.child && !job.child.killed) {
      job.cancel_requested = true;
      job.status = "cancel_requested";
      job.child.kill("SIGTERM");
      setTimeout(() => {
        if (job.child && !job.child.killed) job.child.kill("SIGKILL");
      }, 3000).unref();
    } else if (job.restored_from_disk && job.process_pid && processPidAlive(job.process_pid)) {
      job.cancel_requested = true;
      job.status = "cancel_requested";
      try {
        process.kill(job.process_pid, "SIGTERM");
      } catch {
        // Persisted PIDs can disappear between the liveness check and kill.
      }
    }
    writeJobStatus(job);
  }
  setTimeout(() => {
    process.exit(exitCode);
  }, 25).unref();
}

async function handleRequest(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "deepseek-code-worker", version: SERVER_VERSION },
      };
    case "tools/list":
      return { tools };
    case "tools/call":
      return callTool(message.params ?? {});
    default:
      throw new Error(`Unsupported method: ${message.method}`);
  }
}

async function runDoctor() {
  const checks = [];
  checks.push({
    name: "node_version",
    ok: Number(process.versions.node.split(".")[0]) >= 20,
    detail: process.version,
  });

  const claudeBin = process.env.CLAUDE_DEEPSEEK_BIN || DEFAULT_CLAUDE_DEEPSEEK;
  const resolvedClaudeBin = resolveExecutable(claudeBin);
  checks.push({
    name: "claude_deepseek",
    ok: Boolean(resolvedClaudeBin),
    detail: resolvedClaudeBin || `not found: ${claudeBin}`,
  });

  const claudeCodeBin = process.env.CLAUDE_BIN || resolveExecutable("claude") || defaultClaudeBin();
  checks.push({
    name: "claude_code_cli",
    ok: Boolean(resolveExecutable(claudeCodeBin)),
    detail: resolveExecutable(claudeCodeBin) || `not found or not executable: ${claudeCodeBin}`,
  });

  const keyFile = process.env.DEEPSEEK_API_KEY_FILE || resolve(homedir(), ".codex/secrets/deepseek_api_key");
  const hasToken = Boolean(process.env.ANTHROPIC_AUTH_TOKEN);
  const hasKeyFile = existsSync(keyFile);
  checks.push({
    name: "deepseek_auth",
    ok: hasToken || hasKeyFile,
    detail: hasToken
      ? "ANTHROPIC_AUTH_TOKEN is set"
      : hasKeyFile
        ? `key file exists: ${keyFile}`
        : `missing ANTHROPIC_AUTH_TOKEN and key file: ${keyFile}`,
  });

  try {
    mkdirSync(JOB_ROOT, { recursive: true });
    accessSync(JOB_ROOT, fsConstants.W_OK);
    checks.push({ name: "job_root_writable", ok: true, detail: JOB_ROOT });
  } catch (error) {
    checks.push({ name: "job_root_writable", ok: false, detail: `${JOB_ROOT}: ${error.message}` });
  }

  const invocation = buildClaudeDeepSeekInvocation({
    prompt: "<doctor-prompt>",
    permission_mode: "dontAsk",
    model: "deepseek-v4-flash",
    output_format: "stream-json",
    claude_settings: { permissions: { defaultMode: "dontAsk" } },
  });
  checks.push({
    name: "stream_json_args",
    ok: invocation.args.includes("--verbose")
      && invocation.args.includes("--include-partial-messages")
      && invocation.args.includes("--settings"),
    detail: previewClaudeArgs(invocation.args, "<doctor-prompt>").join(" "),
  });

  const payload = {
    server_version: SERVER_VERSION,
    ok: checks.every((check) => check.ok),
    checks,
    setup_hint: checks.every((check) => check.ok)
      ? null
      : "Run deepseek-code-worker-mcp --setup in a terminal to install/configure Claude Code with confirmation and save DeepSeek auth.",
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return payload.ok;
}

async function runSetup() {
  process.stdout.write("DeepSeek Code Worker MCP setup\n\n");

  const claudeCodeBin = process.env.CLAUDE_BIN || resolveExecutable("claude") || defaultClaudeBin();
  let resolvedClaudeCode = resolveExecutable(claudeCodeBin);
  if (resolvedClaudeCode) {
    process.stdout.write(`Claude Code CLI: ${resolvedClaudeCode}\n`);
  } else {
    process.stdout.write([
      `Claude Code CLI not found: ${claudeCodeBin}`,
      "",
    ].join("\n"));
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stdout.write("Run setup in an interactive terminal to install Claude Code, or set CLAUDE_BIN to the absolute path of the Claude Code executable.\n\n");
    } else {
      const answer = await promptText("Install Claude Code now with `npm install -g @anthropic-ai/claude-code`? [y/N] ");
      if (/^y(es)?$/i.test(answer.trim())) {
        const installed = await installClaudeCode();
        if (!installed) return false;
        resolvedClaudeCode = process.env.CLAUDE_BIN
          ? resolveExecutable(process.env.CLAUDE_BIN)
          : resolveExecutable("claude");
        if (!resolvedClaudeCode) {
          process.stderr.write("Claude Code install finished, but `claude` is still not on PATH. Set CLAUDE_BIN and rerun setup.\n");
          return false;
        }
        process.stdout.write(`Claude Code CLI: ${resolvedClaudeCode}\n`);
      } else {
        process.stdout.write("Skipped Claude Code install. Install it later or set CLAUDE_BIN before running worker jobs.\n");
      }
    }
  }

  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    process.stdout.write("DeepSeek auth: ANTHROPIC_AUTH_TOKEN is already set in the environment.\n");
    process.stdout.write("No key file was written.\n");
    return Boolean(resolvedClaudeCode);
  }

  const keyFile = process.env.DEEPSEEK_API_KEY_FILE || resolve(homedir(), ".codex/secrets/deepseek_api_key");
  if (existsSync(keyFile)) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stdout.write(`DeepSeek key file already exists at ${keyFile}.\n`);
      process.stdout.write("Run setup in an interactive terminal if you need to replace it.\n");
      return Boolean(resolvedClaudeCode);
    }
    const answer = await promptText(`DeepSeek key file already exists at ${keyFile}. Replace it? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      process.stdout.write("Keeping existing key file.\n");
      return Boolean(resolvedClaudeCode);
    }
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write([
      "Setup needs an interactive terminal to save a DeepSeek key.",
      `Alternatively write the key to ${keyFile} or set ANTHROPIC_AUTH_TOKEN.`,
      "",
    ].join("\n"));
    return false;
  }

  const key = (await promptSecret("Paste DeepSeek API key: ")).trim();
  if (!key) {
    process.stderr.write("No key entered; setup cancelled.\n");
    return false;
  }

  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    // Best effort. The write mode above is the primary protection.
  }
  process.stdout.write(`Saved DeepSeek key to ${keyFile}\n`);
  process.stdout.write("Run deepseek-code-worker-mcp --doctor to verify the environment.\n");
  return Boolean(resolvedClaudeCode);
}

async function installClaudeCode() {
  const npmBin = resolveExecutable("npm");
  if (!npmBin) {
    process.stderr.write("npm was not found on PATH, so setup cannot install Claude Code automatically.\n");
    process.stderr.write("Install Node/npm first, then rerun setup.\n");
    return false;
  }

  process.stdout.write("Installing Claude Code with npm install -g @anthropic-ai/claude-code ...\n");
  const npmInvocation = npmInstallInvocation(npmBin);
  const child = spawn(npmInvocation.command, npmInvocation.args, {
    stdio: "inherit",
    env: process.env,
  });

  const exitCode = await new Promise((resolveExit) => {
    child.once("error", (error) => {
      process.stderr.write(`Failed to start npm: ${error.message}\n`);
      resolveExit(1);
    });
    child.once("close", (code) => resolveExit(code ?? 1));
  });

  if (exitCode !== 0) {
    process.stderr.write(`Claude Code install failed with exit code ${exitCode}.\n`);
    return false;
  }
  return true;
}

function npmInstallInvocation(npmBin) {
  if (platform() === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm install -g @anthropic-ai/claude-code"],
    };
  }
  return { command: npmBin, args: ["install", "-g", "@anthropic-ai/claude-code"] };
}

async function callTool(params) {
  const name = params.name;
  const args = params.arguments ?? {};

  if (name === "deepseek_implement_in_workspace") {
    const result = await runImplementation(args, { sync: true });
    return toolResult(result);
  }

  if (name === "deepseek_start_implementation") {
    const jobId = `dsw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const prepared = prepareImplementation(args, { sync: false });
    const jobDir = join(JOB_ROOT, jobId);
    mkdirSync(jobDir, { recursive: true });
    const job = createJob(jobId, jobDir, prepared);
    jobs.set(jobId, job);
    writeJobRestoreData(job);
    writeJobStatus(job);
    runJobInBackground(prepared, job);
    return toolResult(startedJobResult(job, prepared));
  }

  if (name === "deepseek_get_job") {
    const job = getJob(args.job_id);
    if (!job) {
      return toolResult({ status: "not_found", job_id: args.job_id });
    }
    return toolResult(serializeJob(job, outputOptions(args)));
  }

  if (name === "deepseek_tail_job") {
    const job = getJob(args.job_id);
    if (!job) {
      return toolResult({ status: "not_found", job_id: args.job_id });
    }
    return toolResult({
      ...progressForJob(job),
      worker: workerStatus(job, outputOptions(args)),
      job_dir: job.job_dir,
      recommended_poll_after_ms: recommendedPollAfterMs(job),
      next_poll: nextPollHint(job),
    });
  }

  if (name === "deepseek_wait_for_job") {
    const result = await waitForJob(args);
    return toolResult(result);
  }

  if (name === "deepseek_cancel_job") {
    const job = getJob(args.job_id);
    if (!job) {
      return toolResult({ status: "not_found", job_id: args.job_id });
    }
    if (job.status !== "running") {
      return toolResult({ status: "not_running", job_id: job.id, current_status: job.status });
    }
    job.cancel_requested = true;
    job.status = "cancel_requested";
    job.updated_at = new Date().toISOString();
    if (job.child) {
      job.child.kill("SIGTERM");
    } else if (job.restored_from_disk && job.process_pid && processPidAlive(job.process_pid)) {
      try {
        process.kill(job.process_pid, "SIGTERM");
      } catch (error) {
        job.last_error_kind = "cancel_signal_failed";
        job.error = errorResult(error);
      }
    }
    writeJobStatus(job);
    return toolResult({ status: "cancel_requested", job_id: job.id });
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function runImplementation(rawArgs, options = {}) {
  return runImplementationPrepared(prepareImplementation(rawArgs, options));
}

function getJob(jobId) {
  if (typeof jobId !== "string" || jobId.length === 0) return null;
  const existing = jobs.get(jobId);
  if (existing) return existing;
  const restored = restoreJob(jobId);
  if (!restored) return null;
  jobs.set(jobId, restored);
  return restored;
}

function restoreJob(jobId) {
  const jobDir = join(JOB_ROOT, jobId);
  const statusPath = join(jobDir, "status.json");
  if (!existsSync(statusPath)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(statusPath, "utf8"));
  } catch (error) {
    return {
      id: jobId,
      status: "failed",
      started_at: null,
      started_ms: Date.now(),
      updated_at: new Date().toISOString(),
      phase: "restore_failed",
      phase_message: "Persisted job status could not be parsed.",
      job_dir: jobDir,
      stdout: readTextIfExists(join(jobDir, "stdout.log")),
      stderr: readTextIfExists(join(jobDir, "stderr.log")),
      child: null,
      process_alive: false,
      process_pid: null,
      restored_from_disk: true,
      restore_error: error.message,
      error: errorResult(error),
    };
  }

  const processAlive = data.status === "running"
    && data.process_pid
    && processPidAlive(data.process_pid);
  const orphaned = data.status === "running" && !processAlive;
  const job = {
    id: data.id ?? jobId,
    status: orphaned ? "orphaned" : (data.status ?? "unknown"),
    started_at: data.started_at ?? null,
    started_ms: restoreStartedMs(data),
    updated_at: new Date().toISOString(),
    recommended_poll_after_ms: data.recommended_poll_after_ms ?? DEFAULT_POLL_AFTER_MS,
    cwd: data.cwd ?? null,
    before: deserializeSnapshot(data.before ?? readJsonIfExists(join(jobDir, "before-snapshot.json"))),
    ignored_dirs: new Set([...DEFAULT_IGNORED_DIRS, ...arrayOfStrings(data.ignored_dirs)]),
    allowedRoots: arrayOfStrings(data.allowedRoots).length > 0
      ? arrayOfStrings(data.allowedRoots)
      : (data.cwd ? [data.cwd] : []),
    forbiddenPaths: arrayOfStrings(data.forbiddenPaths),
    checks: arrayOfStrings(data.checks),
    allow_docs_only: Boolean(data.allow_docs_only),
    use_case: data.use_case ?? null,
    worker_profile: data.worker_profile ?? null,
    model: data.model ?? null,
    thinking: data.thinking ?? null,
    reasoning_effort: data.reasoning_effort ?? null,
    preset_requires_review: Boolean(data.preset_requires_review),
    verification_profile: data.verification_profile ?? null,
    permission_mode: data.permission_mode ?? null,
    claude_settings_active: Boolean(data.claude_settings_active),
    phase: orphaned ? "orphaned" : (data.phase ?? data.status ?? "restored"),
    phase_message: orphaned
      ? "MCP restored this job from disk, but the recorded worker process is no longer alive. Treat artifacts as review-only."
      : (data.phase_message ?? "MCP restored this job from disk."),
    last_output_at_ms: data.last_output_at_ms ?? parseTimeMs(data.last_output_at),
    last_output_at: data.last_output_at ?? null,
    idle_after_ms: data.idle_after_ms ?? DEFAULT_IDLE_AFTER_MS,
    job_dir: jobDir,
    stdout: readTextIfExists(join(jobDir, "stdout.log")),
    stderr: readTextIfExists(join(jobDir, "stderr.log")),
    child: null,
    process_alive: processAlive,
    process_pid: processAlive ? data.process_pid : null,
    output_format: data.output_format ?? null,
    claude_args_preview: data.claude_args_preview ?? null,
    stream_events: Array.isArray(data.recent_events) ? data.recent_events : [],
    last_event_at_ms: data.last_event_at_ms ?? parseTimeMs(data.last_event_at),
    last_event_at: data.last_event_at ?? null,
    last_event_type: data.last_event_type ?? null,
    last_event_summary: data.last_event_summary ?? null,
    last_stream_kind: data.last_stream_kind ?? null,
    pending_tool_use: data.pending_tool_use ?? null,
    last_tool_use_at: data.last_tool_use_at ?? null,
    last_tool_result_at: data.last_tool_result_at ?? null,
    last_tool_name: data.last_tool_name ?? null,
    last_successful_tool: data.last_successful_tool ?? null,
    last_failed_tool: data.last_failed_tool ?? null,
    last_error_kind: orphaned ? "orphaned_after_mcp_restart" : (data.last_error_kind ?? null),
    tool_calls_since_last_change: data.tool_calls_since_last_change ?? 0,
    last_observed_change_count: data.last_observed_change_count ?? 0,
    cancel_requested: Boolean(data.cancel_requested),
    result: data.result ?? null,
    error: orphaned
      ? { message: "Worker process was not recoverable after MCP restart.", data: null }
      : (data.error ?? null),
    restored_from_disk: true,
  };
  if (orphaned) writeJobStatus(job);
  return job;
}

function createJob(jobId, jobDir, prepared) {
  const now = new Date().toISOString();
  return {
    id: jobId,
    status: "running",
    started_at: now,
    started_ms: Date.now(),
    updated_at: now,
    recommended_poll_after_ms: prepared.args.poll_after_ms,
    cwd: prepared.cwd,
    before: prepared.before,
    ignored_dirs: prepared.args.ignored_dirs,
    allowedRoots: prepared.allowedRoots,
    forbiddenPaths: prepared.forbiddenPaths,
    checks: prepared.args.checks,
    allow_docs_only: prepared.args.allow_docs_only,
    use_case: prepared.args.use_case,
    worker_profile: prepared.args.worker_profile,
    model: prepared.args.model,
    thinking: prepared.args.thinking,
    reasoning_effort: prepared.args.reasoning_effort,
    preset_requires_review: prepared.args.preset_requires_review,
    verification_profile: prepared.args.verification_profile,
      permission_mode: prepared.args.permission_mode,
      claude_settings_active: Boolean(prepared.claudeSettings),
      phase: "queued",
    phase_message: "Worker job accepted and waiting to start.",
    last_output_at_ms: null,
    last_output_at: null,
    idle_after_ms: prepared.args.idle_after_ms,
    job_dir: jobDir,
    stdout: "",
    stderr: "",
    child: null,
    process_alive: false,
    process_pid: null,
    output_format: prepared.args.output_format,
    claude_args_preview: previewClaudeArgs(buildClaudeDeepSeekInvocation({
      prompt: "<worker-prompt>",
      permission_mode: prepared.args.permission_mode,
      model: prepared.args.model,
      output_format: prepared.args.output_format,
      claude_settings: prepared.claudeSettings,
    }).args),
    stream_events: [],
    last_event_at_ms: null,
    last_event_at: null,
    last_event_type: null,
    last_event_summary: null,
    last_stream_kind: null,
    pending_tool_use: null,
    last_tool_use_at: null,
    last_tool_result_at: null,
    last_tool_name: null,
    last_successful_tool: null,
    last_failed_tool: null,
    last_error_kind: null,
    tool_calls_since_last_change: 0,
    last_observed_change_count: 0,
    cancel_requested: false,
    result: null,
    error: null,
  };
}

function runJobInBackground(prepared, job) {
  runImplementationPrepared(prepared, job)
    .then((result) => {
      job.status = isAcceptedResultStatus(result.status) ? "completed" : "failed";
      job.result = result;
      finishJobProcess(job);
    })
    .catch((error) => {
      job.status = "failed";
      job.error = errorResult(error);
      finishJobProcess(job);
    });
}

function finishJobProcess(job) {
  job.updated_at = new Date().toISOString();
  job.child = null;
  job.process_alive = false;
  writeJobStatus(job);
}

function startedJobResult(job, prepared) {
  return {
    status: "started",
    job_id: job.id,
    started_at: job.started_at,
    job_dir: job.job_dir,
    use_case: job.use_case,
    worker_profile: job.worker_profile,
    model: job.model,
    thinking: job.thinking,
    reasoning_effort: job.reasoning_effort,
    preset_requires_review: job.preset_requires_review,
    verification_profile: job.verification_profile,
    permission_mode: job.permission_mode,
    claude_settings_active: Boolean(job.claude_settings_active),
    phase: job.phase,
    phase_message: job.phase_message,
    output_format: job.output_format,
    claude_args_preview: job.claude_args_preview,
    recommended_poll_after_ms: recommendedPollAfterMs(job),
    next_poll: nextPollHint(job),
  };
}

function prepareImplementation(rawArgs, options = {}) {
  const args = normalizeArgs(rawArgs, options);
  const cwd = assertInside(resolve(args.cwd), resolve(args.cwd), "cwd");
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`cwd is not a directory: ${cwd}`);
  }

  const allowedRoots = normalizeRoots(cwd, args.allowed_dirs);
  const forbiddenPaths = normalizeForbidden(cwd, args.forbidden_paths);
  const before = snapshotWorkspace(cwd, args.ignored_dirs);

  const workerPrompt = buildWorkerPrompt(args, allowedRoots, forbiddenPaths);
  const claudeSettings = buildClaudeSettings(args, cwd);
  return { args, cwd, allowedRoots, forbiddenPaths, before, workerPrompt, claudeSettings };
}

async function runImplementationPrepared(prepared, job = null) {
  const { args, cwd, allowedRoots, forbiddenPaths, before, workerPrompt, claudeSettings } = prepared;
  setJobPhase(job, "model_running", modelRunningMessage(args));
  const worker = await runClaudeDeepSeek({
    cwd,
    prompt: workerPrompt,
    timeout_ms: args.timeout_ms,
    claude_deepseek_bin: args.claude_deepseek_bin,
    permission_mode: args.permission_mode,
    model: args.model,
    reasoning_effort: args.reasoning_effort,
    thinking: args.thinking,
    output_format: args.output_format,
    claude_settings: claudeSettings,
    job,
  });

  setJobPhase(job, "snapshotting", "Worker finished model execution; scanning workspace changes.");
  const after = snapshotWorkspace(cwd, args.ignored_dirs);
  const changes = diffSnapshots(before, after);
  const changedFiles = changes.map((change) => change.path).sort();
  const policy = evaluatePolicy({
    cwd,
    changedFiles,
    allowedRoots,
    forbiddenPaths,
    allow_docs_only: args.allow_docs_only,
  });

  const checks = [];
  if (changedFiles.length > 0 && policy.ok && args.checks.length > 0) {
    setJobPhase(job, "checking", "Workspace changed; running requested validation checks.");
    for (const check of args.checks) {
      checks.push(await runCheck(cwd, check, args.check_timeout_ms));
    }
  }

  const checkFailures = checks.filter((check) => check.exit_code !== 0 || check.timed_out);
  const gitInfo = await gitSummary(cwd);
  const outcome = classifyOutcome({ changedFiles, policy, checkFailures, worker, presetRequiresReview: args.preset_requires_review });
  setJobPhase(job, isAcceptedResultStatus(outcome.status) ? "completed" : "failed", outcome.status === "changed_files"
    ? "Worker completed with accepted file changes."
    : outcome.status === "partial_caller_timeout"
      ? "Caller timeout stopped the worker after it produced policy-compliant changes. Treat as partial and review before trusting."
      : outcome.status === "partial_cancelled"
        ? "Cancellation stopped the worker after it produced policy-compliant changes. Treat as partial and review before trusting."
      : "Worker finished, but the success contract was not satisfied.");

  const { fileDiffs, diffAvailable } = computeFileDiffs(before, after, changes);
  const reviewSummary = buildReviewSummary({
    changedFiles,
    diffAvailable,
    policy,
    checks,
    failureReason: outcome.failure_reason,
    requiresReview: outcome.requires_review,
    job,
  });

  return {
    status: outcome.status,
    cwd,
    files_changed: changedFiles,
    change_count: changedFiles.length,
    file_diffs: fileDiffs,
    diff_available: diffAvailable,
    policy,
    partial: outcome.partial,
    requires_review: outcome.requires_review,
    review_hint: outcome.review_hint,
    review_summary: reviewSummary,
    use_case: args.use_case,
    worker_profile: args.worker_profile,
    model: args.model,
    thinking: args.thinking,
    reasoning_effort: args.reasoning_effort,
    preset_requires_review: args.preset_requires_review,
    verification_profile: args.verification_profile,
    permission_mode: args.permission_mode,
    claude_settings_active: Boolean(claudeSettings),
    output_format: args.output_format,
    checks_run: checks,
    worker: {
      exit_code: worker.exit_code,
      timed_out: worker.timed_out,
      cancelled: worker.cancelled,
      claude_args_preview: worker.claude_args_preview,
      output_format: worker.output_format,
      events_seen: worker.events_seen,
      last_event_type: worker.last_event_type,
      last_event_summary: worker.last_event_summary,
      stdout_tail: tail(worker.stdout),
      stderr_tail: tail(worker.stderr),
    },
    git: gitInfo,
    failure_reason: outcome.failure_reason,
    completed_at: new Date().toISOString(),
  };
}

function normalizeArgs(args, options = {}) {
  if (!args.cwd || typeof args.cwd !== "string") {
    throw new Error("cwd is required");
  }
  if (!args.task || typeof args.task !== "string") {
    throw new Error("task is required");
  }
  const useCase = normalizeUseCase(args.use_case);
  const preset = USE_CASES[useCase];
  const worker_profile = normalizeWorkerProfile(args.worker_profile);
  const profile = WORKER_PROFILES[worker_profile];
  const model = typeof args.model === "string" && args.model.length > 0
    ? args.model
    : preset.model;
  const thinking = normalizeThinking(args.thinking ?? preset.thinking);
  const reasoning_effort = normalizeReasoningEffort(args.reasoning_effort ?? preset.reasoning_effort);
  const output_format = normalizeOutputFormat(args.output_format ?? preset.output_format);
  const verification_profile = normalizeVerificationProfile(args.verification_profile ?? preset.verification_profile);
  const allow_docs_only = Boolean(args.allow_docs_only ?? preset.allow_docs_only ?? false);
  const preset_requires_review = Boolean(preset.requires_review ?? false);
  const timeout_ms = normalizeOptionalNumber(
    args.timeout_ms,
    options.sync ? DEFAULT_SYNC_TIMEOUT_MS : null
  );
  const poll_after_ms = positiveNumber(
    args.poll_after_ms,
    preset.poll_after_ms ?? DEFAULT_POLL_AFTER_MS,
    "poll_after_ms"
  );
  const idle_after_ms = Number(args.idle_after_ms ?? preset.idle_after_ms ?? DEFAULT_IDLE_AFTER_MS);
  const allowed_dirs = arrayOfStrings(args.allowed_dirs);
  const forbidden_paths = arrayOfStrings(args.forbidden_paths).length > 0
    ? arrayOfStrings(args.forbidden_paths)
    : DEFAULT_FORBIDDEN_PATHS;
  const permission_mode = args.permission_mode || profile.permission_mode;

  if (permission_mode === "bypassPermissions" && worker_profile !== "scoped_patch") {
    throw new Error("permission_mode bypassPermissions requires worker_profile: scoped_patch.");
  }
  if (permission_mode === "bypassPermissions") {
    throw new Error("bypassPermissions is disabled by this MCP build; use worker_profile scoped_patch with dontAsk policy settings, or run in a real sandbox before re-enabling it.");
  }
  if (profile.requires_allowed_dirs && allowed_dirs.length === 0) {
    throw new Error("allowed_dirs is required when worker_profile is scoped_patch; pass a narrow file or directory scope.");
  }

  return {
    cwd: args.cwd,
    task: args.task,
    use_case: useCase,
    worker_profile,
    allowed_dirs,
    forbidden_paths,
    checks: arrayOfStrings(args.checks),
    ignored_dirs: new Set([...DEFAULT_IGNORED_DIRS, ...arrayOfStrings(args.ignored_dirs)]),
    timeout_ms,
    check_timeout_ms: Number(args.check_timeout_ms ?? DEFAULT_CHECK_TIMEOUT_MS),
    poll_after_ms,
    idle_after_ms,
    allow_docs_only,
    claude_deepseek_bin: args.claude_deepseek_bin || process.env.CLAUDE_DEEPSEEK_BIN || DEFAULT_CLAUDE_DEEPSEEK,
    permission_mode,
    model,
    thinking,
    reasoning_effort,
    preset_requires_review,
    verification_profile,
    output_format,
  };
}

function buildWorkerPrompt(args, allowedRoots, forbiddenPaths) {
  const useCase = USE_CASES[args.use_case] ?? USE_CASES.auto;
  const profile = WORKER_PROFILES[args.worker_profile] ?? WORKER_PROFILES.implementation;
  const allowed = allowedRoots.map((root) => relative(args.cwd, root) || ".").join(", ");
  const forbidden = forbiddenPaths.map((path) => relative(args.cwd, path)).join(", ");
  const checks = args.checks.length > 0 ? args.checks.join(" && ") : "none requested";
  return [
    "You are a pure execution coding worker. Your success condition is real workspace code changes.",
    "The host agent decides task boundaries. Execute this one clearly scoped implementation task yourself.",
    "Do not spawn subagents or use Task unless the caller explicitly asks for nested worker delegation.",
    "Do not write plans, reports, or documentation unless the task explicitly asks for documentation.",
    "Do not stop after analysis. Edit files directly.",
    "Prefer Claude Code Read for reading files; do not use Bash cat/sed just to read source files.",
    "Prefer Edit or MultiEdit for file changes; do not use shell redirection, heredoc, or script-generated rewrites for normal edits.",
    "If a tool or permission is blocked, report the blocker and stop instead of retrying in place.",
    "After editing, list changed files exactly and run requested checks when possible.",
    `Workspace: ${args.cwd}`,
    `Allowed paths: ${allowed}`,
    `Forbidden paths: ${forbidden || "none"}`,
    `Checks requested by caller: ${checks}`,
    `DeepSeek V4 use case: ${args.use_case}`,
    `Worker profile: ${args.worker_profile}`,
    profile.prompt,
    `DeepSeek V4 model target: ${args.model}`,
    `Thinking mode: ${args.thinking}; reasoning effort: ${args.reasoning_effort}`,
    `Verification profile: ${args.verification_profile}`,
    `Use-case guidance: ${useCase.prompt}`,
    verificationGuidance(args.verification_profile),
    "After editing, give a concise summary of files changed and tests/checks run.",
    "",
    "Task:",
    args.task,
  ].join("\n");
}

function buildClaudeSettings(args, cwd) {
  if (args.permission_mode !== "dontAsk") return null;
  const allow = [
    "Read",
    "Glob",
    "Grep",
    "Edit",
    "Write",
    "NotebookRead",
    "NotebookEdit",
    ...args.checks.map((check) => `Bash(${check})`),
  ];
  const deny = [
    ...DANGEROUS_BASH_DENY_RULES,
    ...args.forbidden_paths.flatMap((path) => [
      `Read(${permissionPathPattern(path)})`,
      `Edit(${permissionPathPattern(path)})`,
      `Write(${permissionPathPattern(path)})`,
    ]),
  ];
  return {
    permissions: {
      defaultMode: args.permission_mode,
      allow,
      deny,
      additionalDirectories: [cwd],
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `${JSON.stringify(process.execPath)} ${JSON.stringify(SELF_SCRIPT)} --permission-hook`,
            },
          ],
        },
      ],
    },
  };
}

function permissionPathPattern(path) {
  const normalized = normalizeRel(path);
  if (normalized.startsWith("/") || normalized.startsWith("~")) return normalized;
  return normalized.startsWith("./") ? normalized : `./${normalized}`;
}

async function runPermissionHook() {
  const input = JSON.parse(await readStdin());
  const config = JSON.parse(process.env.DEEPSEEK_WORKER_HOOK_CONFIG ?? "{}");
  const decision = permissionDecision(input, config);
  if (!decision) return;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.decision,
      permissionDecisionReason: decision.reason,
    },
  })}\n`);
}

function permissionDecision(input, config) {
  const tool = input.tool_name;
  const toolInput = input.tool_input ?? {};
  if (tool === "Bash") return bashPermissionDecision(toolInput.command ?? "", config);
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
    return filePermissionDecision(toolInput, config, { write: true });
  }
  if (tool === "Read" || tool === "NotebookRead") {
    return filePermissionDecision(toolInput, config, { write: false });
  }
  return null;
}

function bashPermissionDecision(command, config) {
  const normalized = command.trim();
  if (!normalized) return denyPermission("Empty Bash command blocked by worker policy.");
  if ((config.checks ?? []).includes(normalized)) return allowPermission();
  if (isDangerousCommand(normalized)) return denyPermission(`Bash command blocked by worker policy: ${normalized}`);
  if (config.worker_profile === "scoped_patch") {
    return denyPermission(`Bash command is not an approved check for scoped_patch: ${normalized}`);
  }
  return null;
}

function filePermissionDecision(toolInput, config, { write }) {
  const file = toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path ?? null;
  if (!file) return null;
  if (write && config.worker_profile === "review") {
    return denyPermission(`Write blocked by read-only review profile: ${file}`);
  }
  const abs = resolve(config.cwd ?? process.cwd(), file);
  const forbidden = (config.forbidden_paths ?? []).some((path) => isInside(path, abs));
  if (forbidden) return denyPermission(`Access to forbidden path blocked: ${file}`);
  if (write && Array.isArray(config.allowed_dirs) && config.allowed_dirs.length > 0) {
    const allowed = config.allowed_dirs.some((path) => isInside(path, abs));
    if (!allowed) return denyPermission(`Write outside allowed_dirs blocked: ${file}`);
  }
  return null;
}

function isDangerousCommand(command) {
  return /(^|\s)(sudo|curl|wget|chmod|chown)\b/.test(command)
    || /\brm\s+-[^\n;]*r/.test(command)
    || /^git\s+push\b/.test(command)
    || /^(npm|pnpm|yarn)\s+install\b/.test(command);
}

function allowPermission() {
  return { decision: "allow", reason: "Allowed by DeepSeek worker policy." };
}

function denyPermission(reason) {
  return { decision: "deny", reason };
}

function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolvePromise(data));
    process.stdin.on("error", rejectPromise);
  });
}

function promptText(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePromise) => {
    rl.question(question, (answer) => {
      rl.close();
      resolvePromise(answer);
    });
  });
}

function promptSecret(question) {
  return new Promise((resolvePromise) => {
    emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdout.write(question);
    let value = "";
    const onKeypress = (str, key) => {
      if (key?.name === "return" || key?.name === "enter") {
        cleanup();
        process.stdout.write("\n");
        resolvePromise(value);
        return;
      }
      if (key?.name === "backspace" || key?.name === "delete") {
        value = value.slice(0, -1);
        return;
      }
      if (key?.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        process.exit(130);
      }
      if (typeof str === "string" && !key?.ctrl && !key?.meta) {
        value += str;
      }
    };
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      if (process.stdin.setRawMode) process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
    };
    process.stdin.on("keypress", onKeypress);
    process.stdin.resume();
  });
}

function verificationGuidance(profile) {
  const map = {
    smoke: "Verification guidance: make the smallest reasonable validation effort. Prefer caller-provided checks; otherwise report what could not be verified.",
    standard: "Verification guidance: run caller-provided checks and inspect related code paths before declaring success.",
    debug: "Verification guidance: reproduce or inspect the failure path first, then validate the minimal fix with the caller-provided checks.",
    review: "Verification guidance: treat output as review-worthy. Keep a clear changed-files summary and avoid expanding scope beyond allowed paths.",
    docs: "Verification guidance: validate links, filenames, and affected docs structure where practical.",
  };
  return map[profile] ?? map.standard;
}

function modelRunningMessage(args) {
  if (args.thinking === "enabled" && args.reasoning_effort === "max") {
    return "DeepSeek V4 Pro/max process is running. Claude Code may stay quiet for a long time before emitting logs or edits.";
  }
  if (args.thinking === "enabled") {
    return "DeepSeek V4 process is running with thinking mode enabled. Quiet periods are possible and not proof of failure.";
  }
  return "Worker process is running in non-thinking mode.";
}

function setJobPhase(job, phase, message) {
  if (!job) return;
  job.phase = phase;
  job.phase_message = message;
  job.updated_at = new Date().toISOString();
  writeJobStatus(job);
}

async function runClaudeDeepSeek({ cwd, prompt, timeout_ms, claude_deepseek_bin, permission_mode, model, reasoning_effort, thinking, output_format, claude_settings, job }) {
  const resolvedClaudeDeepSeekBin = resolveExecutable(claude_deepseek_bin);
  if (!resolvedClaudeDeepSeekBin) {
    throw new Error(`claude-deepseek executable not found: ${claude_deepseek_bin}. Install or build a Claude-Code-compatible DeepSeek launcher, put it on PATH, or set CLAUDE_DEEPSEEK_BIN.`);
  }
  const invocation = buildClaudeDeepSeekInvocation({ prompt, permission_mode, model, output_format, claude_settings });
  if (job) {
    job.claude_args_preview = previewClaudeArgs(invocation.args, prompt);
    writeJobStatus(job);
  }
  const extraEnv = {
    CLAUDE_CODE_EFFORT_LEVEL: reasoning_effort || DEFAULT_REASONING_EFFORT,
    DEEPSEEK_THINKING_MODE: thinking,
  };
  if (claude_settings) {
    extraEnv.DEEPSEEK_WORKER_HOOK_CONFIG = JSON.stringify({
      cwd,
      allowed_dirs: job?.allowedRoots ?? [],
      forbidden_paths: job?.forbiddenPaths ?? [],
      checks: job?.checks ?? [],
      worker_profile: job?.worker_profile ?? null,
    });
  }
  const processInvocation = nodeScriptInvocation(resolvedClaudeDeepSeekBin, invocation.args);
  return runProcess(processInvocation.command, processInvocation.args, {
    cwd,
    timeout_ms,
    job,
    stream_name: "worker",
    invocation_preview: previewClaudeArgs(processInvocation.previewArgs, prompt),
    parse_stream_json: output_format === "stream-json",
    output_format,
    env: extraEnv,
  });
}

function nodeScriptInvocation(command, args) {
  if (/\.(mjs|cjs|js)$/i.test(command)) {
    return {
      command: process.execPath,
      args: [command, ...args],
      previewArgs: [command, ...args],
    };
  }
  return { command, args, previewArgs: args };
}

function buildClaudeDeepSeekInvocation({ prompt, permission_mode, model, output_format, claude_settings = null }) {
  const args = [
    "-p",
    "--bare",
  ];
  if (output_format === "stream-json") {
    args.push("--verbose");
  }
  args.push(
    "--permission-mode",
    permission_mode,
    "--output-format",
    output_format,
  );
  if (claude_settings) {
    args.push("--settings", JSON.stringify(claude_settings));
  }
  if (output_format === "stream-json") {
    args.push("--include-partial-messages");
  }
  if (model) args.push("--model", model);
  args.push(prompt);
  return { args };
}

function previewClaudeArgs(args, prompt = "<worker-prompt>") {
  const preview = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--settings" && i + 1 < args.length) {
      preview.push(args[i], "<claude-settings>");
      i++;
      continue;
    }
    preview.push(args[i] === prompt ? "<worker-prompt>" : args[i]);
  }
  return preview;
}

async function runCheck(cwd, command, timeout_ms) {
  const shell = checkShellInvocation(command);
  const result = await runProcess(shell.command, shell.args, { cwd, timeout_ms });
  return {
    command,
    exit_code: result.exit_code,
    timed_out: result.timed_out,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr),
  };
}

function runProcess(command, args, { cwd, timeout_ms = null, job = null, stream_name = "process", env = null, invocation_preview = null, parse_stream_json = false, output_format = "text" }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    if (job) {
      job.child = child;
      job.process_alive = true;
      job.process_pid = child.pid ?? null;
      job.updated_at = new Date().toISOString();
      writeJobStatus(job);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let eventsSeen = 0;
    let lastEventType = null;
    let lastEventSummary = null;
    let stdoutBuffer = "";
    const timer = timeout_ms == null ? null : setTimeout(() => {
      timedOut = true;
      setJobPhase(job, "caller_timeout", "Caller-provided timeout elapsed; stopping the worker process and reviewing artifacts.");
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeout_ms);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout = appendBounded(stdout, text);
      appendJobLog(job, "stdout", text);
      if (parse_stream_json) {
        stdoutBuffer += text;
        const parsed = consumeJsonLines(stdoutBuffer, (event) => {
          eventsSeen++;
          lastEventType = event.type ?? event.event ?? null;
          lastEventSummary = summarizeClaudeEvent(event);
          recordClaudeEvent(job, event, lastEventSummary);
        });
        stdoutBuffer = parsed.remainder;
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr = appendBounded(stderr, text);
      appendJobLog(job, "stderr", text);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (job) {
        job.updated_at = new Date().toISOString();
        job.child = null;
        job.process_alive = false;
        writeJobStatus(job);
      }
      resolvePromise({
        exit_code: code,
        timed_out: timedOut,
        cancelled: Boolean(job?.cancel_requested),
        stdout,
        stderr,
        stream_name,
        claude_args_preview: job?.claude_args_preview ?? invocation_preview,
        output_format,
        events_seen: eventsSeen,
        last_event_type: lastEventType,
        last_event_summary: lastEventSummary,
      });
    });
  });
}

function snapshotWorkspace(cwd, ignoredDirs) {
  const files = new Map();
  walk(cwd, cwd, ignoredDirs, files);
  return files;
}

function walk(root, current, ignoredDirs, files) {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = resolve(current, entry.name);
    const rel = normalizeRel(relative(root, full));
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue;
      walk(root, full, ignoredDirs, files);
      continue;
    }
    if (!entry.isFile()) continue;
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      files.set(rel, { kind: "large", size: stat.size, mtimeMs: stat.mtimeMs });
      continue;
    }
    try {
      const content = readFileSync(full);
      let contentStr;
      if (stat.size <= MAX_DIFF_CONTENT_BYTES) {
        contentStr = content.toString("utf8");
        if (isLikelyBinary(contentStr)) contentStr = undefined;
      }
      files.set(rel, {
        kind: "file",
        size: stat.size,
        hash: createHash("sha256").update(content).digest("hex"),
        content: contentStr,
      });
    } catch {
      // Ignore unreadable files. The policy layer still catches tracked git diffs where possible.
    }
  }
}

function diffSnapshots(before, after) {
  const changes = [];
  const names = new Set([...before.keys(), ...after.keys()]);
  for (const name of names) {
    const a = before.get(name);
    const b = after.get(name);
    if (!a) changes.push({ path: name, type: "added" });
    else if (!b) changes.push({ path: name, type: "deleted" });
    else if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ path: name, type: "modified" });
  }
  return changes;
}

function evaluatePolicy({ cwd, changedFiles, allowedRoots, forbiddenPaths, allow_docs_only }) {
  const outside_allowed = changedFiles.filter((file) => {
    const abs = resolve(cwd, file);
    return !allowedRoots.some((root) => isInside(root, abs));
  });
  const forbidden_changed = changedFiles.filter((file) => {
    const abs = resolve(cwd, file);
    return forbiddenPaths.some((forbidden) => abs === forbidden || isInside(forbidden, abs));
  });
  const docs_only = changedFiles.length > 0 && changedFiles.every(isDocPath);
  const ok = changedFiles.length > 0
    && outside_allowed.length === 0
    && forbidden_changed.length === 0
    && (allow_docs_only || !docs_only);
  return {
    ok,
    outside_allowed,
    forbidden_changed,
    docs_only,
    allow_docs_only,
  };
}

async function gitSummary(cwd) {
  const isRepo = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout_ms: 5000 });
  if (isRepo.exit_code !== 0) return { is_repo: false };
  const status = await runProcess("git", ["status", "--short"], { cwd, timeout_ms: 10000 });
  const stat = await runProcess("git", ["diff", "--stat"], { cwd, timeout_ms: 10000 });
  return {
    is_repo: true,
    status_short: status.stdout.trim(),
    diff_stat: stat.stdout.trim(),
  };
}

function failureReason({ changedFiles, policy, checkFailures, worker }) {
  if (worker.cancelled && changedFiles.length === 0) return "worker_cancelled";
  if (worker.timed_out && changedFiles.length === 0) return "caller_timeout_no_valid_changes";
  if (worker.exit_code !== 0 && !worker.timed_out && !worker.cancelled) return "worker_exit_nonzero";
  if (changedFiles.length === 0) return "no_code_changed";
  if (policy.outside_allowed.length > 0) return "changed_outside_allowed_paths";
  if (policy.forbidden_changed.length > 0) return "changed_forbidden_paths";
  if (policy.docs_only && !policy.allow_docs_only) return "docs_only_change";
  if (checkFailures.length > 0) return "checks_failed";
  if (worker.cancelled) return "cancelled_after_valid_changes";
  if (worker.timed_out) return "caller_timeout_after_valid_changes";
  return null;
}

function classifyOutcome({ changedFiles, policy, checkFailures, worker, presetRequiresReview = false }) {
  const baseFailure = failureReason({ changedFiles, policy, checkFailures, worker });
  const validChanges = changedFiles.length > 0 && policy.ok && checkFailures.length === 0;
  if (validChanges && !worker.timed_out && worker.exit_code === 0 && !worker.cancelled) {
    return {
      status: "changed_files",
      partial: false,
      requires_review: presetRequiresReview,
      review_hint: presetRequiresReview
        ? "This use_case is review-worthy by default. Inspect the diff and validation output before accepting."
        : null,
      failure_reason: null,
    };
  }
  if (validChanges && worker.timed_out && !worker.cancelled) {
    return {
      status: "partial_caller_timeout",
      partial: true,
      requires_review: true,
      review_hint:
        "Caller-provided timeout stopped the worker after policy-compliant changes. Review the diff and check outputs before accepting; rerun checks if they did not complete.",
      failure_reason: "caller_timeout_after_valid_changes",
    };
  }
  if (validChanges && worker.cancelled) {
    return {
      status: "partial_cancelled",
      partial: true,
      requires_review: true,
      review_hint:
        "Cancellation stopped the worker after policy-compliant changes. Use MCP checks_run as the validation source, then inspect local changed files before accepting.",
      failure_reason: "cancelled_after_valid_changes",
    };
  }
  return {
    status: "failed",
    partial: changedFiles.length > 0,
    requires_review: changedFiles.length > 0,
    review_hint: changedFiles.length > 0
      ? "Worker produced changes, but policy or validation failed. Do not trust the patch until reviewed and repaired."
      : null,
    failure_reason: baseFailure,
  };
}

function isAcceptedResultStatus(status) {
  return status === "changed_files"
    || status === "partial_caller_timeout"
    || status === "partial_cancelled";
}

function outputOptions(args = {}) {
  return {
    include_logs: Boolean(args.include_logs),
    include_events: Boolean(args.include_events),
    include_diff: Boolean(args.include_diff),
  };
}

function workerStatus(job, options = {}) {
  const worker = {
    output_format: job.output_format,
    last_event_at: job.last_event_at,
    last_event_type: job.last_event_type,
    last_event_summary: job.last_event_summary,
    last_successful_tool: job.last_successful_tool ?? null,
    last_failed_tool: job.last_failed_tool ?? null,
    last_error_kind: job.last_error_kind ?? null,
    tool_calls_since_last_change: job.tool_calls_since_last_change ?? 0,
  };
  if (options.include_logs) {
    worker.claude_args_preview = job.claude_args_preview ?? null;
    worker.stdout_tail = tail(job.stdout ?? "");
    worker.stderr_tail = tail(job.stderr ?? "");
  }
  if (options.include_events) {
    worker.recent_events = job.stream_events ?? [];
  }
  return worker;
}

function resultForOutput(result, options = {}) {
  if (!result) return result;
  const output = { ...result };
  delete output.file_diffs;
  output.checks_run = checksForOutput(result.checks_run ?? [], options);
  if (result.worker) {
    output.worker = {
      exit_code: result.worker.exit_code,
      timed_out: result.worker.timed_out,
      cancelled: result.worker.cancelled,
      output_format: result.worker.output_format,
      events_seen: result.worker.events_seen,
      last_event_type: result.worker.last_event_type,
      last_event_summary: result.worker.last_event_summary,
    };
    if (options.include_logs) {
      output.worker.claude_args_preview = result.worker.claude_args_preview;
      output.worker.stdout_tail = result.worker.stdout_tail;
      output.worker.stderr_tail = result.worker.stderr_tail;
    }
  }
  if (options.include_diff) {
    output.file_diffs = result.file_diffs ?? [];
  }
  return stripLargeEvidence(output, options);
}

function errorForOutput(error, options = {}) {
  return stripLargeEvidence(error, options);
}

function stripLargeEvidence(value, options = {}) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stripLargeEvidence(item, options));
  const stripped = {};
  for (const [key, item] of Object.entries(value)) {
    if (!options.include_logs && (key === "stdout_tail" || key === "stderr_tail")) continue;
    if (!options.include_events && key === "recent_events") continue;
    if (!options.include_diff && key === "file_diffs") continue;
    stripped[key] = stripLargeEvidence(item, options);
  }
  return stripped;
}

function checksForOutput(checks, options = {}) {
  if (!Array.isArray(checks)) return [];
  return checks.map((check) => {
    if (options.include_logs) return check;
    return {
      command: check.command,
      exit_code: check.exit_code,
      timed_out: check.timed_out,
    };
  });
}

function serializeJob(job, options = {}) {
  return {
    id: job.id,
    status: job.status,
    started_at: job.started_at,
    updated_at: job.updated_at,
    elapsed_ms: Date.now() - job.started_ms,
    use_case: job.use_case,
    worker_profile: job.worker_profile,
    preset_requires_review: job.preset_requires_review,
    permission_mode: job.permission_mode,
    restored_from_disk: Boolean(job.restored_from_disk),
    recommended_poll_after_ms: recommendedPollAfterMs(job),
    next_poll: nextPollHint(job),
    progress: progressForJob(job),
    worker: workerStatus(job, options),
    result: resultForOutput(job.result, options),
    error: errorForOutput(job.error, options),
    job_dir: job.job_dir,
  };
}

async function waitForJob(args) {
  const job = getJob(args.job_id);
  if (!job) {
    return { status: "not_found", job_id: args.job_id };
  }
  const options = outputOptions(args);

  const waitRequested = args.max_wait_ms != null;
  const requestedMaxWaitMs = waitRequested
    ? positiveNumber(args.max_wait_ms, DEFAULT_FOREGROUND_WAIT_CAP_MS, "max_wait_ms")
    : 0;
  const maxWaitMs = Math.min(requestedMaxWaitMs, DEFAULT_FOREGROUND_WAIT_CAP_MS);
  const defaultPoll = Math.min(job.recommended_poll_after_ms ?? DEFAULT_POLL_AFTER_MS, 30 * 1000);
  const pollIntervalMs = positiveNumber(args.poll_interval_ms, defaultPoll, "poll_interval_ms");
  const started = Date.now();
  const observations = [];

  const initialProgress = progressForJob(job);
  observations.push(compactProgress(initialProgress));
  const initialDecision = waitDecision(job);
  if (initialDecision) {
    return {
      ...initialDecision,
      job_id: job.id,
      elapsed_wait_ms: Date.now() - started,
      progress: initialProgress,
      result: resultForOutput(job.result, options),
      error: errorForOutput(job.error, options),
      observations,
    };
  }

  while (maxWaitMs > 0 && Date.now() - started <= maxWaitMs) {
    const progress = progressForJob(job);
    observations.push(compactProgress(progress));
    const decision = waitDecision(job);
    if (decision) {
      return {
        status: decision.status,
        reason: decision.reason,
        job_id: job.id,
        elapsed_wait_ms: Date.now() - started,
        progress,
        result: resultForOutput(job.result, options),
        error: errorForOutput(job.error, options),
        observations,
        suggested_action: decision.suggested_action,
      };
    }
    const remainingMs = maxWaitMs - (Date.now() - started);
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  const progress = progressForJob(job);
  const hitForegroundCap = requestedMaxWaitMs > maxWaitMs;
  return {
    status: "running",
    reason: !waitRequested
      ? "no_wait_requested"
      : hitForegroundCap ? "foreground_wait_cap_elapsed" : "max_wait_elapsed",
    job_id: job.id,
    elapsed_wait_ms: Date.now() - started,
    requested_max_wait_ms: requestedMaxWaitMs,
    effective_max_wait_ms: maxWaitMs,
    foreground_wait_cap_ms: DEFAULT_FOREGROUND_WAIT_CAP_MS,
    hit_foreground_cap: hitForegroundCap,
    progress,
    result: resultForOutput(job.result, options),
    error: errorForOutput(job.error, options),
    observations,
    suggested_action: !waitRequested
      ? "No foreground wait was requested. Worker is still running; use deepseek_get_job for compact status later if needed."
      : hitForegroundCap
      ? "Foreground observation cap elapsed before caller max_wait_ms. Worker is still running; use deepseek_get_job for compact status later if needed."
      : "Observation window elapsed. Worker is still running; do not cancel or review artifacts solely because of quiet/elapsed time.",
  };
}

function waitDecision(job) {
  if (job.status === "completed") {
    return {
      status: "completed",
      reason: "job_completed",
      suggested_action: job.result?.requires_review
        ? "inspect files_changed, policy, and checks_run before accepting"
        : "use result.files_changed and checks_run as final status",
    };
  }
  if (job.status === "failed") {
    return {
      status: "failed",
      reason: "job_failed",
      suggested_action: "inspect failure_reason, policy, and checks_run; request include_logs only when debugging needs worker logs",
    };
  }
  if (job.status === "cancel_requested") {
    return {
      status: "cancel_requested",
      reason: "job_cancel_requested",
      suggested_action: "wait again for artifact review to complete",
    };
  }
  if (job.status === "orphaned") {
    return {
      status: "needs_review",
      reason: "orphaned_after_mcp_restart",
      suggested_action: "job was restored from disk but no live worker process exists; inspect changed_files_so_far, logs, policy_so_far, and local files before trusting artifacts",
    };
  }
  return null;
}

function compactProgress(progress) {
  return {
    at: new Date().toISOString(),
    status: progress.status,
    phase: progress.phase,
    observed_state: progress.observed_state,
    idle_seconds: progress.idle_seconds,
    change_count_so_far: progress.change_count_so_far ?? 0,
    last_event_summary: progress.last_event_summary,
    last_stream_kind: progress.last_stream_kind,
    pending_tool_use: progress.pending_tool_use,
    last_successful_tool: progress.last_successful_tool,
    last_failed_tool: progress.last_failed_tool,
    last_error_kind: progress.last_error_kind,
    tool_calls_since_last_change: progress.tool_calls_since_last_change,
  };
}

function positiveNumber(value, fallback, label) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return number;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function progressForJob(job) {
  const idle = idleStatus(job);
  if (!job.cwd || !job.before || !job.ignored_dirs) {
    return {
      status: job.status,
      phase: job.phase ?? job.status,
      phase_message: statusMessage(job, idle),
      observed_state: observedState(job, idle, []),
      suggested_action: suggestedAction(job, idle, []),
      process_alive: Boolean(job.process_alive),
      process_pid: job.process_pid ?? null,
      last_event_summary: job.last_event_summary ?? null,
      last_stream_kind: job.last_stream_kind ?? null,
      pending_tool_use: job.pending_tool_use ?? null,
      last_tool_name: job.last_tool_name ?? null,
      ...idle,
    };
  }
  const now = snapshotWorkspace(job.cwd, job.ignored_dirs);
  const changes = diffSnapshots(job.before, now);
  const changedFiles = changes.map((change) => change.path).sort();
  updateToolChangeCounters(job, changedFiles.length);
  const { diffAvailable } = computeFileDiffs(job.before, now, changes);
  const policySoFar = evaluatePolicy({
    cwd: job.cwd,
    changedFiles,
    allowedRoots: job.allowedRoots,
    forbiddenPaths: job.forbiddenPaths,
    allow_docs_only: job.allow_docs_only,
  });
  return {
    status: job.status,
    phase: job.phase ?? job.status,
    phase_message: statusMessage(job, idle),
    observed_state: observedState(job, idle, changedFiles),
    suggested_action: suggestedAction(job, idle, changedFiles),
    process_alive: Boolean(job.process_alive),
    process_pid: job.process_pid ?? null,
    last_event_summary: job.last_event_summary ?? null,
    last_stream_kind: job.last_stream_kind ?? null,
    pending_tool_use: job.pending_tool_use ?? null,
    last_tool_name: job.last_tool_name ?? null,
    last_tool_use_at: job.last_tool_use_at ?? null,
    last_tool_result_at: job.last_tool_result_at ?? null,
    last_successful_tool: job.last_successful_tool ?? null,
    last_failed_tool: job.last_failed_tool ?? null,
    last_error_kind: job.last_error_kind ?? null,
    tool_calls_since_last_change: job.tool_calls_since_last_change ?? 0,
    elapsed_ms: Date.now() - job.started_ms,
    ...idle,
    changed_files_so_far: changedFiles,
    change_count_so_far: changedFiles.length,
    diff_available: diffAvailable,
    policy_so_far: policySoFar,
    last_change_at: lastChangeAt(job.cwd, changedFiles),
    review_summary: buildReviewSummary({
      changedFiles,
      diffAvailable,
      policy: policySoFar,
      checks: [],
      failureReason: null,
      requiresReview: changedFiles.length > 0 || !policySoFar.ok,
      job,
    }),
  };
}

function recommendedPollAfterMs(job) {
  return Number(job?.recommended_poll_after_ms ?? DEFAULT_POLL_AFTER_MS);
}

function nextPollHint(job) {
  if (!job || job.status !== "running") {
    return {
      after_ms: null,
      preferred_tool: "deepseek_get_job",
      instruction: "Job is not running; inspect terminal result instead of polling.",
    };
  }
  return {
    after_ms: recommendedPollAfterMs(job),
    preferred_tool: "deepseek_get_job",
    instruction: "Optional compact status-check hint. Do not treat this as a timeout, watchdog, or instruction to keep polling indefinitely.",
  };
}

function lastChangeAt(cwd, changedFiles) {
  let latest = 0;
  for (const file of changedFiles) {
    try {
      const mtime = statSync(resolve(cwd, file)).mtimeMs;
      if (mtime > latest) latest = mtime;
    } catch {
      // Deleted files have no mtime; ignore them for last_change_at.
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function updateToolChangeCounters(job, changeCount) {
  if (!job) return;
  const previous = job.last_observed_change_count ?? 0;
  if (changeCount > previous) {
    job.tool_calls_since_last_change = 0;
  }
  job.last_observed_change_count = changeCount;
}

function idleStatus(job) {
  const reference = job.last_output_at_ms ?? job.started_ms ?? Date.now();
  const idleMs = Date.now() - reference;
  const threshold = job.idle_after_ms ?? DEFAULT_IDLE_AFTER_MS;
  return {
    last_output_at: job.last_output_at ?? null,
    idle_ms: idleMs,
    idle_seconds: Math.floor(idleMs / 1000),
    quiet: idleMs >= threshold,
    quiet_threshold_ms: threshold,
    quiet_is_cancellation_signal: false,
    quiet_guidance: "Quiet output is observational only. Do not cancel, restart, take over, or review partial artifacts solely because this value is true.",
  };
}

function statusMessage(job, idle = idleStatus(job)) {
  if (job.status === "cancel_requested") return "Cancellation requested; waiting for the worker process to stop.";
  if (job.status === "completed") return "Completed successfully.";
  if (job.status === "failed") return "Finished with failure; inspect result.failure_reason and worker logs.";
  if (job.phase === "caller_timeout") return job.phase_message;
  if (job.phase === "model_running" && idle.quiet && job.process_alive) {
    return `${job.phase_message} Process is alive but has produced no output for ${idle.idle_seconds}s. This is inconclusive, not proof of a hang.`;
  }
  return job.phase_message ?? "Worker status is available.";
}

function observedState(job, idle, changedFiles) {
  if (job.status === "orphaned") return "orphaned_after_mcp_restart";
  if (job.status === "completed") return "completed";
  if (job.status === "failed") return "failed";
  if (job.status === "cancel_requested") return "cancel_requested";
  if (!job.process_alive && job.status === "running") return "process_not_alive";
  if (job.process_alive && job.pending_tool_use && changedFiles.length === 0 && idle.quiet) return "alive_quiet_after_tool_use";
  if (job.process_alive && changedFiles.length > 0 && idle.quiet) return "alive_quiet_with_workspace_changes";
  if (job.process_alive && changedFiles.length > 0) return "alive_with_workspace_changes";
  if (job.process_alive && job.last_stream_kind === "thinking_delta") return "alive_thinking_streaming";
  if (job.process_alive && job.last_event_at_ms && !idle.quiet) return "alive_recent_stream_event";
  if (job.process_alive && idle.quiet) return "alive_quiet_no_recent_output";
  if (job.process_alive) return "alive_recent_output_or_startup";
  return "unknown";
}

function suggestedAction(job, idle, changedFiles) {
  if (job.status === "orphaned") return "job restored from disk without a live worker process; inspect artifacts and decide whether to rerun";
  if (job.status === "completed") return "inspect result and checks_run";
  if (job.status === "failed") return "inspect failure_reason, policy, checks_run, and worker logs";
  if (job.status === "cancel_requested") return "wait for artifact review after cancellation";
  if (job.process_alive && job.pending_tool_use && changedFiles.length === 0 && idle.quiet) {
    return "worker is alive and quiet after a tool_use without a matching tool_result; keep observing unless there is an explicit error or the user asks to stop";
  }
  if (job.process_alive && changedFiles.length > 0 && idle.quiet) {
    return "worker is alive and quiet after producing files; do not review partial artifacts or cancel solely because of quiet time";
  }
  if (job.process_alive && changedFiles.length > 0) return "monitor until completion; changed files are provisional while the worker is running";
  if (job.process_alive && job.last_stream_kind === "thinking_delta") return "worker is still running and recently streamed thinking activity";
  if (job.process_alive && idle.quiet) return "worker is still running; quiet alive process is inconclusive";
  if (job.process_alive) return "worker is still running";
  return "inspect job result or error";
}

function recordClaudeEvent(job, event, summary) {
  if (!job) return;
  const now = new Date();
  const detail = classifyClaudeEvent(event);
  const eventType = detail.type ?? "unknown";
  job.updated_at = now.toISOString();
  job.last_event_at_ms = now.getTime();
  job.last_event_at = now.toISOString();
  job.last_event_type = eventType;
  job.last_event_summary = summary;
  job.last_stream_kind = detail.kind;
  if (detail.kind === "tool_use") {
    job.pending_tool_use = detail.tool_name ?? "unknown_tool";
    job.last_tool_name = detail.tool_name ?? job.last_tool_name ?? null;
    job.last_tool_use_at = now.toISOString();
    job.tool_calls_since_last_change = (job.tool_calls_since_last_change ?? 0) + 1;
  } else if (detail.kind === "tool_result") {
    job.pending_tool_use = null;
    job.last_tool_name = detail.tool_name ?? job.last_tool_name ?? null;
    job.last_tool_result_at = now.toISOString();
    if (detail.is_error) {
      job.last_failed_tool = job.last_tool_name;
      job.last_error_kind = "tool_result_error";
    } else {
      job.last_successful_tool = job.last_tool_name;
    }
  } else if (detail.kind === "error_result") {
    job.last_error_kind = "model_result_error";
  }
  job.last_output_at_ms = now.getTime();
  job.last_output_at = now.toISOString();
  job.stream_events = [...(job.stream_events ?? []), compactClaudeEvent(event, summary)].slice(-MAX_STREAM_EVENTS);
  const phase = phaseFromClaudeEvent(event);
  if (phase) {
    job.phase = phase.phase;
    job.phase_message = phase.message;
  }
  writeJobStatus(job);
}

function appendJobLog(job, stream, text) {
  if (!job) return;
  if (stream === "stdout") job.stdout = appendBounded(job.stdout ?? "", text);
  if (stream === "stderr") job.stderr = appendBounded(job.stderr ?? "", text);
  const now = new Date();
  job.updated_at = now.toISOString();
  job.last_output_at_ms = now.getTime();
  job.last_output_at = now.toISOString();
  if (job.job_dir) {
    appendFileSync(join(job.job_dir, `${stream}.log`), text);
    writeJobStatus(job);
  }
}

function writeJobStatus(job) {
  if (!job?.job_dir) return;
  const idle = idleStatus(job);
  const safe = {
    id: job.id,
    status: job.status,
    server_version: SERVER_VERSION,
    started_at: job.started_at,
    updated_at: job.updated_at,
    elapsed_ms: Date.now() - job.started_ms,
    cwd: job.cwd,
    job_dir: job.job_dir,
    restored_from_disk: Boolean(job.restored_from_disk),
    use_case: job.use_case,
    worker_profile: job.worker_profile,
    model: job.model,
    thinking: job.thinking,
    reasoning_effort: job.reasoning_effort,
    preset_requires_review: job.preset_requires_review,
    verification_profile: job.verification_profile,
    permission_mode: job.permission_mode,
    claude_settings_active: job.claude_settings_active,
    recommended_poll_after_ms: recommendedPollAfterMs(job),
    next_poll: nextPollHint(job),
    phase: job.phase,
    phase_message: job.phase_message,
    observed_state: observedState(job, idle, []),
    suggested_action: suggestedAction(job, idle, []),
    process_alive: Boolean(job.process_alive),
    process_pid: job.process_pid ?? null,
    output_format: job.output_format,
    claude_args_preview: job.claude_args_preview ?? null,
    ignored_dirs: job.ignored_dirs instanceof Set ? [...job.ignored_dirs] : arrayOfStrings(job.ignored_dirs),
    allowedRoots: arrayOfStrings(job.allowedRoots),
    forbiddenPaths: arrayOfStrings(job.forbiddenPaths),
    checks: arrayOfStrings(job.checks),
    allow_docs_only: Boolean(job.allow_docs_only),
    idle_after_ms: job.idle_after_ms ?? DEFAULT_IDLE_AFTER_MS,
    last_output_at_ms: job.last_output_at_ms ?? null,
    last_event_at: job.last_event_at,
    last_event_at_ms: job.last_event_at_ms ?? null,
    last_event_type: job.last_event_type,
    last_event_summary: job.last_event_summary,
    last_stream_kind: job.last_stream_kind,
    pending_tool_use: job.pending_tool_use,
    last_tool_name: job.last_tool_name,
    last_tool_use_at: job.last_tool_use_at,
    last_tool_result_at: job.last_tool_result_at,
    last_successful_tool: job.last_successful_tool,
    last_failed_tool: job.last_failed_tool,
    last_error_kind: job.last_error_kind,
    tool_calls_since_last_change: job.tool_calls_since_last_change,
    last_observed_change_count: job.last_observed_change_count,
    recent_events: job.stream_events ?? [],
    last_output_at: job.last_output_at,
    idle_seconds: idle.idle_seconds,
    status_message: statusMessage(job, idle),
    result: job.result,
    error: job.error,
    cancel_requested: job.cancel_requested,
  };
  writeFileSync(join(job.job_dir, "status.json"), JSON.stringify(safe, null, 2));
}

function writeJobRestoreData(job) {
  if (!job?.job_dir) return;
  writeFileSync(join(job.job_dir, "before-snapshot.json"), JSON.stringify(serializeSnapshot(job.before)));
}

function implementationSchema() {
  return {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Absolute workspace path where code should be edited." },
      task: { type: "string", description: "Self-contained implementation task. Must ask for real code changes." },
      use_case: {
        type: "string",
        enum: Object.keys(USE_CASES),
        description:
          "DeepSeek V4 official-use-case preset. Routes model/thinking defaults: flash for fast/simple agent tasks, pro[1m] for agentic coding, complex reasoning, long-context codebase work, or docs generation.",
      },
      worker_profile: {
        type: "string",
        enum: Object.keys(WORKER_PROFILES),
        description:
          "Worker permission/output contract. Defaults to implementation. Use scoped_patch to opt into dontAsk with per-worker allow/deny settings and explicit narrow allowed_dirs.",
      },
      allowed_dirs: {
        type: "array",
        items: { type: "string" },
        description: "Relative or absolute directories/files the worker is allowed to modify. Required for worker_profile=scoped_patch; keep it narrow.",
      },
      forbidden_paths: {
        type: "array",
        items: { type: "string" },
        description: "Relative or absolute paths that must not be modified.",
      },
      checks: {
        type: "array",
        items: { type: "string" },
        description: "Optional shell commands to run after successful edits.",
      },
      timeout_ms: {
        type: "number",
        description:
          "Optional caller-imposed stop time for the worker process. Async jobs have no default worker timeout; sync calls default to a short foreground protection limit.",
      },
      check_timeout_ms: { type: "number", description: "Per-check timeout. Defaults to 10 minutes." },
      poll_after_ms: {
        type: "number",
        description: "Suggested async polling interval returned to callers. Defaults from use_case and can be overridden by the caller.",
      },
      idle_after_ms: {
        type: "number",
        description: "Quiet-output threshold for status messages only. This is not a cancellation, takeover, review, or failure threshold.",
      },
      allow_docs_only: { type: "boolean", description: "Allow documentation-only diffs. Defaults to false." },
      model: { type: "string", description: "Optional Claude Code model override passed to claude-deepseek. Defaults from use_case." },
      thinking: {
        type: "string",
        enum: ["enabled", "disabled"],
        description: "DeepSeek V4 thinking-mode hint. Defaults from use_case.",
      },
      reasoning_effort: {
        type: "string",
        enum: ["high", "max"],
        description: "DeepSeek V4 thinking strength hint. Complex Agent scenarios default to max.",
      },
      verification_profile: {
        type: "string",
        enum: ["smoke", "standard", "debug", "review", "docs"],
        description:
          "Verification-loop hint inspired by Everything Claude Code. Defaults from use_case and is included in prompts/results; caller-provided checks still define actual commands.",
      },
      output_format: {
        type: "string",
        enum: ["stream-json", "json"],
        description:
          "Claude Code print output format. Defaults to stream-json and adds --verbose before --output-format plus --include-partial-messages. Use json only as fallback.",
      },
      permission_mode: {
        type: "string",
        enum: ["acceptEdits", "auto", "default", "dontAsk", "plan"],
        description: "Claude Code permission mode. Defaults from worker_profile. dontAsk uses per-worker allow/deny settings; bypassPermissions is intentionally disabled unless a real sandbox is added.",
      },
      claude_deepseek_bin: { type: "string", description: "Path to claude-deepseek executable." },
      ignored_dirs: {
        type: "array",
        items: { type: "string" },
        description: "Extra directory names to ignore while snapshotting.",
      },
    },
    required: ["cwd", "task"],
    additionalProperties: false,
  };
}

function normalizeUseCase(value) {
  if (typeof value !== "string" || value.length === 0) return "auto";
  if (!Object.hasOwn(USE_CASES, value)) {
    throw new Error(`Unknown use_case: ${value}. Valid values: ${Object.keys(USE_CASES).join(", ")}`);
  }
  return value;
}

function normalizeWorkerProfile(value) {
  if (typeof value !== "string" || value.length === 0) return "implementation";
  if (!Object.hasOwn(WORKER_PROFILES, value)) {
    throw new Error(`Unknown worker_profile: ${value}. Valid values: ${Object.keys(WORKER_PROFILES).join(", ")}`);
  }
  return value;
}

function normalizeThinking(value) {
  if (value === "enabled" || value === "disabled") return value;
  throw new Error("thinking must be one of: enabled, disabled");
}

function normalizeReasoningEffort(value) {
  if (value === "high" || value === "max") return value;
  throw new Error("reasoning_effort must be one of: high, max");
}

function normalizeOutputFormat(value) {
  if (value == null || value === "") return "stream-json";
  if (value === "stream-json" || value === "json") return value;
  throw new Error("output_format must be one of: stream-json, json");
}

function normalizeVerificationProfile(value) {
  if (value === "smoke" || value === "standard" || value === "debug" || value === "review" || value === "docs") return value;
  throw new Error("verification_profile must be one of: smoke, standard, debug, review, docs");
}

function normalizeOptionalNumber(value, fallback = null) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error("timeout_ms must be a positive number when provided");
  }
  return number;
}

function normalizeRoots(cwd, roots) {
  const values = roots.length > 0 ? roots : ["."];
  return values.map((value) => {
    const abs = resolve(cwd, value);
    return assertInside(cwd, abs, "allowed_dirs");
  });
}

function normalizeForbidden(cwd, paths) {
  return paths.map((value) => assertInside(cwd, resolve(cwd, value), "forbidden_paths"));
}

function assertInside(root, candidate, label) {
  if (!isInside(root, candidate)) {
    throw new Error(`${label} escapes cwd: ${candidate}`);
  }
  return candidate;
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function isDocPath(path) {
  const lower = path.toLowerCase();
  return lower.startsWith("docs/")
    || lower.endsWith(".md")
    || lower.endsWith(".mdx")
    || lower.endsWith(".txt")
    || lower.endsWith(".rst")
    || lower.endsWith(".adoc");
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.length > 0);
}

function serializeSnapshot(snapshot) {
  if (!(snapshot instanceof Map)) return [];
  return [...snapshot.entries()];
}

function deserializeSnapshot(value) {
  if (!Array.isArray(value)) return null;
  return new Map(value.filter((entry) => Array.isArray(entry) && entry.length === 2));
}

function readTextIfExists(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function readJsonIfExists(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

function parseTimeMs(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function restoreStartedMs(data) {
  if (typeof data.started_ms === "number" && Number.isFinite(data.started_ms)) return data.started_ms;
  if (typeof data.started_at === "string") {
    const ms = Date.parse(data.started_at);
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof data.elapsed_ms === "number" && Number.isFinite(data.elapsed_ms)) return Date.now() - data.elapsed_ms;
  return Date.now();
}

function processPidAlive(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutable(command) {
  if (typeof command !== "string" || command.length === 0) return null;
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return isExecutable(command) ? command : null;
  }
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = executableExtensions(command);
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutable(path) {
  try {
    accessSync(path, platform() === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableExtensions(command) {
  if (platform() !== "win32") return [""];
  if (/\.[^\\/]+$/.test(command)) return [""];
  return (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((ext) => ext.toLowerCase())
    .concat("");
}

function defaultClaudeBin() {
  if (platform() === "win32") return "claude";
  return resolve(homedir(), ".local/bin/claude");
}

function checkShellInvocation(command) {
  if (platform() === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  const shell = resolveExecutable("zsh") || resolveExecutable("bash") || resolveExecutable("sh") || "/bin/sh";
  return { command: shell, args: ["-lc", command] };
}

function normalizeRel(path) {
  return path.split(sep).join("/");
}

function isLikelyBinary(text) {
  return text.includes("\u0000");
}

function computeUnifiedDiff(a, b, path) {
  const aLines = a === "" ? [] : a.split("\n");
  const bLines = b === "" ? [] : b.split("\n");
  if (aLines.length === 0 && bLines.length === 0) return "";

  const m = aLines.length;
  const n = bLines.length;

  if (m > MAX_DIFF_LINES || n > MAX_DIFF_LINES) {
    const out = [`--- ${path}`, `+++ ${path}`];
    if (m === 0) {
      out.push(`@@ -0,0 +1,${n} @@`);
      return out.concat(bLines.map((l) => "+" + l)).join("\n");
    }
    if (n === 0) {
      out.push(`@@ -1,${m} +0,0 @@`);
      return out.concat(aLines.map((l) => "-" + l)).join("\n");
    }
    out.push(`@@ -1,${m} +1,${n} @@ (large diff, ${m} -> ${n} lines)`);
    const sample = [];
    const maxSample = Math.min(m, n, 6);
    for (let i = 0; i < maxSample; i++) {
      if (aLines[i] === bLines[i]) {
        sample.push(" " + aLines[i]);
      } else {
        sample.push("-" + aLines[i]);
        sample.push("+" + bLines[i]);
      }
    }
    if (Math.abs(m - n) > 0 || m > maxSample) {
      sample.push(` ... ${m} lines -> ${n} lines, too large for per-line diff`);
    }
    return out.concat(sample).join("\n");
  }

  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Int32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    const ai = aLines[i - 1];
    const dpi = dp[i];
    const dpi_1 = dp[i - 1];
    for (let j = 1; j <= n; j++) {
      dpi[j] = ai === bLines[j - 1] ? dpi_1[j - 1] + 1 : Math.max(dpi_1[j], dpi[j - 1]);
    }
  }

  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      ops.push({ t: " ", l: aLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ t: "+", l: bLines[j - 1] });
      j--;
    } else {
      ops.push({ t: "-", l: aLines[i - 1] });
      i--;
    }
  }
  ops.reverse();

  const out = [`--- ${path}`, `+++ ${path}`];
  const ctx = 3;

  const regions = [];
  let p = 0;
  while (p < ops.length) {
    while (p < ops.length && ops[p].t === " ") p++;
    if (p >= ops.length) break;
    let q = p;
    while (q < ops.length && ops[q].t !== " ") q++;
    regions.push({ start: Math.max(0, p - ctx), end: Math.min(ops.length, q + ctx) });
    p = q;
  }

  const merged = [];
  for (const r of regions) {
    if (merged.length > 0 && r.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }

  for (const region of merged) {
    let oldLine = 1, newLine = 1;
    for (let k = 0; k < region.start; k++) {
      if (ops[k].t === " " || ops[k].t === "-") oldLine++;
      if (ops[k].t === " " || ops[k].t === "+") newLine++;
    }
    let oldCnt = 0, newCnt = 0;
    for (let k = region.start; k < region.end; k++) {
      if (ops[k].t === " " || ops[k].t === "-") oldCnt++;
      if (ops[k].t === " " || ops[k].t === "+") newCnt++;
    }
    out.push(`@@ -${oldLine},${oldCnt} +${newLine},${newCnt} @@`);
    for (let k = region.start; k < region.end; k++) {
      out.push(ops[k].t + ops[k].l);
    }
  }

  return out.join("\n");
}

function computeFileDiffs(before, after, changes) {
  const fileDiffs = [];
  for (const change of changes) {
    const { path, type } = change;
    const a = before.get(path);
    const b = after.get(path);

    if (type === "added") {
      if (b && b.content !== undefined) {
        fileDiffs.push({
          path,
          type: "added",
          unified_diff: computeUnifiedDiff("", b.content, path),
        });
      } else {
        fileDiffs.push({ path, type: "added", summary: "Binary, large, or unreadable file; diff not computed" });
      }
    } else if (type === "deleted") {
      if (a && a.content !== undefined) {
        fileDiffs.push({
          path,
          type: "deleted",
          unified_diff: computeUnifiedDiff(a.content, "", path),
        });
      } else {
        fileDiffs.push({ path, type: "deleted", summary: "Binary, large, or unreadable file; content not available" });
      }
    } else if (type === "modified") {
      if (a && a.content !== undefined && b && b.content !== undefined) {
        fileDiffs.push({
          path,
          type: "modified",
          unified_diff: computeUnifiedDiff(a.content, b.content, path),
        });
      } else {
        fileDiffs.push({ path, type: "modified", summary: "Large/binary/unreadable file; diff not computed" });
      }
    }
  }
  const diffAvailable = fileDiffs.some((f) => f.unified_diff !== undefined);
  return { fileDiffs, diffAvailable };
}

function buildReviewSummary({ changedFiles, diffAvailable, policy, checks, failureReason, requiresReview, job = null }) {
  const checksPassed = checks.filter((c) => c.exit_code === 0 && !c.timed_out);
  return {
    files_changed: changedFiles.sort(),
    change_count: changedFiles.length,
    policy_ok: policy.ok,
    checks_passed: checksPassed.length,
    checks_count: checks.length,
    requires_review: requiresReview,
    diff_available: diffAvailable,
    failure_reason: failureReason,
    last_successful_tool: job?.last_successful_tool ?? null,
    last_failed_tool: job?.last_failed_tool ?? null,
    last_error_kind: job?.last_error_kind ?? null,
    tool_calls_since_last_change: job?.tool_calls_since_last_change ?? 0,
  };
}

function appendBounded(current, addition) {
  const next = current + addition;
  return next.length > MAX_OUTPUT_CHARS ? next.slice(-MAX_OUTPUT_CHARS) : next;
}

function tail(value) {
  return value.length > MAX_OUTPUT_CHARS ? value.slice(-MAX_OUTPUT_CHARS) : value;
}

function toolResult(value) {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? { server_version: SERVER_VERSION, ...value }
    : { server_version: SERVER_VERSION, value };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(error) {
  return {
    message: error.message,
    data: error.data ?? null,
  };
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
