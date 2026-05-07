#!/usr/bin/env node
process.argv.push("--setup");
await import("../src/deepseek-worker-mcp.mjs");
