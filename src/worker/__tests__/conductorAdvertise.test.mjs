import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { listExternalConductors, clearConductorCache } from "../conductorAdvertise.mjs";

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "bellows-conductors-"));
  return dir;
}

describe("listExternalConductors", () => {
  it("finds only directories with a launch.json", () => {
    const repo = mkRepo();
    const conductors = path.join(repo, "conductors");
    fs.mkdirSync(path.join(conductors, "alpha"), { recursive: true });
    fs.mkdirSync(path.join(conductors, "beta"), { recursive: true });
    fs.mkdirSync(path.join(conductors, "no-launch"), { recursive: true });
    fs.writeFileSync(path.join(conductors, "alpha", "launch.json"), "{}");
    fs.writeFileSync(path.join(conductors, "beta", "launch.json"), "{}");

    const ids = listExternalConductors(repo);
    expect(ids).toEqual(["alpha", "beta"]);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("returns an empty list (not a throw) when the conductors dir is missing", () => {
    const repo = mkRepo(); // no conductors/ subdir created
    const logs = [];
    const ids = listExternalConductors(repo, (m) => logs.push(m));
    expect(ids).toEqual([]);
    expect(logs.length).toBeGreaterThan(0);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe("clearConductorCache", () => {
  it("is safe to call with no prior population", () => {
    expect(() => clearConductorCache()).not.toThrow();
  });
});
