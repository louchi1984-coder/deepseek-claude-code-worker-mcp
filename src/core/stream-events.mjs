export function consumeJsonLines(buffer, onEvent) {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      onEvent(JSON.parse(line));
    } catch {
      // Claude may write non-JSON diagnostics despite stream-json; keep raw logs as fallback.
    }
  }
  return { remainder };
}

export function compactClaudeEvent(event, summary) {
  const detail = classifyClaudeEvent(event);
  return {
    at: new Date().toISOString(),
    type: detail.type,
    subtype: detail.subtype,
    kind: detail.kind,
    tool_name: detail.tool_name,
    summary,
  };
}

export function summarizeClaudeEvent(event) {
  const detail = classifyClaudeEvent(event);
  const type = detail.type ?? "unknown";
  const subtype = detail.subtype ?? null;
  const toolName = detail.tool_name ?? null;
  if (toolName) return `${type}:${subtype ?? "event"}:${toolName}`;
  return subtype ? `${type}:${subtype}` : String(type);
}

export function phaseFromClaudeEvent(event) {
  const detail = classifyClaudeEvent(event);
  const type = detail.type;
  const subtype = detail.subtype;
  const summary = summarizeClaudeEvent(event);
  if (detail.kind === "tool_use" || detail.kind === "tool_result" || String(type).includes("tool") || String(subtype).includes("tool")) {
    return { phase: "tool_activity", message: `Claude Code stream event: ${summary}` };
  }
  if (detail.kind === "thinking_delta" || type === "assistant" || type === "content_block_delta" || type === "message_delta") {
    return { phase: "model_streaming", message: `Claude Code is streaming events: ${summary}` };
  }
  if (type === "result" || type === "message_stop") {
    return { phase: "model_finishing", message: `Claude Code emitted final stream event: ${summary}` };
  }
  return null;
}

export function classifyClaudeEvent(event) {
  const payload = claudeEventPayload(event) ?? {};
  const delta = payload.delta ?? payload.message?.delta ?? null;
  const contentBlock = payload.content_block ?? payload.message?.content_block ?? null;
  const result = payload.result ?? payload.message?.result ?? null;
  const type = payload.type ?? event?.type ?? "unknown";
  const subtype = payload.subtype
    ?? payload.message?.type
    ?? delta?.type
    ?? contentBlock?.type
    ?? result?.type
    ?? null;
  const toolName = payload.name
    ?? payload.tool_name
    ?? payload.message?.name
    ?? contentBlock?.name
    ?? result?.name
    ?? null;

  if (delta?.type === "thinking_delta") {
    return { type, subtype: "thinking_delta", kind: "thinking_delta", tool_name: null };
  }
  if (contentBlock?.type === "tool_use" || subtype === "tool_use" || type === "tool_use") {
    return { type, subtype: "tool_use", kind: "tool_use", tool_name: toolName };
  }
  if (contentBlock?.type === "tool_result" || subtype === "tool_result" || type === "tool_result") {
    return {
      type,
      subtype: "tool_result",
      kind: "tool_result",
      tool_name: toolName,
      is_error: Boolean(contentBlock?.is_error ?? payload.is_error ?? result?.is_error),
    };
  }
  if (type === "result") {
    return { type, subtype: payload.subtype ?? null, kind: payload.is_error ? "error_result" : "final_result", tool_name: null };
  }
  return { type, subtype, kind: subtype ?? type, tool_name: toolName };
}

function claudeEventPayload(event) {
  return event?.event && typeof event.event === "object" ? event.event : event;
}
