import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
  listExternalConductors,
  clearConductorCache,
  advertisedConductors,
  enumerateInProcessConductors,
} from "../conductorAdvertise.mjs";

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

describe("M1: enumeration timeout (adversarial review)", () => {
  const spawned = [];

  afterEach(() => {
    // Belt-and-suspenders: the timeout path should already have killed these,
    // but make sure a bug here doesn't leak a real hung child off the test run.
    for (const child of spawned.splice(0)) {
      if (child.pid != null && child.exitCode === null) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  });

  /** A fake spawnFn that spawns a genuinely-hanging child (never exits on its own). */
  function hangingSpawnFn() {
    // node -e "setInterval(()=>{}, 1<<30)" — deliberately never writes to
    // stdout/exits. child_process.spawn (not spawnSafe) is fine here: this
    // fixture doesn't need the .cmd-shim handling spawnSafe exists for.
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1<<30)"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    spawned.push(child);
    return child;
  }

  it("rejects after the timeout and kills the hung child, instead of hanging the caller forever", async () => {
    await expect(enumerateInProcessConductors(() => {}, 200, hangingSpawnFn)).rejects.toThrow(/timed out/);
    const child = spawned[0];
    expect(child).toBeTruthy();
    // Give killTree a moment to actually land (taskkill/SIGKILL is not synchronous
    // with the promise rejecting) and confirm the process is really gone, not
    // just abandoned — the whole point of the fix is no leaked child.
    await new Promise((r) => setTimeout(r, 500));
    expect(child.exitCode).not.toBeNull();
  }, 10_000);

  it("advertisedConductors falls back to external-only + logs a warning when enumeration rejects (e.g. times out)", async () => {
    clearConductorCache();
    const repo = mkRepo();
    const conductors = path.join(repo, "conductors");
    fs.mkdirSync(path.join(conductors, "thermocline"), { recursive: true });
    fs.writeFileSync(path.join(conductors, "thermocline", "launch.json"), "{}");

    const logs = [];
    // Inject a fake enumerateFn that rejects the way the real one does after
    // a timeout, rather than spawning real vite-node (which resolves its own
    // accordionRepo from THIS repo's bench.config.json regardless of what's
    // passed to advertisedConductors — see vite-node.config.ts's accordionRepo()
    // — so it can't be made to fail via the accordionRepo arg alone). This
    // isolates the assertion to advertisedConductors' own catch-and-continue
    // logic; the timeout-kills-the-child behavior itself is covered above.
    const failingEnumerate = async () => {
      throw new Error("enumerate-conductors: timed out after 200ms — killed the child");
    };
    const result = await advertisedConductors({
      accordionRepo: repo,
      log: (m) => logs.push(m),
      force: true,
      enumerateFn: failingEnumerate,
    });

    expect(result).toEqual(["external:thermocline"]);
    expect(logs.some((m) => m.includes("WARN") && m.includes("enumerate"))).toBe(true);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
