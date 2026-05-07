# DeepSeek Code Worker MCP

Languages: [English](README.md) | [简体中文](README.zh-CN.md)

Pure-execution MCP server that lets Codex, Claude Desktop, or another MCP host
delegate real workspace code changes to DeepSeek V4 through Claude Code.

This is not a standalone DeepSeek client. It includes a small `claude-deepseek`
launcher that runs the local Claude Code CLI against DeepSeek's
Anthropic-compatible endpoint.

It exposes a DeepSeek V4 coding worker backed by Claude Code:

```text
MCP host
  -> deepseek-code-worker MCP
  -> claude-deepseek -p
  -> real workspace edits
  -> MCP checks changed files / policy / optional commands
```

The worker is intentionally not advisory. A call succeeds only when real files change.

## Quick Start

From a cloned repo:

```bash
npm install
npm run mcp:setup
npm run mcp:doctor
```

Point the MCP client at the repo script:

```json
{
  "mcpServers": {
    "deepseek-code-worker": {
      "command": "node",
      "args": ["/absolute/path/to/deepseek-claude-code-worker-mcp/src/deepseek-worker-mcp.mjs"]
    }
  }
}
```

Install directly from GitHub:

```bash
npm install -g github:louchi1984-coder/deepseek-claude-code-worker-mcp#v0.3.19-beta.2
deepseek-code-worker-setup
deepseek-code-worker-mcp --doctor
```

After this package is published to npm, install and configure the binary:

```bash
npm install -g deepseek-claude-code-worker-mcp
deepseek-code-worker-setup
deepseek-code-worker-mcp --doctor
```

```json
{
  "mcpServers": {
    "deepseek-code-worker": {
      "command": "deepseek-code-worker-mcp"
    }
  }
}
```

## Requirements

- Node.js 20+
- A working Claude Code CLI executable
  - setup can install it with confirmation if `claude` is missing
  - or use an existing `claude` available on `PATH`
  - or set `CLAUDE_BIN=/absolute/path/to/claude`
- DeepSeek auth for the bundled `claude-deepseek` launcher
  - either `ANTHROPIC_AUTH_TOKEN`
  - or `DEEPSEEK_API_KEY_FILE`
  - or a key saved at `~/.codex/secrets/deepseek_api_key`

This MCP does not have a separate API key. The bundled `claude-deepseek` launcher
uses DeepSeek credentials through Claude Code's Anthropic-compatible environment
variables. Run setup after installing or cloning this package:

```bash
deepseek-code-worker-setup
```

or, from a cloned repo:

```bash
npm run mcp:setup
```

Setup checks for Claude Code. If `claude` is missing and setup is running in an
interactive terminal, it asks whether to run
`npm install -g @anthropic-ai/claude-code`. If no DeepSeek auth is configured,
setup prompts for a DeepSeek API key in the terminal and saves it to
`~/.codex/secrets/deepseek_api_key` with user-only file permissions. In
non-interactive MCP mode the server never prompts for secrets; it returns a clear
doctor/error message instead.

## For Calling Agents

For normal coding tasks, use the async worker with only `cwd` and `task`:

```json
{
  "name": "deepseek_start_implementation",
  "arguments": {
    "cwd": "/absolute/project/path",
    "task": "Make the requested code change."
  }
}
```

Then read status with a non-blocking call:

```json
{
  "name": "deepseek_get_job",
  "arguments": {
    "job_id": "dsw_..."
  }
}
```

Use `deepseek_tail_job` when you need recent stdout/stderr and compact stream
events. Use `deepseek_wait_for_job` only as a short observation window; do not
make one long foreground tool call just because DeepSeek may think for a long
time. Long thinking is normal, and the worker keeps running independently of
individual `get`, `tail`, or `wait` calls.

Default rules for callers:

- Default division of labor: the host agent decides task boundaries, the
  DeepSeek worker executes one clearly scoped implementation task, and the host
  agent reviews `file_diffs`, `policy`, and `checks_run`.
- The worker should not spawn subagents or use `Task` unless the user explicitly
  asks for nested worker delegation.
- Prefer `deepseek_start_implementation` for standard tasks.
- After start, prefer `deepseek_get_job` or `deepseek_tail_job` for status.
- If you use `deepseek_wait_for_job`, treat it as a short foreground observation
  helper. The MCP caps a single wait below common host tool-call limits and keeps
  the worker alive.
