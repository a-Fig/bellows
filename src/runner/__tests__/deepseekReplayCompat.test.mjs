import { describe, expect, it, vi } from "vitest";
import deepSeekReplayCompat, {
  MISSING_REASONING_SENTINEL,
  repairDeepSeekToolCallHistory,
} from "../extensions/deepseekReplayCompat.mjs";

describe("repairDeepSeekToolCallHistory", () => {
  it("adds non-empty replay metadata to DeepSeek assistant tool calls that lack it", () => {
    const message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1", type: "function" }],
    };
    const payload = {
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "go" }, message],
    };

    const repaired = repairDeepSeekToolCallHistory(payload);

    expect(repaired).not.toBe(payload);
    expect(repaired.messages[1]).toEqual({
      ...message,
      content: "",
      reasoning_content: MISSING_REASONING_SENTINEL,
    });
    expect(message).not.toHaveProperty("reasoning_content");
  });

  it("preserves valid DeepSeek reasoning_content and object identity", () => {
    const payload = {
      model: "deepseek/deepseek-v4-flash",
      messages: [
        {
          role: "assistant",
          content: null,
          reasoning_content: "original reasoning",
          tool_calls: [{ id: "call-1" }],
        },
      ],
    };

    expect(repairDeepSeekToolCallHistory(payload)).toBe(payload);
  });

  it("does not alter another provider's payload", () => {
    const payload = {
      model: "openai/gpt-5",
      messages: [{ role: "assistant", tool_calls: [{ id: "call-1" }] }],
    };

    expect(repairDeepSeekToolCallHistory(payload)).toBe(payload);
  });

  it("registers the repair on before_provider_request", () => {
    const on = vi.fn();
    deepSeekReplayCompat({ on });

    expect(on).toHaveBeenCalledOnce();
    expect(on.mock.calls[0][0]).toBe("before_provider_request");
    const handler = on.mock.calls[0][1];
    const payload = {
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "assistant", tool_calls: [{ id: "call-1" }] }],
    };
    expect(handler({ payload }).messages[0].reasoning_content).toBe(MISSING_REASONING_SENTINEL);
  });
});
