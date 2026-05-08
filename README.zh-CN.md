# DeepSeek Code Worker MCP

语言：[English](README.md) | [简体中文](README.zh-CN.md)

这是一个主要面向 Codex Desktop 的纯执行型 MCP server，用来把真实代码修改任务交给 DeepSeek V4 worker 执行。

它的目标不是替代 Codex，而是降低 Codex 主对话在代码任务里的 token 消耗：Codex 负责确定任务边界、轮询状态和最终审查 diff/check，DeepSeek worker 负责单线程完成实现。对适合的代码任务，目标是减少约 40-60% 的 Codex 主线程 token 消耗。

设计原则是：**省 Codex，不省 DeepSeek**。DeepSeek 可以多想、可以多跑一会儿；Codex 不应该在主线程里长时间读日志、反复探索代码、重写同一个补丁。

它不是一个独立的 DeepSeek 客户端。项目内置了一个很小的 `claude-deepseek` 启动器：它会调用本机 Claude Code CLI，并把这次子进程请求切到 DeepSeek 的 Anthropic-compatible endpoint。

```text
MCP 宿主
  -> deepseek-code-worker MCP
  -> claude-deepseek -p
  -> 真实 workspace 文件修改
  -> MCP 返回 diff / policy / checks 结果
```

这个 worker 不是用来提建议的。一次调用只有在真实文件发生变化时才算成功。

## 这个 MCP 做了什么

它不只是“把 Claude Code 指到 DeepSeek”的薄包装。为了让 Codex 真正能把 DeepSeek 当后台代码 worker 使用，这个 MCP 补了运行时能力：

- **异步 worker job**：启动任务后返回 `job_id`，worker 不依赖单次前台工具调用存活。
- **90 秒 heartbeat**：`deepseek_wait_for_job` 只短暂观察；没完成就返回 `running`，避免撞上宿主前台工具调用超时。
- **结构化状态**：`get_job` / `tail_job` 返回 phase、进程存活、idle 时间、最近 stream 事件、已变更文件、stdout/stderr tail、建议轮询时间。
- **DeepSeek 思考时间预期**：文档明确告诉调用方，连续 thinking/quiet 几分钟甚至 Pro 约 10 分钟可以是正常现象。
- **权限护栏**：默认 worker 使用 MCP 生成的 Claude Code `dontAsk` settings，并通过 `PreToolUse` hook 控制危险 Bash、禁用路径和越界写入；`bypassPermissions` 默认禁用。
- **scoped patch 模式**：调用方可以传窄 `allowed_dirs`，让 worker 只能在指定范围内改。
- **快照 diff 和 policy**：MCP 在任务前后做 workspace snapshot，返回 changed files、unified diff、forbidden path、docs-only policy、checks 结果。
- **恢复和清理**：job 状态持久化到系统临时目录；MCP 重启后可以恢复状态；server 关闭时会清理仍在跑的 worker 子进程。
- **setup/doctor 流程**：首次运行可在用户确认后安装 Claude Code，保存 DeepSeek key，并用 `--doctor` 验证环境。
- **跨平台收口**：macOS/Linux 是主要目标；Windows 做了 best-effort 支持，包括临时目录、可执行文件查找和 check shell 的平台适配。

## 快速开始

从 GitHub 安装：

```bash
npm i -g github:louchi1984-coder/deepseek-claude-code-worker-mcp#v0.3.20-beta.14
```

全局交互安装会自动运行 setup。setup 会检查 Claude Code，缺失时询问是否安装；如果没有 DeepSeek key，会提示输入并保存；最后打印 MCP 配置。非交互安装不会卡住 npm，只会打印手动下一步。

不想全局安装时，可以先用 npx 验证 GitHub 包能否拉起：

```bash
npx github:louchi1984-coder/deepseek-claude-code-worker-mcp#v0.3.20-beta.14 --doctor
```

MCP 配置：

```json
{
  "mcpServers": {
    "deepseek-code-worker": {
      "command": "deepseek-code-worker-mcp"
    }
  }
}
```

从源码运行：

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

发布到 npm 后，可以使用更短命令：

```bash
npm i -g deepseek-worker-mcp
```

### 用户不会用终端怎么办

把下面这段直接发给 Codex Desktop，让 Codex 帮用户配置本机：

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

## 依赖

- Node.js 20+
- 平台支持
  - macOS 和 Linux 是主要测试目标
  - Windows 是 best-effort 支持：只要 `node`、`npm`、`claude` / `claude.cmd` 在 `PATH` 中可用就会尝试运行，但还需要更多真实 Windows 机器验证
- Claude Code CLI
  - setup 发现没有 `claude` 时，会询问是否运行 `npm install -g @anthropic-ai/claude-code`
  - 或者使用 `PATH` 里的现有 `claude`
  - 或者把 `CLAUDE_BIN` 设置为 `claude`、`claude.cmd` 或其他 Claude Code 可执行文件的绝对路径