- For `deepseek-v4-pro[1m]`, a single continuous thinking/quiet segment of about
  10 minutes can be normal on complex coding work. This is not a cumulative job
  time budget. Never cancel, restart, or take over a running worker solely
  because one thinking segment has lasted several minutes.
- Thinking expectations are per continuous segment, not cumulative job runtime:

  | Model / use case | Normal single thinking or quiet segment |
  | --- | --- |
  | `deepseek-v4-flash`, `fast_patch` | 1-3 minutes |
  | `deepseek-v4-flash`, ordinary implementation | 3-5 minutes |
  | `deepseek-v4-pro[1m]`, debug/agentic/complex/long-context | about 10 minutes |
  | `deepseek-v4-pro[1m]`, `docs_generation` | 5-10 minutes |

- While the worker is `running`, only observe status/activity. Do not analyze
  `file_diffs`, `policy`, or `checks_run` until the job is `completed`, `failed`,
  `cancel_requested`, or `orphaned`.
- Use `deepseek_implement_in_workspace` only for tiny, quick edits.
- Standard implementation uses MCP-managed `dontAsk` permissions with a
  `PreToolUse` hook, so callers should not need to approve normal Read/Edit
  operations.
- Pass `checks` when the validation command is obvious, such as `pnpm test` or
  `pnpm typecheck`.
- Do not set `timeout_ms` unless the user explicitly wants a hard stop.
- Do not treat quiet output as failure. Check `process_alive`, `phase`,
  `observed_state`, `idle_seconds`, `pending_tool_use`, and
  `changed_files_so_far`.
- Do not use `bypassPermissions`; this MCP intentionally disables it.
- Use `worker_profile: "scoped_patch"` only when you also provide narrow
  `allowed_dirs`.
- Do not call this MCP for advice-only questions. It is for real workspace edits.

## Commands

```bash
npm run mcp:deepseek-worker
```

For an installed package, run:

```bash
deepseek-code-worker-mcp
```

Run a local environment check with:

```bash
npm run mcp:doctor
```

or, after installation:

```bash
deepseek-code-worker-mcp --doctor
```

The doctor checks Node.js, the bundled `claude-deepseek` launcher, the local
Claude Code CLI, DeepSeek auth, job-root writability, and the default
`stream-json` Claude Code argument shape. If Claude Code or auth is missing,
run setup in an interactive terminal.

Configure an MCP client with the package binary:

```json
{
  "mcpServers": {
    "deepseek-code-worker": {
      "command": "deepseek-code-worker-mcp"
    }
  }
}
```

For local development without installing the binary, point the client at the
repo script:

```json
{
  "mcpServers": {
    "deepseek-code-worker": {
      "command": "node",
      "args": ["/absolute/path/to/deepseek-claude-code-worker-mcp/src/deepseek-worker-mcp.mjs"]
    }
  }
}
```

By default this MCP uses its bundled `bin/claude-deepseek.mjs` launcher. Set
`CLAUDE_DEEPSEEK_BIN=/absolute/path/to/another/launcher` only if you want to
override it.

## Tools

- `deepseek_implement_in_workspace`: synchronous execution. Can run for a long time.
- `deepseek_start_implementation`: starts a background job and returns `job_id`.
- `deepseek_get_job`: polls an async job, including progress.
- `deepseek_tail_job`: returns only progress and log tails for a running job.
- `deepseek_wait_for_job`: observes a job for a short foreground heartbeat
  window. It returns completion/failure if done; otherwise it returns `running`
  and leaves the worker alive.
- `deepseek_cancel_job`: requests cancellation for a running job.

## DeepSeek V4 Use Cases

The implementation tools accept a `use_case` preset so callers can route work according
to the official DeepSeek V4 positioning instead of hand-writing strategy into every
prompt.

| `use_case` | Default model | Thinking | Best for |
| --- | --- | --- | --- |
| `auto` | `deepseek-v4-flash` | enabled / high | general implementation with a Flash-first default |
| `fast_patch` | `deepseek-v4-flash` | disabled / high | small, low-risk edits where speed matters |
| `simple_agent_task` | `deepseek-v4-flash` | enabled / high | simple Agent tasks, where Flash is close to Pro |
| `scaffold_or_tests` | `deepseek-v4-flash` | enabled / high | scaffolding, integration glue, CRUD-style code, tests |
| `debug_loop` | `deepseek-v4-pro[1m]` | enabled / max | reproduce/inspect, locate cause, make minimal fix, validate |
| `agentic_coding` | `deepseek-v4-pro[1m]` | enabled / max | multi-step coding agents, tool loops, validation; review by default |
| `complex_reasoning` | `deepseek-v4-pro[1m]` | enabled / max | architecture, failure analysis, hard logic; review by default |
| `long_context_codebase` | `deepseek-v4-pro[1m]` | enabled / max | broad codebase work that benefits from 1M context; review by default |
| `docs_generation` | `deepseek-v4-pro[1m]` | enabled / high | documentation generation; allows docs-only diffs |

