# DeepSeek Code Worker MCP

语言：[English](README.md) | [简体中文](README.zh-CN.md)

这是一个纯执行型 MCP server，用来让 Codex、Claude Desktop 或其他 MCP 宿主把真实代码修改任务交给 DeepSeek V4 worker 执行。

它不是一个独立的 DeepSeek 客户端。项目内置了一个很小的 `claude-deepseek` 启动器：它会调用本机 Claude Code CLI，并把这次子进程请求切到 DeepSeek 的 Anthropic-compatible endpoint。

```text
MCP 宿主
  -> deepseek-code-worker MCP
  -> claude-deepseek -p
  -> 真实 workspace 文件修改
  -> MCP 返回 diff / policy / checks 结果
```

这个 worker 不是用来提建议的。一次调用只有在真实文件发生变化时才算成功。

## 快速开始

从 GitHub 直接安装：

```bash
npm install -g github:louchi1984-coder/deepseek-claude-code-worker-mcp#v0.3.20-beta.4
deepseek-code-worker-setup
deepseek-code-worker-mcp --doctor
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

发布到 npm 后，可以改用：

```bash
npm install -g deepseek-claude-code-worker-mcp
```

## 依赖

- Node.js 20+
- 平台支持
  - macOS 和 Linux 是主要测试目标
  - Windows 是 best-effort 支持：只要 `claude` / `claude.cmd` 在 `PATH` 中可用就会尝试运行，但还需要更多真实 Windows 机器验证
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
