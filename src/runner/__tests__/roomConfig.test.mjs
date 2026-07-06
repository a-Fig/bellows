import { describe, it, expect } from "vitest";
import { slopcodeRoomConfig } from "../roomConfig.mjs";

describe("slopcodeRoomConfig", () => {
  it("undefined -> full bench (no problem_set)", () => {
    expect(slopcodeRoomConfig(undefined)).toEqual({ game_type: "slopcode", auto_archive: true });
  });

  it("null -> full bench (no problem_set)", () => {
    expect(slopcodeRoomConfig(null)).toEqual({ game_type: "slopcode", auto_archive: true });
  });

  it('empty string "" -> full bench (no problem_set)', () => {
    expect(slopcodeRoomConfig("")).toEqual({ game_type: "slopcode", auto_archive: true });
  });

  it('"all" (any case) -> full bench (no problem_set)', () => {
    expect(slopcodeRoomConfig("all")).toEqual({ game_type: "slopcode", auto_archive: true });
    expect(slopcodeRoomConfig("ALL")).toEqual({ game_type: "slopcode", auto_archive: true });
    expect(slopcodeRoomConfig("All")).toEqual({ game_type: "slopcode", auto_archive: true });
    expect(slopcodeRoomConfig("  all  ")).toEqual({ game_type: "slopcode", auto_archive: true });
  });

  const presets = ["easy", "medium", "hard", "easy-1", "easy-l1", "easy-l2", "easy-l3", "easy-l4"];
  for (const key of presets) {
    it(`preset "${key}" (mixed case) -> problem_set canonical lowercase`, () => {
      expect(slopcodeRoomConfig(key)).toEqual({ game_type: "slopcode", auto_archive: true, problem_set: key });
      // mixed case variant
      const mixed = key
        .split("")
        .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
        .join("");
      expect(slopcodeRoomConfig(mixed)).toEqual({ game_type: "slopcode", auto_archive: true, problem_set: key });
    });
  }

  it("a non-preset single string is treated as a single problem name", () => {
    expect(slopcodeRoomConfig("xjq")).toEqual({ game_type: "slopcode", auto_archive: true, problems: ["xjq"] });
  });

  it("an array of strings maps to problems, deduped (exact-match)", () => {
    expect(slopcodeRoomConfig(["xjq", "abc", "xjq"])).toEqual({
      game_type: "slopcode",
      auto_archive: true,
      problems: ["xjq", "abc"],
    });
  });

  it("an array with empty/whitespace-only entries filters them out", () => {
    expect(slopcodeRoomConfig(["xjq", "", "  ", "abc"])).toEqual({
      game_type: "slopcode",
      auto_archive: true,
      problems: ["xjq", "abc"],
    });
  });

  it("throws when the array is empty after cleaning ([] input)", () => {
    expect(() => slopcodeRoomConfig([])).toThrow(/empty/);
  });

  it("throws when the array is empty after cleaning (all blank entries)", () => {
    expect(() => slopcodeRoomConfig(["", "  ", "\t"])).toThrow(/empty/);
  });
});