Manual `model`, `thinking`, and `reasoning_effort` values still override the preset.
For community-backed day-to-day use, prefer `fast_patch` or `scaffold_or_tests`.
For bugs, prefer `debug_loop`. For complex Agent scenarios, prefer
`agentic_coding`, `complex_reasoning`, or `long_context_codebase`; those presets
return `requires_review: true` even when the success contract passes.

## ECC-Inspired Harness Rules

This worker borrows a few design principles from Everything Claude Code without
installing or copying that project:

- use_case presets behave like lightweight commands/skills
- `verification_profile` names the intended verification loop:
  `smoke`, `standard`, `debug`, `review`, or `docs`
- `checks` remain the source of truth for actual validation commands
- complex and long-context presets are review-gated by default
- safety boundaries stay explicit through `allowed_dirs` and `forbidden_paths`
- status is persisted under the job directory so callers can resume observation

`verification_profile` is included in the worker prompt and final result. It does
not invent commands; callers should still pass concrete `checks`.

`use_case` describes task type. `worker_profile` describes the permission and
artifact contract:

- `implementation` is the default and uses MCP-managed Claude Code
  `permission_mode: "dontAsk"` with the workspace as the allowed write scope
- `scoped_patch` opts into `permission_mode: "dontAsk"` with per-worker
  allow/deny settings and requires explicit, narrow `allowed_dirs`
- `review` is intended for read-mostly review work
- `debug_loop` is intended for reproduce/inspect/fix/check loops

`forbidden_paths` may be provided explicitly and otherwise defaults to common
secret and lock files. The final MCP policy check is authoritative: changes
outside `allowed_dirs` or inside `forbidden_paths` fail the job even if Claude
Code wrote them.

When `permission_mode` is `dontAsk`, the MCP passes a temporary Claude Code
settings object with `permissions.allow`/`permissions.deny`. It allows core file
tools and caller-provided checks, denies common dangerous Bash patterns and
forbidden paths, and returns `claude_settings_active: true` in job payloads.
It also installs a per-worker `PreToolUse` hook handled by this MCP process.
Default implementation workers can write only inside the workspace. Scoped patch
workers can write only inside explicit `allowed_dirs` and can only run
caller-approved Bash checks. Forbidden paths are blocked before execution.
`bypassPermissions` is intentionally disabled until a real sandbox is added.

## Security Boundary

This MCP is not an OS/container sandbox. Its safety model is:

- Claude Code `dontAsk` settings generated per worker
- a `PreToolUse` hook that blocks dangerous Bash, forbidden paths, and writes
  outside the allowed scope
- a final snapshot policy check over changed files

Those controls are useful guardrails, but they are not strong isolation against a
malicious process. Run this worker only in workspaces where a local coding agent
is acceptable. Keep `bypassPermissions` disabled unless you add a real sandbox
outside this MCP.

DeepSeek V4 Pro with thinking/max can spend a long time without writing files.
The default is Claude Code `--output-format stream-json` with `--verbose` placed
before `--output-format` and `--include-partial-messages` after it. `--verbose` is
required by current Claude Code for stream-json print output. Set
`output_format: "json"` only as a fallback if the local Claude Code build rejects
stream-json. Stream events still do not prove whether the model is "thinking" or
"hung", so callers should show observable process facts instead of claiming the
model is definitely thinking:

- `phase`: current worker phase, such as `model_running`, `snapshotting`,
  `model_streaming`, `tool_activity`, `checking`, `completed`, or `failed`
- `phase_message`: user-readable status text
- `observed_state`: one of `alive_recent_output_or_startup`,
  `alive_quiet_no_recent_output`, `alive_with_workspace_changes`,
  `alive_quiet_with_workspace_changes`, `alive_recent_stream_event`,
  `process_not_alive`, `completed`, `failed`, `cancel_requested`, or `unknown`
- `suggested_action`: host-facing next step based on observable state
- `last_event_at`, `last_event_type`, `last_event_summary`, and `recent_events`:
  compact Claude Code stream event details
