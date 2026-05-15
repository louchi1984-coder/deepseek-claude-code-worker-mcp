# DeepSeek Code Worker MCP

语言：[English](README.md) | [简体中文](README.zh-CN.md)

面向 Codex Desktop 的代码 worker MCP：让 Codex 负责思考、派活和审查，把真正读代码、改代码、跑检查的消耗交给 DeepSeek V4。

目标很简单：**省 Codex 主线程 token，不省 DeepSeek token**。适合的代码任务里，目标是减少约 40-60% 的 Codex 主线程 token 消耗。

## 当前 Beta

当前 GitHub beta tag：`v0.3.20-beta.37`。

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
        "github:louchi1984-coder/deepseek-claude-code-worker-mcp#v0.3.20-beta.37"
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
npx github:louchi1984-coder/deepseek-claude-code-worker-mcp#v0.3.20-beta.37 --doctor
```

看到类似输出即可：

```json
{
  "server_version": "0.3.20-beta.37",
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
- Codex 只在需要知道 worker 事实时查询 MCP 状态
- MCP 只汇报观察到的事实：进程状态、变更文件、diff、checks、是否触碰 forbidden paths、错误
- 可用时，Claude Code hooks 会记录紧凑工具动作摘要
- MCP 不建议轮询间隔，不判断 quiet 就是卡住，不告诉 Codex 什么时候接管
- Codex 在终态后审 diff/checks
- 一个清楚的实现任务对应一个 worker。第一个 job 还在 running 时，不要为同一任务再开第二个 worker。
- 如果终态后确实需要后续 worker，新 task 必须带上上一轮 `job_id`、终态、失败/check 结果和当前 diff 摘要。
- running 时不要请求 logs/events/diffs
- 不要把 `deepseek_wait_for_job` 当主循环

DeepSeek V4 Pro 复杂任务里，单次连续 thinking/quiet 约 10 分钟是正常的，不是累计 job 总时长。

## 省 Codex Token 的工作纪律

这个 MCP 的价值来自“少让 Codex 读写代码”，不是来自让 DeepSeek 便宜。推荐这样用：

- 派给 worker 的任务要窄：一个目标、清楚边界、明确验证命令。
- Codex 不要先读完整代码库再派活；只下发本轮必须知道的项目 brief。
- eval 报告这类验证生成副作用放进 `generated_paths`，不要为了它放宽 `allowed_dirs`。
- running 时默认不要请求 logs、events、diffs；需要状态时读紧凑状态。
- 终态后 Codex 只审 `files_changed`、核心实现区间、checks 和 known risks。
- 大型生成结果文件、评估输出、日志汇总、快照文档，不要默认让 worker 反复读写；优先让 worker 改核心实现，由验证命令或主线程最后统一生成结果。
- 后续 worker 只带上一轮必要摘要，不带长对话历史。

项目 brief 建议保持很短，例如：

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

默认状态输出会刻意保持很小：不返回轮询建议、`suggested_action`、语义状态标签、pending tool 调试字段或 Claude 参数预览。

本地版会把 Claude Code hook 摘要写到每个 job 目录的 `tool-events.jsonl`。默认状态只暴露很小的 `tool_activity` 汇总；完整 hook/stream 细节需要显式传 `include_events: true`。hook 摘要不会保存文件内容、Edit 的 old/new string 或完整命令输出。

## 用例预设

模型选择是这个 MCP 的核心 know-how：默认先用便宜快的 `deepseek-v4-flash` 做普通实现；只有任务需要大上下文、调试闭环、复杂推理或多步骤 agentic coding 时，才切到 `deepseek-v4-pro[1m]`。省的是 Codex 主线程 token，不是 DeepSeek token。

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

选择规则：

- 默认用 `auto`
- 明确很小的改动用 `fast_patch`
- 测试、脚手架、胶水代码用 `scaffold_or_tests`
- 失败复现、定位、修复、验证用 `debug_loop`
- 跨文件实现、复杂逻辑、大上下文代码库用 Pro[1m] 相关预设
- 不要为了“看起来更强”默认上 Pro[1m]；也不要让 Codex 自己读完整代码库后再派 worker

## 权限边界

这个 MCP 不是 OS/container 沙箱。它的边界是：

- 每个 worker 临时生成 Claude Code `dontAsk` settings
- `PreToolUse` hook 阻止明显危险 Bash、禁用路径、直接越界写入
- Claude Code hooks 记录紧凑动作日志
- 任务结束后用 workspace snapshot 做最终 policy 检查

默认 `safety_mode` 是 `permissive`：允许 Bash，只拦明显危险命令。需要更严格时传 `safety_mode: "safe"`，把 Bash 限制为只读定位命令和显式 checks。

默认禁用 `bypassPermissions`。没有真实沙箱前，不建议启用。

`scoped_patch` 需要配合窄 `allowed_dirs` 使用。

`generated_paths` 用来声明验证或 eval 命令预期会生成/更新的文件，比如
`docs/WORKFLOW_EVAL_RESULTS.md`。这些文件会报告为 `generated_changed`，不会算成
越界编辑；但如果同一个文件也在 `forbidden_paths`，仍然按 forbidden 硬失败处理。

版本 `0.3.20-beta.37` 的原则：汇报动作，不替 Codex 判案。`allowed_dirs` 外的普通变更会作为事实报告，不再自动判定 worker 失败；`forbidden_paths` 仍然是硬失败。`allow_docs_only` 只保留为兼容旧调用的参数，文档变更会被报告，不再因为 docs-only 自动失败。

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
