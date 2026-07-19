/*
 * accordion.test.ts — unit tests for host/accordion.ts's plain helpers.
 *
 * accordion.ts also bridges into the checkout's Svelte-rune engine via
 * loadAccordion()'s dynamic imports (see that file's header comment) — those
 * paths need the real vite-node child-process harness (see host.test.ts /
 * remoteConductor.test.ts). isExternalLaunchConductor() does no rune work —
 * it's a plain fs.existsSync check — so it's safe to import and exercise
 * directly under plain vitest, no child process required.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { isExternalLaunchConductor } from "./accordion";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, "..", "..", "test", "fixtures");

describe("isExternalLaunchConductor", () => {
  it("true when conductors/<id>/launch.json exists", () => {
    expect(isExternalLaunchConductor(FIXTURE_DIR, "echo-conductor")).toBe(true);
  });

  it("false when the conductor id has no launch.json", () => {
    expect(isExternalLaunchConductor(FIXTURE_DIR, "does-not-exist")).toBe(false);
  });

  it("false against a repo path that doesn't exist at all", () => {
    expect(isExternalLaunchConductor(path.join(tmpdir(), "bellows-no-such-repo-xyz"), "thermocline")).toBe(false);
  });
});
