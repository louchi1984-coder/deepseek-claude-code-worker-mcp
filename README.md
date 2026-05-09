# DeepSeek Code Worker MCP

Languages: [English](README.md) | [简体中文](README.zh-CN.md)

Coding-worker MCP for Codex Desktop. Codex plans, delegates, and reviews; DeepSeek V4 does the expensive code reading, editing, and checking through Claude Code.

Goal: **save Codex main-thread tokens, not DeepSeek tokens**. For suitable coding tasks, the intended workflow can reduce Codex main-thread token usage by about 40-60%.

## What It Does

- Runs real coding work with DeepSeek V4 through Claude Code
- Works separately from your normal Claude Code usage
- Async worker tools: `start` / `get` / `tail` / `wait` / `cancel`
- Supports long DeepSeek thinking without killing the worker by default
- Returns status, changed files, snapshot diffs, policy, and checks
- Uses scoped Claude Code permissions by default; `bypassPermissions` stays off
- Includes `setup` / `doctor` for install, auth, and environment checks

This is not a standalone DeepSeek client. It includes a small `claude-deepseek` launcher that runs the local Claude Code CLI against DeepSeek's Anthropic-compatible endpoint.

## Quick Start

This project is not published to the npm registry yet. Use one of these two paths.

GitHub / no global install:

```json
{
  "mcpServers": {
    "deepseek-code-worker": {
      "command": "npx",
      "args": [
        "github:louchi1984-coder/deepseek-claude-code-worker-mcp#v0.3.20-beta.35"
      ]
    }
  }
}
```

Source mode, recommended for local development:

```bash
git clone https://github.com/louchi1984-coder/deepseek-claude-code-worker-mcp.git
cd deepseek-claude-code-worker-mcp
npm install
npm run mcp:setup
npm run mcp:doctor
```

Source-mode MCP config:

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

Check a GitHub tag without installing:

```bash
npx github:louchi1984-coder/deepseek-claude-code-worker-mcp#v0.3.20-beta.35 --doctor
```

Expected shape:

```json
{
  "server_version": "0.3.20-beta.35",
  "ok": true
}
```

## If the User Does Not Use Terminal

Paste this into Codex Desktop:

```text
Please install and configure this MCP for Codex Desktop:
https://github.com/louchi1984-coder/deepseek-claude-code-worker-mcp

Requirements:
1. Install the MCP from GitHub.
2. If Claude Code is missing, ask me for permission and install it.
3. Run setup/doctor.
4. If a DeepSeek key is missing, open an interactive setup so I can enter it.
5. Write the MCP server entry to ~/.codex/config.toml.
6. Tell me whether I need to restart Codex Desktop.
```

## Requirements and Auth

- Node.js 20+
- Claude Code CLI
- DeepSeek API key
- macOS / Linux are primary targets; Windows is best-effort

Setup can:

- ask to install `@anthropic-ai/claude-code` when Claude Code is missing
- prompt for a DeepSeek API key and save it to `~/.codex/secrets/deepseek_api_key`

You can also use:

- `ANTHROPIC_AUTH_TOKEN`
- `DEEPSEEK_API_KEY_FILE`
- `CLAUDE_BIN`

The package does not bundle a DeepSeek key and does not modify your global Claude Code configuration.

## Recommended Use

Start a worker:

```json
{
  "name": "deepseek_start_implementation",
  "arguments": {
    "cwd": "/absolute/project/path",
    "task": "Make the requested code change."
  }
}
```

Read compact status:

```json
{
  "name": "deepseek_get_job",
  "arguments": {
    "job_id": "dsw_..."
  }
}
```

Rules:

- Codex defines the task boundary
- DeepSeek worker performs one implementation task
- Codex reads compact status and reviews diff/checks after terminal status
- One clear implementation task should map to one worker. Do not start a second
  worker for the same task while the first job is still running.
- If a follow-up worker is needed after terminal status, include the previous
  job id, terminal status, failure/check result, and current diff summary.
- Do not request logs/events/diffs while the job is `running`
- Do not use `deepseek_wait_for_job` as the main loop

DeepSeek V4 Pro can spend about 10 minutes in one continuous thinking/quiet segment on complex code tasks. That is not cumulative job runtime.

## Tools

- `deepseek_start_implementation`: starts a background job and returns `job_id`
- `deepseek_get_job`: reads compact job status
- `deepseek_tail_job`: reads compact status; logs are opt-in
- `deepseek_wait_for_job`: short observation window; does not kill the worker
- `deepseek_cancel_job`: requests cancellation
- `deepseek_implement_in_workspace`: synchronous mode for tiny edits

Large evidence is opt-in:

- `include_logs: true`
- `include_events: true`
- `include_diff: true`

## Use Cases

| `use_case` | Default model | effort | Best for |
| --- | --- | --- | --- |
| `auto` | `deepseek-v4-flash` | `max` | general implementation |
| `fast_patch` | `deepseek-v4-flash` | `high` | small patches |
| `simple_agent_task` | `deepseek-v4-flash` | `high` | simple agentic coding |
| `scaffold_or_tests` | `deepseek-v4-flash` | `high` | scaffolding, glue code, tests |
| `debug_loop` | `deepseek-v4-pro[1m]` | `max` | reproduce, locate, fix, validate |
| `agentic_coding` | `deepseek-v4-pro[1m]` | `max` | multi-step implementation |
| `complex_reasoning` | `deepseek-v4-pro[1m]` | `max` | architecture, hard logic, failure analysis |
| `long_context_codebase` | `deepseek-v4-pro[1m]` | `max` | broad codebase work |
| `docs_generation` | `deepseek-v4-pro[1m]` | `high` | documentation |

Explicit `model`, `thinking`, or `reasoning_effort` values override the preset.

## Permission Boundary

This MCP is not an OS/container sandbox. Its guardrails are:

- temporary Claude Code `dontAsk` settings per worker
- a `PreToolUse` hook for clearly dangerous Bash, forbidden paths, and out-of-scope writes
- final workspace snapshot policy checks

Default `safety_mode` is `permissive`: Bash is allowed except clearly dangerous commands. Use `safety_mode: "safe"` to restrict Bash to read-only locator commands and explicit checks.

`bypassPermissions` is disabled by default. Keep it off unless you add a real sandbox outside this MCP.

Use `worker_profile: "scoped_patch"` with narrow `allowed_dirs` for tightly scoped patches.

## Verification

```bash
npm run mcp:doctor
npm run mcp:smoke:stream
npm run mcp:smoke:permission
npm run mcp:smoke:restore
```

Real worker smoke:

```bash
npm run mcp:smoke
```

The real smoke requires Claude Code CLI and a DeepSeek key, and can take longer.

## Status

This project is currently beta. It is suitable for internal projects and early adopters. Before a stable npm release, run a clean-machine install and real worker end-to-end verification.
