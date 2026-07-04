import { describe, it, expect } from "vitest";
import { pickFoldTarget, planFor } from "./conductors/echo-conductor/echo-conductor.mjs";

function block(o) {
	return {
		id: o.id,
		kind: o.kind ?? "tool_result",
		tokens: o.tokens ?? 100,
		protected: o.protected ?? false,
		held: o.held ?? false,
		folded: o.folded ?? false,
		grouped: o.grouped ?? false,
	};
}

describe("echo-conductor fixture — pure policy", () => {
	it("picks the largest non-protected, non-held tool_result", () => {
		const blocks = [
			block({ id: "a", tokens: 100 }),
			block({ id: "b", tokens: 500 }),
			block({ id: "c", tokens: 300 }),
		];
		expect(pickFoldTarget(blocks)?.id).toBe("b");
	});

	it("ignores protected, held, already-folded, and grouped blocks", () => {
		const blocks = [
			block({ id: "big-protected", tokens: 900, protected: true }),
			block({ id: "big-held", tokens: 800, held: true }),
			block({ id: "big-folded", tokens: 700, folded: true }),
			block({ id: "big-grouped", tokens: 600, grouped: true }),
			block({ id: "eligible", tokens: 200 }),
		];
		expect(pickFoldTarget(blocks)?.id).toBe("eligible");
	});

	it("ignores non-tool_result blocks even if larger", () => {
		const blocks = [block({ id: "text", kind: "text", tokens: 999 }), block({ id: "result", tokens: 50 })];
		expect(pickFoldTarget(blocks)?.id).toBe("result");
	});

	it("returns null when nothing qualifies", () => {
		const blocks = [block({ id: "a", protected: true }), block({ id: "b", held: true })];
		expect(pickFoldTarget(blocks)).toBeNull();
	});

	it("planFor emits a single fold command for the target, or [] when none", () => {
		const blocks = [block({ id: "x", tokens: 400 })];
		expect(planFor({ blocks })).toEqual([{ kind: "fold", ids: ["x"] }]);
		expect(planFor({ blocks: [] })).toEqual([]);
	});
});