- DeepSeek API key
  - 可以用 `ANTHROPIC_AUTH_TOKEN`
  - 或 `DEEPSEEK_API_KEY_FILE`
  - 或让 setup 保存到 `~/.codex/secrets/deepseek_api_key`

这个 MCP 没有单独的 key。`claude-deepseek` 会把 DeepSeek key 注入到 Claude Code 子进程的 Anthropic-compatible 环境变量里。它不会修改你本机 Claude Code 的全局配置。

`deepseek-code-worker-setup` 会做两件事：

- 检查 Claude Code CLI；如果缺失，在交互终端里询问是否安装
- 如果没有 DeepSeek auth，提示输入 DeepSeek API key，并以用户只读权限保存

MCP JSON-RPC 正常运行时不会弹交互，也不会在协议里询问 key。

安装包里不会内置 DeepSeek key。发布包只包含源码、脚本、README 和 LICENSE。如果 setup 没问你 key，通常是下面几种情况之一：

- 环境变量里已经有 `ANTHROPIC_AUTH_TOKEN`
- `DEEPSEEK_API_KEY_FILE` 指向了已有 key 文件
- `~/.codex/secrets/deepseek_api_key` 已经存在
- npm postinstall 处在非交互环境，只打印下一步，不弹输入

## 给 Codex / 调用方的规则

标准任务优先用异步 worker：

```json
{
  "name": "deepseek_start_implementation",
  "arguments": {
    "cwd": "/absolute/project/path",
    "task": "Make the requested code change."
  }
}
```

然后用非阻塞状态查询：

```json
{
  "name": "deepseek_get_job",
  "arguments": {
    "job_id": "dsw_..."
  }
}
```

推荐分工：

- 目标是省 Codex 主线程 token，不是省 DeepSeek token
- Codex 主线程决定任务边界
- DeepSeek worker 单线程完成一个明确实现任务
- Codex 每隔约 90 秒看一次状态
- worker 还是 `running` 时只观察状态和活动，不审查 diff
- worker 到达 `completed` / `failed` / `cancel_requested` / `orphaned` 后，再审 `file_diffs`、`policy`、`checks_run`

不要因为 DeepSeek 想得久就取消或重启。思考时间预期是“单次连续 thinking/quiet 段”，不是累计 job 总时长：

| 模型 / 用例 | 正常单次 thinking 或 quiet 段 |
| --- | --- |
| `deepseek-v4-flash`, `fast_patch` | 1-3 分钟 |
| `deepseek-v4-flash`, 普通实现 | 3-5 分钟 |
| `deepseek-v4-pro[1m]`, debug/agentic/complex/long-context | 约 10 分钟 |
| `deepseek-v4-pro[1m]`, `docs_generation` | 5-10 分钟 |

`deepseek_wait_for_job` 只是短前台 heartbeat。它不会杀 worker；没完成就返回 `running`，让调用方稍后继续看。

不要把所有任务都交给 worker。它最适合边界清楚的实现任务：Codex 发一次任务，DeepSeek 执行，Codex 最后审紧凑产物。一两行小改动、需求还没想清楚的讨论、高风险架构判断，应该先留在 Codex 主线程里处理。

## 工具

- `deepseek_start_implementation`：启动后台实现任务，返回 `job_id`
- `deepseek_get_job`：读取 job 状态和结构化进度
- `deepseek_tail_job`：读取状态、stdout/stderr 尾部、最近 stream 事件
- `deepseek_wait_for_job`：短窗口观察；完成就返回终态，没完成就返回 `running`
- `deepseek_cancel_job`：请求取消 running job
- `deepseek_implement_in_workspace`：同步执行，只适合很小的快速改动

## 用例预设

| `use_case` | 默认模型 | 适合 |
| --- | --- | --- |
| `auto` | `deepseek-v4-flash` | 普通实现，Flash-first |
| `fast_patch` | `deepseek-v4-flash` | 小而低风险的补丁 |
| `simple_agent_task` | `deepseek-v4-flash` | 简单 agentic coding |
| `scaffold_or_tests` | `deepseek-v4-flash` | 脚手架、胶水代码、测试 |
| `debug_loop` | `deepseek-v4-pro[1m]` | 复现、定位、最小修复、验证 |
| `agentic_coding` | `deepseek-v4-pro[1m]` | 多步骤实现和工具循环 |
| `complex_reasoning` | `deepseek-v4-pro[1m]` | 架构、复杂逻辑、失败分析 |
| `long_context_codebase` | `deepseek-v4-pro[1m]` | 需要大上下文的代码库任务 |
| `docs_generation` | `deepseek-v4-pro[1m]` | 文档生成 |

调用方显式传 `model`、`thinking`、`reasoning_effort` 时，会覆盖预设。

## 权限和安全边界

这个 MCP 不是 OS/container 沙箱。它的边界是：

- 每个 worker 临时生成 Claude Code `dontAsk` settings
- `PreToolUse` hook 阻止危险 Bash、禁用路径、越界写入
- 任务结束后用 workspace snapshot 做最终 policy 检查

默认禁用 `bypassPermissions`。没有真实沙箱前，不建议启用。

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
