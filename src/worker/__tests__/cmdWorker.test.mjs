/**
 * m4 (adversarial review): `bellows worker` (bin/bellows.mjs cmdWorker) must
 * resolve its platform API key from `config.platformApiKeyEnv` — exactly like
 * `bellows run`'s cmdRun — rather than a hardcoded `AGENT_TRIALS_API_KEY`. PM
 * decision: unify on config.platformApiKeyEnv (same key/account that creates
 * rooms, matching the intended deployment).
 *
 * bin/bellows.mjs's cmdWorker has no exports (a function that calls
 * `process.exit` on every branch) and REPO_ROOT (src/runner/config.mjs) is
 * fixed to this repo's own root rather than being cwd-relative, so the only
 * way to exercise the real shipped cmdWorker code path is a subprocess spawn
 * of the actual CLI against a temporary bench.config.json at the repo root
 * (backed up/restored so this never clobbers a real local config or leaves
 * one behind — bench.config.json is gitignored precisely because it's
 * machine-local).
 *
 * Also covers M3's second-SIGINT force-exit: the handler lives in
 * ../shutdownSignal.mjs as a pure factory specifically so it's directly unit
 * testable — sending SIGINT to a child process on win32 unconditionally
 * terminates it (Node docs), so "spawn a worker, send SIGINT twice, assert
 * force-exit" is not a reliable subprocess test on this platform. (It's kept
 * out of bin/bellows.mjs itself, rather than exported from there, because that
 * file carries a `#!/usr/bin/env node` shebang — importing a shebang'd file
 * as a non-entrypoint dependency breaks vitest's esbuild-based transform with
 * a SyntaxError at the shebang line.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeShutdownSignalHandler } from "../shutdownSignal.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CONFIG_PATH = path.join(REPO_ROOT, "bench.config.json");
const BIN_PATH = path.join(REPO_ROOT, "bin", "bellows.mjs");

let backup = null;

beforeEach(() => {
  backup = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, "utf8") : null;
});

afterEach(() => {
  if (backup === null) {
    fs.rmSync(CONFIG_PATH, { force: true });
  } else {
    fs.writeFileSync(CONFIG_PATH, backup);
  }
});

function writeConfig(worker) {
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        accordionRepo: REPO_ROOT, // never touched: pullBeforeClaim is false and claim fails before any accordion access
        platformBase: "http://127.0.0.1:1", // unroutable; irrelevant, we assert before any network call
        platformApiKeyEnv: "BELLOWS_TEST_CUSTOM_KEY_VAR",
        runsDir: "./runs",
        worker,
      },
      null,
      2,
    ),
  );
}

describe("bellows worker: platform API key resolution (m4)", () => {
  it("reads the key from config.platformApiKeyEnv, not a hardcoded AGENT_TRIALS_API_KEY", () => {
    writeConfig({ platformUrl: "http://127.0.0.1:1", name: "test-worker", caps: [] });

    // Set the CUSTOM var the config points at, and deliberately leave the
    // hardcoded legacy name unset — proves the worker isn't just falling back
    // to AGENT_TRIALS_API_KEY.
    const env = { ...process.env, BELLOWS_TEST_CUSTOM_KEY_VAR: "at_test_custom_key", AGENT_TRIALS_API_KEY: "" };
    delete env.AGENT_TRIALS_API_KEY;

    const result = spawnSync(process.execPath, [BIN_PATH, "worker", "--once"], {
      cwd: REPO_ROOT,
      env,
      timeout: 15_000,
      encoding: "utf8",
    });

    // It must NOT hit the "api key env var ... is not set" startup guard —
    // that would mean it never even looked at platformApiKeyEnv correctly.
    expect(result.stderr).not.toMatch(/is not set/);
    // It should get as far as the polling banner (proving the key resolved)
    // before failing on the unroutable platformUrl during claim().
    expect(result.stderr).toMatch(/\[worker\].*polling/);
  });

  it("errors out naming config.platformApiKeyEnv (not AGENT_TRIALS_API_KEY) when the configured var is unset", () => {
    writeConfig({ platformUrl: "http://127.0.0.1:1", name: "test-worker", caps: [] });

    const env = { ...process.env };
    delete env.BELLOWS_TEST_CUSTOM_KEY_VAR;
    delete env.AGENT_TRIALS_API_KEY;

    const result = spawnSync(process.execPath, [BIN_PATH, "worker", "--once"], {
      cwd: REPO_ROOT,
      env,
      timeout: 15_000,
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/BELLOWS_TEST_CUSTOM_KEY_VAR is not set/);
  });
});

describe("makeShutdownSignalHandler (M3, adversarial review)", () => {
  it("a first signal aborts the controller and does NOT force-exit", () => {
    const abortController = new AbortController();
    const logs = [];
    const exit = vi.fn();
    const onSignal = makeShutdownSignalHandler({ abortController, log: (m) => logs.push(m), exit });

    onSignal("SIGINT");

    expect(abortController.signal.aborted).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(logs.some((m) => m.includes("SIGINT") && m.includes("finishing"))).toBe(true);
  });

  it("a second signal force-exits with code 130, without re-aborting an already-aborted controller", () => {
    const abortController = new AbortController();
    const logs = [];
    const exit = vi.fn();
    const onSignal = makeShutdownSignalHandler({ abortController, log: (m) => logs.push(m), exit });

    onSignal("SIGINT");
    expect(exit).not.toHaveBeenCalled();

    onSignal("SIGINT");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
    expect(logs.some((m) => m.includes("again") && m.includes("forcing"))).toBe(true);
  });

  it("a second SIGTERM after a first SIGINT also force-exits (any second signal, not just a repeat of the same one)", () => {
    const abortController = new AbortController();
    const exit = vi.fn();
    const onSignal = makeShutdownSignalHandler({ abortController, log: () => {}, exit });

    onSignal("SIGINT");
    onSignal("SIGTERM");

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });
});
