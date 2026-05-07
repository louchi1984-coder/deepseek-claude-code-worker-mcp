import {
  classifyClaudeEvent,
  consumeJsonLines,
  phaseFromClaudeEvent,
  summarizeClaudeEvent,
} from "../src/core/stream-events.mjs";

const cases = [
  {
    name: "thinking delta",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "..." } },
    expected: { kind: "thinking_delta", summary: "content_block_delta:thinking_delta", phase: "model_streaming" },
  },
  {
    name: "tool use content block",
    event: { type: "content_block_start", content_block: { type: "tool_use", name: "Read" } },
    expected: { kind: "tool_use", tool_name: "Read", summary: "content_block_start:tool_use:Read", phase: "tool_activity" },
  },
  {
    name: "tool result content block",
    event: { type: "content_block_start", content_block: { type: "tool_result", is_error: true } },
    expected: { kind: "tool_result", is_error: true, summary: "content_block_start:tool_result", phase: "tool_activity" },
  },
  {
    name: "final result",
    event: { type: "result", subtype: "success", is_error: false },
    expected: { kind: "final_result", summary: "result:success", phase: "model_finishing" },
  },
  {
    name: "nested event payload",
    event: { event: { type: "tool_use", name: "Bash" } },
    expected: { kind: "tool_use", tool_name: "Bash", summary: "tool_use:tool_use:Bash", phase: "tool_activity" },
  },
];

const failures = [];
for (const item of cases) {
  const detail = classifyClaudeEvent(item.event);
  const summary = summarizeClaudeEvent(item.event);
  const phase = phaseFromClaudeEvent(item.event);
  for (const [key, expected] of Object.entries(item.expected)) {
    const actual = key === "summary" ? summary : key === "phase" ? phase?.phase : detail[key];
    if (actual !== expected) {
      failures.push({ case: item.name, key, expected, actual });
    }
  }
}

const parsed = [];
const consumed = consumeJsonLines('{"type":"result"}\nnot-json\n{"type":"tool_use","name":"Edit"}\n{"partial"', (event) => {
  parsed.push(event);
});
if (parsed.length !== 2 || consumed.remainder !== '{"partial"') {
  failures.push({
    case: "consumeJsonLines",
    expected: "two parsed events plus partial remainder",
    actual: { parsed: parsed.length, remainder: consumed.remainder },
  });
}

console.log(JSON.stringify({
  cases: cases.length,
  parsed_json_lines: parsed.length,
  failures,
}, null, 2));

if (failures.length > 0) {
  process.exitCode = 1;
}
