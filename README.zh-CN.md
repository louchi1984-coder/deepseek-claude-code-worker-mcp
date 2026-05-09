# DeepSeek Code Worker MCP

语言：[English](README.md) | [简体中文](README.zh-CN.md)

面向 Codex Desktop 的代码 worker MCP：让 Codex 负责思考、派活和审查，把真正读代码、改代码、跑检查的消耗交给 DeepSeek V4。

目标很简单：**省 Codex 主线程 token，不省 DeepSeek token**。适合的代码任务里，目标是减少约 40-60% 的 Codex 主线程 token 消耗。

## 它做什么

- 用 DeepSeek V4 驱动 Claude Code 干真实代码活
- 单独调用，不影响本机 Claude Code 正常使用
- 异步 worker：`start` / `get` / `tail` / `wait` / `cancel`
- 适配 DeepSeek 长思考，默认不乱杀进程
- 返回状态、变更文件、snapshot diff、policy、checks
- 默认收敛 Claude Code 权限，不开 `bypassPermissions`
- 提供 `setup` / `doctor`，方便安装、输入 key、检查环境

这个 MCP 不是独立 DeepSeek 客户端。它内置一个很小的 `claude-deepseek` 启动器：调用本机 Claude Code CLI，并把子进程请求切到 DeepSeek 的 Anthropic-compatible endpoint。

## 快速开始

这个项目还没有发布到 npm registry。现在只推荐两种方式。

GitHub / 不做全局安装：

```json
{
  "mcpServers": {
    "deepseek-code-worker": {
      "command": "npx",
      "args": [
        "github:louchi1984-coder/deepseek-claude-code-worker-mcp#v0.3.20-beta.32"
      ]
    }
  }
}
```

源码模式，适合本地开发：

```bash
git clone https://github.com/louchi1984-coder/deepseek-claude-code-worker-mcp.git
cd deepseek-claude-code-worker-mcp
npm install
npm run mcp:setup
npm run mcp:doctor
```

源码模式 MCP 配置：

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

检查 GitHub tag，不安装：

```bash
npx github:louchi1984-coder/deepseek-claude-code-worker-mcp#v0.3.20-beta.32 --doctor
```

看到类似输出即可：

```json
{
  "server_version": "0.3.20-beta.32",
  "ok": true
}
```

## 不会用终端怎么办

把这段发给 Codex Desktop：

```text
请帮我安装并配置这个 MCP：
https://github.com/louchi1984-coder/deepseek-claude-code-worker-mcp

要求：
1. 从 GitHub 安装 MCP
2. 如果没有 Claude Code，请先征求我同意再安装
3. 运行 setup/doctor
4. 如果缺 DeepSeek key，请打开交互 setup，让我输入 key
5. 写入 ~/.codex/config.toml
6. 完成后告诉我是否需要重启 Codex Desktop
```

## 依赖和 key

- Node.js 20+
- Claude Code CLI
- DeepSeek API key
- macOS / Linux 是主要目标；Windows 是 best-effort 支持

setup 会做两件事：

- 没有 Claude Code 时，询问是否安装 `@anthropic-ai/claude-code`
- 没有 DeepSeek auth 时，提示输入 key，并保存到 `~/.codex/secrets/deepseek_api_key`

也可以直接用环境变量：

- `ANTHROPIC_AUTH_TOKEN`
- `DEEPSEEK_API_KEY_FILE`
- `CLAUDE_BIN`

安装包不会内置 key，也不会修改你本机 Claude Code 的全局配置。

## 推荐用法

标准代码任务用异步 worker：

```json
{
  "name": "deepseek_start_implementation",
  "arguments": {
    "cwd": "/absolute/project/path",
    "task": "Make the requested code change."
  }
}
```

查状态：

```json
{
  "name": "deepseek_get_job",
  "arguments": {
    "job_id": "dsw_..."
  }
}
```

规则：

- Codex 定任务边界
- DeepSeek worker 单线程实现
- Codex 只看紧凑状态，终态后审 diff/checks
- 一个清楚的实现任务对应一个 worker。第一个 job 还在 running 时，不要为同一任务再开第二个 worker。
- 如果终态后确实需要后续 worker，新 task 必须带上上一轮 `job_id`、终态、失败/check 结果和当前 diff 摘要。
- running 时不要请求 logs/events/diffs
- 不要把 `deepseek_wait_for_job` 当主循环

DeepSeek V4 Pro 复杂任务里，单次连续 thinking/quiet 约 10 分钟是正常的，不是累计 job 总时长。

## 工具

- `deepseek_start_implementation`：启动后台任务，返回 `job_id`
- `deepseek_get_job`：读取紧凑状态
- `deepseek_tail_job`：读取紧凑状态；日志需显式开启
- `deepseek_wait_for_job`：短窗口观察，不会杀 worker
- `deepseek_cancel_job`：取消 running job
- `deepseek_implement_in_workspace`：同步执行，只适合很小改动

默认不返回大日志、stream events、per-file diff。需要时显式传：

- `include_logs: true`
- `include_events: true`
- `include_diff: true`

## 用例预设

| `use_case` | 默认模型 | effort | 适合 |
| --- | --- | --- | --- |
| `auto` | `deepseek-v4-flash` | `max` | 普通实现 |
| `fast_patch` | `deepseek-v4-flash` | `high` | 小补丁 |
| `simple_agent_task` | `deepseek-v4-flash` | `high` | 简单 agentic coding |
| `scaffold_or_tests` | `deepseek-v4-flash` | `high` | 脚手架、胶水代码、测试 |
| `debug_loop` | `deepseek-v4-pro[1m]` | `max` | 复现、定位、最小修复 |
| `agentic_coding` | `deepseek-v4-pro[1m]` | `max` | 多步骤实现 |
| `complex_reasoning` | `deepseek-v4-pro[1m]` | `max` | 架构、复杂逻辑、失败分析 |
| `long_context_codebase` | `deepseek-v4-pro[1m]` | `max` | 大上下文代码库 |
| `docs_generation` | `deepseek-v4-pro[1m]` | `high` | 文档生成 |

调用方显式传 `model`、`thinking`、`reasoning_effort` 时，会覆盖预设。

## 权限边界

这个 MCP 不是 OS/container 沙箱。它的边界是：

- 每个 worker 临时生成 Claude Code `dontAsk` settings
- `PreToolUse` hook 阻止危险 Bash、禁用路径、越界写入
- 任务结束后用 workspace snapshot 做最终 policy 检查

默认禁用 `bypassPermissions`。没有真实沙箱前，不建议启用。

`scoped_patch` 需要配合窄 `allowed_dirs` 使用。

## 验证

```bash
npm run mcp:doctor
npm run mcp:smoke:stream
npm run mcp:smoke:permission
npm run mcp:smoke:restore
```

真实 worker 端到端 smoke：

```bash
npm run mcp:smoke
```

真实 smoke 需要 Claude Code CLI 和 DeepSeek key，可能运行较久。

## 状态

当前版本是 beta。适合项目内部和愿意试用的开发者使用。发布 npm stable 前，建议再跑一轮干净机器安装和真实 worker 端到端验证。