- `process_alive` and `process_pid`: whether the child process is still alive
- `idle_seconds` and `quiet`: how long the worker has produced no stdout/stderr
- `last_output_at`: latest worker log timestamp, if any
- `recommended_poll_after_ms`: suggested time before polling again

For example, `observed_state: "alive_quiet_no_recent_output"` means only that the
process is still alive and quiet. It is not proof that DeepSeek is thinking, and it
is not proof that the process is dead.

In fallback `json` mode, status falls back to process/log/workspace observation
because Claude Code emits a single final JSON object. Start/tail/result payloads
include `claude_args_preview` so the actual Claude Code argv is visible.

Async jobs do not have a worker timeout by default. This is intentional: there is no
official or reliable wall-clock bound for DeepSeek thinking time. `timeout_ms` is
therefore only a caller-imposed stop time when explicitly provided. The synchronous
tool keeps a short foreground protection limit; long DeepSeek tasks should use
`deepseek_start_implementation`.

Caller-imposed stops are artifact-aware. If `timeout_ms` stops the worker after it
produces changes that stay inside `allowed_dirs`, avoid `forbidden_paths`, satisfy
the docs-only policy, and pass any completed checks, the result status is
`partial_caller_timeout` instead of a plain failure. Callers should show
`requires_review: true` and ask the user or host agent to inspect the diff before
accepting it. If the worker changed files outside the allowed scope, the policy
failure still wins and the result remains failed.

Cancellation is artifact-aware too. If a worker is alive but quiet after producing
files, `deepseek_cancel_job` preserves the artifacts, runs the MCP-level policy and
checks, and may return `partial_cancelled` when those checks pass. Treat worker
natural-language summaries as advisory only; `checks_run`, `policy`, and
`files_changed` are the authoritative validation record.

Running jobs write local state under:

```text
/tmp/deepseek-code-worker/jobs/<job_id>/
  status.json
  before-snapshot.json
  stdout.log
  stderr.log
```

The MCP can restore jobs from this directory after a server restart. Restored
completed/failed jobs remain inspectable through `deepseek_get_job` and
`deepseek_tail_job`. If a persisted job was `running` but the recorded worker PID
is no longer alive, the MCP marks it `status: "orphaned"` and
`deepseek_wait_for_job` returns `needs_review` with
`reason: "orphaned_after_mcp_restart"` instead of waiting forever.

While a job is running, `deepseek_get_job` and `deepseek_tail_job` report:

- `server_version`
- `elapsed_ms`
- `worker_profile`
- `permission_mode`
- `changed_files_so_far`
- `diff_available`
- `review_summary`
- `last_change_at`
- `observed_state`
- `suggested_action`
- `process_alive`
- `last_event_summary`
- `recent_events`
- `stdout_tail`
- `stderr_tail`
- `recommended_poll_after_ms`

For status polling, prefer `deepseek_get_job` or `deepseek_tail_job`; both return
immediately. `deepseek_wait_for_job` is only a bounded observation helper. It
loops inside the MCP server for a short foreground window, about 90 seconds by
default. If the worker completes or fails during that window, it returns the
terminal status. Otherwise it returns `status: "running"` with recent activity,
changed files so far, and `reason: "foreground_wait_cap_elapsed"` or
`reason: "max_wait_elapsed"`. It never cancels the worker by itself.

Running status is only a heartbeat. Do not review diffs, policy, or checks while
the worker is still running unless the user explicitly asks for partial review.
Wait for a terminal status first, then inspect `file_diffs`, `policy`, and
`checks_run`.

The MCP server is expected to stay alive while the host keeps its stdio transport
open. When the host closes stdin or sends `SIGTERM` / `SIGINT`, the server shuts
itself down and asks any still-running worker child process to stop, so stale MCP
server processes should not accumulate after reconnects.

Completed results include snapshot-based review data even when the workspace is not
a git repository:

- `files_changed` and `change_count`
- `diff_available`
- `file_diffs`: per-file unified diffs for text files, or summaries for large,
  binary, or unreadable files
- `review_summary`: compact fields for host UIs and calling models:
  `files_changed`, `change_count`, `policy_ok`, `checks_passed`,
  `checks_count`, `requires_review`, `diff_available`, `failure_reason`,
  `last_successful_tool`, `last_failed_tool`, `last_error_kind`, and
  `tool_calls_since_last_change`

The worker prompt is hardened for tool behavior: it asks Claude Code to prefer
Read/Edit or MultiEdit, avoid Bash `cat`, shell redirection, and heredocs for
normal source edits, list changed files, run requested checks, and stop with a
clear blocker instead of retrying indefinitely after permission/tool failures.

