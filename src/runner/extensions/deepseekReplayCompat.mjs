/**
 * Repair a DeepSeek thinking-history edge at the final provider payload layer.
 *
 * DeepSeek requires every replayed assistant tool-call message to carry a
 * non-empty reasoning_content value. Occasionally the provider itself emits a
 * direct tool call without one; the next request then rejects that history.
 * Keep the repair provider-specific and leave already-valid replay data intact.
 *
 * The sentinel is a single space, not a natural-language phrase. An earlier
 * version used "[reasoning unavailable from provider]"; that string entered
 * model-visible replay history and the model degenerated into echoing it back
 * as its entire terminal response (thinking-only, no text, no tool call) —
 * see reports/2026-07-18-devmain-xjq-premature-stop-investigation.md. A
 * single space satisfies DeepSeek's non-empty presence validation without
 * giving the model a semantic string to latch onto. (pi core injects `""` for
 * this same compat case, but empty-string validation via the TokenRouter
 * gateway is unverified, so stay non-empty.)
 */
export const MISSING_REASONING_SENTINEL = " ";

/**
 * @param {unknown} payload
 * @returns {unknown}
 */
export function repairDeepSeekToolCallHistory(payload) {
  if (!isRecord(payload) || !isDeepSeekModel(payload.model) || !Array.isArray(payload.messages)) {
    return payload;
  }

  let changed = false;
  const messages = payload.messages.map((message) => {
    if (!needsRepair(message)) return message;

    changed = true;
    return {
      ...message,
      content: message.content ?? "",
      reasoning_content: MISSING_REASONING_SENTINEL,
    };
  });

  return changed ? { ...payload, messages } : payload;
}

/** Pi extension entrypoint. */
export default function deepSeekReplayCompat(pi) {
  pi.on("before_provider_request", (event) => repairDeepSeekToolCallHistory(event.payload));
}

function isDeepSeekModel(model) {
  return typeof model === "string" && /deepseek/i.test(model);
}

function needsRepair(message) {
  return (
    isRecord(message) &&
    message.role === "assistant" &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0 &&
    (typeof message.reasoning_content !== "string" || message.reasoning_content.length === 0)
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
