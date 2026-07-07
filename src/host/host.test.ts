/*
 * host.test.ts — end-to-end smoke for the headless conductor host.
 *
 * The test spawns the REAL host (`npx vite-node ... src/host/main.ts`) as a child process,
 * pointed at a MockExtension standing in for the pi extension's WS server. It proves:
 *
 *   1. discovery + attach — the host finds the session descriptor, dials, greets, attaches;
 *   2. folding — driven with a batch of blocks far over budget, the built-in conductor's
 *      plan (sent back over the wire) carries fold ops; telemetry JSONL is written & valid;
 *   3. cadence (the crux) — with a synchronously-SLOW conduct() (1 s), the FIRST sync reply
 *      is the empty/last plan within the window, and the computed folds land on a LATER sync.
 *
 * This test itself imports only pure `ws` + node — no rune modules — so it runs under a
 * plain `vitest run` (node env). Only the CHILD compiles the accordion engine via vite-node.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockExtension, makeBlocks } from "./mock-extension.mjs";

const HOST_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.resolve(HOST_DIR, "../..");
const CONFIG = path.join(REPO_ROOT, "vite-node.config.ts");
const MAIN = path.join(HOST_DIR, "main.ts");

interface Spawned {
	child: ChildProcess;
	telemetryOut: string;
	exit: Promise<number>;
}

const children: ChildProcess[] = [];

function spawnHost(opts: {
	accordionHome: string;
	conductor: string;
	budget: number;
	protect: number;
	telemetryOut: string;
	slowConductMs?: number;
}): Spawned {
	const env = { ...process.env };
	if (opts.slowConductMs) env.BELLOWS_TEST_SLOW_CONDUCT_MS = String(opts.slowConductMs);
	const child = spawn(
		process.execPath,
		[
			path.join(REPO_ROOT, "node_modules", "vite-node", "vite-node.mjs"),
			"--config",
			CONFIG,
			MAIN,
			"--",
			"--accordion-home",
			opts.accordionHome,
			"--conductor",
			opts.conductor,
			"--budget",
			String(opts.budget),
			"--protect",
			String(opts.protect),
			"--telemetry-out",
			opts.telemetryOut,
			"--timeout-min",
			"1",
		],
		{ cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	children.push(child);
	child.stderr?.on("data", (d) => process.stderr.write(`[host] ${d}`));
	const exit = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
	return { child, telemetryOut: opts.telemetryOut, exit };
}

function readTelemetry(file: string): any[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

async function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`timed out waiting for ${label}`);
}

afterEach(async () => {
	for (const c of children.splice(0)) {
		try {
			c.kill("SIGKILL");
		} catch {
			/* ignore */
		}
	}
});