## Success Contract

The server returns `status: "changed_files"` only when:

- files actually changed
- no changed file is outside `allowed_dirs`
- no changed file is under `forbidden_paths`
- the diff is not docs-only unless `allow_docs_only: true`
- all optional `checks` pass

It may return `status: "partial_caller_timeout"` when valid file changes exist but
a caller-provided `timeout_ms` stopped the worker process. This is useful for host
UIs that need an explicit foreground limit without discarding valid artifacts.

It may return `status: "partial_cancelled"` when `deepseek_cancel_job` stopped the
worker after valid file changes existed and MCP-level policy/checks passed.

Otherwise it returns `status: "failed"` with `failure_reason`.

## Smoke Tests

Recommended pre-publish checks:

```bash
npm run mcp:doctor
node --check src/deepseek-worker-mcp.mjs
node --check src/core/config.mjs
node --check src/core/stream-events.mjs
npm run mcp:smoke:permission
npm run mcp:smoke:restore
npm run mcp:smoke:stream
```

`npm run mcp:smoke` starts a real DeepSeek worker and can take much longer. Run
it before a release when `claude-deepseek` and a test workspace are available.

Use a code file for execution smoke tests, for example `smoke.js` or `smoke.ts`.
Pure `.txt`, `.md`, `.mdx`, `.rst`, `.adoc`, or `docs/` changes are classified as
docs-only and fail with `failure_reason: "docs_only_change"` unless
`allow_docs_only: true` is passed. This is intentional policy behavior, not a
worker execution failure.

Use `npm run mcp:smoke:permission` to test the `PreToolUse` hook decisions for
approved checks, dangerous Bash, scoped Bash denial, allowed writes, out-of-scope
writes, and forbidden path reads.

Use `npm run mcp:smoke:restore` to test durable job restore without starting a
real DeepSeek worker. It creates a fake persisted running job, verifies that a new
MCP process restores it as `orphaned`, then cleans up the temporary files.

Use `npm run mcp:smoke:stream` to test the stream-json event classifier fixtures
for thinking deltas, tool use, tool result, final result, nested event payloads,
and partial JSON line handling.

## Changelog

### 0.3.19

- README now starts with a publish-ready quick start for cloned repos and future
  npm installs.
- Removed placeholder package repository metadata.
- Updated tool descriptions to match passive heartbeat behavior.

### 0.3.18

- MCP server now exits on stdio close/end and on `SIGTERM` / `SIGINT`.
- Shutdown marks running jobs as `cancel_requested`, records
  `mcp_server_shutdown`, and terminates any active worker child process.

### 0.3.17

- `deepseek_wait_for_job` is now passive while jobs are running. It reports
  completion/failure or a running heartbeat; it no longer marks quiet running jobs
  as `needs_review`.
- README now tells calling agents to review diffs/checks only after terminal job
  status.

### 0.3.16

- `deepseek_wait_for_job` now has an MCP foreground wait cap. A single wait call
  returns before common host tool-call limits while leaving long-running DeepSeek
  workers alive.

### 0.3.15

- Setup now offers to install Claude Code with user confirmation when `claude`
  is missing.
- Doctor now points users to setup for both Claude Code and DeepSeek auth.

### 0.3.14

- Added interactive setup command: `deepseek-code-worker-setup` /
  `deepseek-code-worker-mcp --setup`.
- Setup can save a DeepSeek API key to `~/.codex/secrets/deepseek_api_key`.

### 0.3.13

- Added bundled `claude-deepseek` launcher.
- Added package bin aliases: `claude-deepseek`, `claude-deepseek-pro`, and
  `claude-deepseek-flash`.
- Doctor now checks Claude Code CLI and DeepSeek auth in addition to the MCP
  server.

### 0.3.12

- Clarified that this MCP is not standalone and requires a working
  `claude-deepseek` launcher.
- Improved missing-launcher error messages.

### 0.3.11

- Added durable job restore from `/tmp/deepseek-code-worker/jobs`.
- Added `orphaned_after_mcp_restart` status for persisted running jobs whose PID
  is no longer alive.
- Split config and stream event parsing into `src/core`.
- Added stream event and restore smoke tests.
- Switched default implementation permissions to MCP-managed `dontAsk` plus
  `PreToolUse` hook.
- Added package binary and doctor command.
- Removed local hard-coded `claude-deepseek` path.
