# DeepSeek Code Worker MCP

Languages: [English](README.md) | [简体中文](README.zh-CN.md)

Coding-worker MCP for Codex Desktop. Codex plans, delegates, and reviews; DeepSeek V4 does the expensive code reading, editing, and checking through Claude Code.

Goal: **save Codex main-thread tokens, not DeepSeek tokens**. For suitable coding tasks, the intended workflow can reduce Codex main-thread token usage by about 40-60%.

## Current Beta

Current GitHub beta tag: `v0.3.20-beta.37`.

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
        "github:louchi1984-coder/deepseek-claude-code-worker-mcp#v0.3.20-beta.37"
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
npx github:louchi1984-coder/deepseek-claude-code-worker-mcp#v0.3.20-beta.37 --doctor
```

Expected shape:

```json
{
  "server_version": "0.3.20-beta.37",
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
- Codex asks MCP for status only when it needs facts about the worker
- MCP reports observed facts: process state, changed files, diffs, checks, forbidden-path touches, and errors
- Claude Code hooks record compact tool-action summaries when available
- MCP does not suggest poll intervals, decide that quiet means stuck, or tell Codex when to take over
- Codex reviews diff/checks after terminal status
- One clear implementation task should map to one worker. Do not start a second
  worker for the same task while the first job is still running.
- If a follow-up worker is needed after terminal status, include the previous
  job id, terminal status, failure/check result, and current diff summary.
- Do not request logs/events/diffs while the job is `running`
- Do not use `deepseek_wait_for_job` as the main loop

DeepSeek V4 Pro can spend about 10 minutes in one continuous thinking/quiet segment on complex code tasks. That is not cumulative job runtime.

## Codex Token-Saving Discipline

This MCP saves tokens when Codex reads and writes less code. Recommended practice:

- Give the worker a narrow task: one goal, clear boundaries, and explicit validation commands.
- Do not make Codex read the whole codebase before delegating; pass only the project brief needed for this slice.
- Put validation-generated side effects, such as eval reports, in `generated_paths` instead of widening `allowed_dirs`.
- While a job is running, avoid logs, events, and diffs by default; read compact status only when facts are needed.
- After terminal status, review only `files_changed`, key implementation ranges, checks, and known risks.
- Large generated result files, eval outputs, log summaries, and snapshot documents should not be repeatedly read or edited by the worker by default. Prefer letting the worker change core implementation and let validation commands or the host produce generated outputs at the end.
- Follow-up workers should receive only the necessary previous-result summary, not the full conversation history.

Keep the project brief short, for example:

```text
Project brief:
- Project: <one-line project goal>
- Current slice: <module or feature boundary>
- Task: <single implementation goal>
- Boundaries: <allowed files/dirs>
- Generated outputs: <eval reports or generated files>
- Do not touch: <forbidden paths>
- Validate: <commands>
- Previous result: <job id + terminal status + relevant diff/check summary>
```

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

Default status output is intentionally small. It does not include poll hints, `suggested_action`, semantic state labels, pending-tool debug fields, or Claude argument previews.

The local build records Claude Code hook summaries in `tool-events.jsonl` inside each job directory. Default status exposes only a tiny `tool_activity` summary. Full hook/stream details require `include_events: true`. Hook summaries intentionally omit file contents, edit old/new strings, and full command output.

## Use Cases

Model selection is core know-how for this MCP: use cheaper/faster `deepseek-v4-flash` for ordinary implementation by default; switch to `deepseek-v4-pro[1m]` only when the task needs broad context, a debugging loop, complex reasoning, or multi-step agentic coding. The goal is to save Codex main-thread tokens, not DeepSeek tokens.

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

Selection rules:

- Use `auto` by default
- Use `fast_patch` for obviously tiny edits
- Use `scaffold_or_tests` for tests, scaffolding, and glue code
- Use `debug_loop` for reproduce, locate, fix, and validate work
- Use the Pro[1m] presets for cross-file implementation, complex logic, or broad codebase context
- Do not default to Pro[1m] just because it sounds stronger; also do not make Codex read the whole codebase before delegating

## Permission Boundary

This MCP is not an OS/container sandbox. Its guardrails are:

- temporary Claude Code `dontAsk` settings per worker
- a `PreToolUse` hook for clearly dangerous Bash, forbidden paths, and direct out-of-scope writes
- Claude Code hooks for compact action logs
- final workspace snapshot policy checks

Default `safety_mode` is `permissive`: Bash is allowed except clearly dangerous commands. Use `safety_mode: "safe"` to restrict Bash to read-only locator commands and explicit checks.

`bypassPermissions` is disabled by default. Keep it off unless you add a real sandbox outside this MCP.

Use `worker_profile: "scoped_patch"` with narrow `allowed_dirs` for tightly scoped patches.

Use `generated_paths` for files that validation or eval commands are expected to
create or update, such as `docs/WORKFLOW_EVAL_RESULTS.md`. These paths are
reported as `generated_changed` and are not counted as out-of-scope edits, while
`forbidden_paths` still wins if the same file is forbidden.

Version `0.3.20-beta.37` principle: report actions, do not adjudicate. `allowed_dirs` changes outside the target scope are reported as facts, not automatically treated as failed work. `forbidden_paths` remains a hard failure. `allow_docs_only` is kept only for compatibility with older calls; documentation changes are reported and no longer fail just because they are docs-only.

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