describe("headless conductor host", () => {
	it("attaches, folds an over-budget context with the built-in conductor, and writes valid telemetry", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-host-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home }).start();

		// Budget 30k; the batch below is ~150 blocks * ~170 tok avg ≈ 76k → folding forced.
		const spawned = spawnHost({ accordionHome: home, conductor: "builtin", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			// Wait for the host to connect (mock sees a client), then push the big sync.
			await waitFor(() => mock.client !== null, 60_000, "host WS connect");
			const blocks = makeBlocks(150); // 450 blocks (user+text+result per iter)
			const reqId = mock.sync(blocks, { full: true });
			const plan = await mock.waitForPlan(reqId, 8000);

			// The first sync's reply is the LAST plan (empty — the host had not conducted yet).
			expect(plan.ops.length + plan.groups.length).toBe(0);

			// Drive a SECOND sync (no new blocks); by now the deferred conduct has folded.
			// Retry a few syncs to let the (fast, synchronous) built-in conduct settle.
			let folded = null as null | { ops: any[]; groups: any[] };
			for (let i = 0; i < 10 && !folded; i++) {
				const r = mock.sync([], { full: false });
				const p = await mock.waitForPlan(r, 8000);
				if (p.ops.length + p.groups.length > 0) folded = p;
				else await new Promise((res) => setTimeout(res, 150));
			}
			expect(folded, "a later sync must carry the conductor's fold ops").not.toBeNull();
			expect(folded!.ops.length).toBeGreaterThan(0);
			// Every fold op targets a durable, foldable id (text a: / result r:), never user u:.
			for (const op of folded!.ops) {
				expect(op.id.startsWith("a:") || op.id.startsWith("r:")).toBe(true);
				expect(typeof op.digestText).toBe("string");
				expect(op.digestText.length).toBeGreaterThan(0);
			}

			// Telemetry: attach + sync + conduct + plan events, all well-formed JSON lines.
			await waitFor(() => readTelemetry(telemetryOut).some((e) => e.t === "conduct" && e.commands > 0), 5000, "conduct telemetry with folds");
			const tel = readTelemetry(telemetryOut);
			const attach = tel.find((e) => e.t === "attach");
			expect(attach).toBeTruthy();
			expect(attach.conductor).toBe("builtin");
			expect(attach.budget).toBe(30_000);
			expect(tel.some((e) => e.t === "sync" && e.blocks > 0)).toBe(true);
			expect(tel.some((e) => e.t === "plan")).toBe(true);
			const conductWithFolds = tel.find((e) => e.t === "conduct" && e.commands > 0);
			expect(conductWithFolds).toBeTruthy();

			// The host exits 0 when the session (WS) closes.
			await mock.close();
			const code = await spawned.exit;
			expect(code).toBe(0);
			// A detach event with a clean reason is recorded.
			const finalTel = readTelemetry(telemetryOut);
			expect(finalTel.some((e) => e.t === "detach")).toBe(true);
		} finally {
			await mock.close().catch(() => {});
		}
	}, 90_000);

	it("honors the plan-reply window with a slow (1s) conduct: first reply is empty, folds land on a later sync", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-slow-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home }).start();

		const spawned = spawnHost({
			accordionHome: home,
			conductor: "builtin",
			budget: 30_000,
			protect: 5_000,
			telemetryOut,
			slowConductMs: 1000,
		});

		try {
			await waitFor(() => mock.client !== null, 60_000, "host WS connect");
			// Wait until the host has ATTACHED. attach() runs one synchronous conduct() which,
			// under the slow wrapper, busy-blocks the event loop for ~1s — that is a one-time
			// startup cost, NOT the per-sync reply path we are measuring. Wait for the attach
			// telemetry line plus a settle margin so the initial conduct has fully drained
			// before we time the first sync's reply.
			await waitFor(() => readTelemetry(telemetryOut).some((e) => e.t === "attach"), 60_000, "host attach");
			await new Promise((res) => setTimeout(res, 1300)); // let the one-time attach conduct finish
			const blocks = makeBlocks(150);

			// First sync: the reply MUST arrive fast (within the 250ms window) and be empty,
			// because the slow conduct has not produced a plan yet. Measure round-trip.
			const t0 = Date.now();
			const reqId = mock.sync(blocks, { full: true });
			const firstPlan = await mock.waitForPlan(reqId, 4000);
			const rtt = firstPlan.at - t0;
			expect(firstPlan.ops.length + firstPlan.groups.length).toBe(0);
			// The reply must NOT have waited on the 1s conduct. Generous ceiling (child IPC +
			// WS jitter) but far under the 1s a blocking conduct would have cost.
			expect(rtt).toBeLessThan(700);

			// After the slow conduct completes (>1s), a subsequent sync must carry the folds.
			await new Promise((res) => setTimeout(res, 1500));
			let folded = null as null | { ops: any[] };
			for (let i = 0; i < 8 && !folded; i++) {
				const r = mock.sync([], { full: false });
				const p = await mock.waitForPlan(r, 4000);
				if (p.ops.length > 0) folded = p;
				else await new Promise((res) => setTimeout(res, 300));
			}
			expect(folded, "folds computed by the slow conductor must appear on a later sync").not.toBeNull();
			expect(folded!.ops.length).toBeGreaterThan(0);

			// Telemetry records at least one conduct whose latency reflects the 1s stall.
			const tel = readTelemetry(telemetryOut);
			const slowConduct = tel.find((e) => e.t === "conduct" && e.latencyMs >= 900);
			expect(slowConduct, "a conduct latency ≥ ~1s must be recorded").toBeTruthy();

			await mock.close();
			await spawned.exit;
		} finally {
			await mock.close().catch(() => {});
		}
	}, 90_000);

	it("issue #14: exits 1 with a single error telemetry line and zero attach/sync when the conductor id is unknown", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-host-badconductor-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");

		// The unknown-conductor check runs before the host even looks for a pi session
		// descriptor, so no MockExtension/WS server is needed here — the host should fail
		// fast on its own.
		const spawned = spawnHost({
			accordionHome: home,
			conductor: "does-not-exist-zzz",
			budget: 30_000,
			protect: 5_000,
			telemetryOut,
		});

		const code = await spawned.exit;
		expect(code).toBe(1);

		const tel = readTelemetry(telemetryOut);
		const errorLines = tel.filter((e) => e.t === "error");
		expect(errorLines.length).toBe(1);
		expect(String(errorLines[0].message)).toMatch(/unknown conductor/);
		expect(tel.some((e) => e.t === "attach")).toBe(false);
		expect(tel.some((e) => e.t === "sync")).toBe(false);
	}, 30_000);
});
