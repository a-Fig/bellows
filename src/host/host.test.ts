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
const TEST_ACCORDION_REPO = process.env.BELLOWS_ACCORDION_REPO?.trim()
	|| JSON.parse(readFileSync(path.join(REPO_ROOT, "bench.config.example.json"), "utf8")).accordionRepo;

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
	armedAckTimeoutMs?: number;
	metaRefreshMs?: number;
}): Spawned {
	const env = { ...process.env };
	env.BELLOWS_ACCORDION_REPO = TEST_ACCORDION_REPO;
	if (opts.slowConductMs) env.BELLOWS_TEST_SLOW_CONDUCT_MS = String(opts.slowConductMs);
	if (opts.armedAckTimeoutMs) env.BELLOWS_ARMED_ACK_TIMEOUT_MS = String(opts.armedAckTimeoutMs);
	if (opts.metaRefreshMs) env.BELLOWS_META_REFRESH_MS = String(opts.metaRefreshMs);
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

			// The host declares itself armed right after hello, and the mock's ack round-trip
			// completes without the watchdog ever firing.
			await waitFor(() => mock.armedMessages.length > 0, 5000, "armed message from host");
			expect(mock.armedMessages[0].armed).toBe(true);
			// Ordering: the host can only have sent `armed` in reaction to `hello`, so per the
			// mock's own recorded sequence the armed frame must not be timestamped before the
			// mock sent hello.
			expect(mock.helloSentAt).not.toBeNull();
			expect(mock.armedMessages[0].at).toBeGreaterThanOrEqual(mock.helloSentAt);

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
			// The mock acked promptly, so the watchdog never fired.
			expect(tel.some((e) => e.t === "armed_unacked")).toBe(false);

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

	it("degrades loudly (does not crash) when the extension never acks armed", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-host-noack-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		// swallowArmed: true simulates an old extension that predates armed-over-wire —
		// it never replies with armedAck.
		const mock = await new MockExtension({ accordionHome: home, swallowArmed: true }).start();

		// Shrink the watchdog well below its 5s production default so the test stays fast.
		const spawned = spawnHost({
			accordionHome: home,
			conductor: "builtin",
			budget: 30_000,
			protect: 5_000,
			telemetryOut,
			armedAckTimeoutMs: 300,
		});

		try {
			await waitFor(() => mock.client !== null, 60_000, "host WS connect");
			await waitFor(() => mock.armedMessages.length > 0, 5000, "armed message from host");

			// The watchdog fires: a loud telemetry line, but the host stays alive and attached
			// (this is a degrade-loudly path, never a fatal one).
			await waitFor(
				() => readTelemetry(telemetryOut).some((e) => e.t === "armed_unacked"),
				5000,
				"armed_unacked telemetry",
			);
			const tel = readTelemetry(telemetryOut);
			const unacked = tel.find((e) => e.t === "armed_unacked");
			expect(unacked).toBeTruthy();
			expect(String(unacked.message)).toMatch(/did not acknowledge armed/);
			expect(tel.some((e) => e.t === "attach")).toBe(true);

			await mock.close();
			const code = await spawned.exit;
			expect(code).toBe(0);
		} finally {
			await mock.close().catch(() => {});
		}
	}, 30_000);

	it("issue #22: accepts hello v7, folds a passthrough ack into telemetry, and snapshots /__accordion/meta", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-host-passthrough-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home, protocolVersion: 7 }).start();
		// Give the "start" meta snapshot something non-zero to diff against later.
		mock.setMetaPlanOutcomes({ applied: 3, "empty-plan": 1, total: 4 });

		const spawned = spawnHost({ accordionHome: home, conductor: "builtin", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			await waitFor(() => mock.client !== null, 60_000, "host WS connect");
			await waitFor(() => readTelemetry(telemetryOut).some((e) => e.t === "attach"), 5000, "attach telemetry");

			// The host's "start" meta snapshot fetch is fire-and-forget right after attach —
			// wait for it to land, and it must carry the mock's served counters verbatim.
			await waitFor(
				() => readTelemetry(telemetryOut).some((e) => e.t === "meta_snapshot" && e.when === "start"),
				5000,
				"start meta_snapshot telemetry",
			);
			const startSnap = readTelemetry(telemetryOut).find((e) => e.t === "meta_snapshot" && e.when === "start");
			expect(startSnap.planOutcomes).toMatchObject({ applied: 3, "empty-plan": 1, total: 4 });

			// A v7 extension can additionally send a `passthrough` ack — the host must fold it
			// into telemetry even though this host still speaks v5 wire shapes otherwise.
			mock.sendPassthrough({ reqId: 42, cause: "timeout-stale", ops: 3, groups: 1, recalls: 0 });
			await waitFor(() => readTelemetry(telemetryOut).some((e) => e.t === "passthrough"), 5000, "passthrough telemetry");
			const tel = readTelemetry(telemetryOut);
			const pt = tel.find((e) => e.t === "passthrough");
			expect(pt).toMatchObject({ reqId: 42, cause: "timeout-stale", ops: 3, groups: 1, recalls: 0 });

			// Advance the mock's lifetime counters (simulating more context hooks resolving
			// during this run), then end the WS session WITHOUT tearing down the mock's HTTP
			// server (see `endSession`) — the host's post-loop shutdown path (session-closed,
			// not SIGTERM) fires its "end" meta fetch here, and the mock must still be able to
			// serve `/__accordion/meta` for it to land with real data. `total` is always
			// derived from the 7 cause keys (see MockExtension._metaTotal). NB: on Windows,
			// `child.kill("SIGTERM")` does not deliver a catchable signal (verified: it hard-
			// kills via TerminateProcess, same as SIGKILL) — the WS-close path is what this
			// host actually reaches on this platform's `bellows worker` teardown too.
			mock.bumpMetaCause("timeout-stale", 1);
			await mock.endSession();

			await waitFor(
				() => readTelemetry(telemetryOut).some((e) => e.t === "meta_snapshot" && e.when === "end"),
				5000,
				"end meta_snapshot telemetry",
			);
			const endSnap = readTelemetry(telemetryOut).find((e) => e.t === "meta_snapshot" && e.when === "end");
			expect(endSnap.planOutcomes).toMatchObject({ applied: 3, "empty-plan": 1, "timeout-stale": 1, total: 5 });

			const code = await spawned.exit;
			expect(code).toBe(0);
		} finally {
			await mock.close().catch(() => {});
		}
	}, 30_000);

	it("Accordion PR #68: accepts hello v8 (wire-identical to v7) and attaches normally", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-host-v8-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home, protocolVersion: 8 }).start();

		const spawned = spawnHost({ accordionHome: home, conductor: "builtin", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			await waitFor(() => mock.client !== null, 60_000, "host WS connect");
			await waitFor(() => readTelemetry(telemetryOut).some((e) => e.t === "attach"), 5000, "attach telemetry");

			// A v8 extension can still send a `passthrough` ack — v8 is wire-identical to v7,
			// it only makes that ack mandatory on the Accordion side, so the host must fold it
			// into telemetry exactly as it does for v7.
			mock.sendPassthrough({ reqId: 7, cause: "applied", ops: 1, groups: 0, recalls: 0 });
			await waitFor(() => readTelemetry(telemetryOut).some((e) => e.t === "passthrough"), 5000, "passthrough telemetry");
			const tel = readTelemetry(telemetryOut);
			const pt = tel.find((e) => e.t === "passthrough");
			expect(pt).toMatchObject({ reqId: 7, cause: "applied", ops: 1, groups: 0, recalls: 0 });
			expect(tel.some((e) => e.t === "error" && /protocol mismatch/.test(String(e.message)))).toBe(false);

			await mock.close();
			const code = await spawned.exit;
			expect(code).toBe(0);
		} finally {
			await mock.close().catch(() => {});
		}
	}, 30_000);

	it("Accordion PR #81: accepts hello v9 and normalizes its removed passthrough recalls field", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-host-v9-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home, protocolVersion: 9 }).start();

		const spawned = spawnHost({ accordionHome: home, conductor: "builtin", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			await waitFor(() => mock.client !== null, 60_000, "host WS connect");
			await waitFor(() => readTelemetry(telemetryOut).some((e) => e.t === "attach"), 5000, "attach telemetry");

			// Protocol v9 removed `PassthroughMessage.recalls`. The mock omits it on the wire;
			// Bellows keeps its historical telemetry schema stable by normalizing it to zero.
			const sent = mock.sendPassthrough({ reqId: 9, cause: "applied", ops: 2, groups: 1 });
			expect("recalls" in sent).toBe(false);
			await waitFor(() => readTelemetry(telemetryOut).some((e) => e.t === "passthrough"), 5000, "passthrough telemetry");
			const tel = readTelemetry(telemetryOut);
			expect(tel.find((e) => e.t === "passthrough")).toMatchObject({
				reqId: 9,
				cause: "applied",
				ops: 2,
				groups: 1,
				recalls: 0,
			});
			expect(tel.some((e) => e.t === "error" && /protocol mismatch/.test(String(e.message)))).toBe(false);

			await mock.close();
			const code = await spawned.exit;
			expect(code).toBe(0);
		} finally {
			await mock.close().catch(() => {});
		}
	}, 30_000);

	it("issue #22: rejects hello v10 fatally with a clear supported-versions error", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-host-v10-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home, protocolVersion: 10 }).start();

		const spawned = spawnHost({ accordionHome: home, conductor: "builtin", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			const code = await spawned.exit;
			expect(code).toBe(1);

			const tel = readTelemetry(telemetryOut);
			const errorLine = tel.find((e) => e.t === "error" && /protocol mismatch/.test(String(e.message)));
			expect(errorLine, "a protocol-mismatch error must be recorded").toBeTruthy();
			expect(String(errorLine.message)).toMatch(/extension v10/);
			expect(String(errorLine.message)).toMatch(/host supports v5, 6, 7, 8, 9/);
			expect(tel.some((e) => e.t === "attach")).toBe(false);
		} finally {
			await mock.close().catch(() => {});
		}
	}, 30_000);

	it("issue #22: ignores an unknown passthrough cause (no telemetry event created)", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-host-badcause-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home }).start();

		const spawned = spawnHost({ accordionHome: home, conductor: "builtin", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			await waitFor(() => mock.client !== null, 60_000, "host WS connect");
			await waitFor(() => readTelemetry(telemetryOut).some((e) => e.t === "attach"), 5000, "attach telemetry");

			mock.sendPassthrough({ reqId: 7, cause: "bogus-cause-zzz", ops: 1, groups: 0, recalls: 0 });
			// Also exercise the two silent, no-reachable-client causes — the extension never
			// sends these as a wire ack per ADR 0020, but a malformed/future peer might; they
			// must be dropped exactly like a nonsense cause (only the 5 ackable causes count).
			mock.sendPassthrough({ reqId: 8, cause: "no-gui", ops: 0, groups: 0, recalls: 0 });
			mock.sendPassthrough({ reqId: 9, cause: "unsent", ops: 0, groups: 0, recalls: 0 });

			// Send a real, ackable passthrough afterward and wait for THAT one — proves the
			// host's message pump ran past the bogus frames without emitting for them (rather
			// than racing a fixed sleep against the (non-)event).
			mock.sendPassthrough({ reqId: 10, cause: "applied", ops: 0, groups: 0, recalls: 0 });
			await waitFor(
				() => readTelemetry(telemetryOut).some((e) => e.t === "passthrough" && e.reqId === 10),
				5000,
				"the sentinel passthrough telemetry",
			);

			const tel = readTelemetry(telemetryOut);
			const passthroughs = tel.filter((e) => e.t === "passthrough");
			expect(passthroughs.map((e) => e.reqId)).toEqual([10]);

			await mock.close();
			await spawned.exit;
		} finally {
			await mock.close().catch(() => {});
		}
	}, 30_000);

	it("issue #22 review: meta fetch is deadline-bounded against a drip-feeding endpoint (null snapshot, no hang)", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-host-dripmeta-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		// hangMeta: the mock's /__accordion/meta drips a byte every 100ms forever — the
		// socket never idles, so only fetchMetaPlanOutcomes' WALL-CLOCK deadline can end
		// the fetch. Without it, the start snapshot would never arrive and shutdown would
		// hang until the runner's SIGKILL.
		const mock = await new MockExtension({ accordionHome: home, hangMeta: true }).start();

		const spawned = spawnHost({ accordionHome: home, conductor: "builtin", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			await waitFor(() => mock.client !== null, 60_000, "host WS connect");
			await waitFor(() => readTelemetry(telemetryOut).some((e) => e.t === "attach"), 5000, "attach telemetry");

			// The deadline (~2s) must abort the drip and emit a NULL start snapshot rather
			// than hanging forever accumulating body bytes.
			await waitFor(
				() => readTelemetry(telemetryOut).some((e) => e.t === "meta_snapshot" && e.when === "start"),
				10_000,
				"deadline-aborted start meta_snapshot",
			);
			const startSnap = readTelemetry(telemetryOut).find((e) => e.t === "meta_snapshot" && e.when === "start");
			expect(startSnap.planOutcomes).toBeNull();

			// Shutdown must also complete promptly — the end fetch is bounded by the same
			// deadline. A hang here would blow the 30s test timeout.
			await mock.endSession();
			const code = await spawned.exit;
			expect(code).toBe(0);
			const endSnap = readTelemetry(telemetryOut).find((e) => e.t === "meta_snapshot" && e.when === "end");
			expect(endSnap.planOutcomes).toBeNull();
		} finally {
			await mock.close().catch(() => {});
		}
	}, 30_000);

	it("issue #22 review: periodic meta refresh emits mid-run end-candidates so a dead-at-shutdown extension still yields a diff", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-host-metarefresh-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home }).start();
		mock.setMetaPlanOutcomes({ applied: 1 });

		// Shrink the 45s production interval so the test can observe several ticks.
		const spawned = spawnHost({
			accordionHome: home,
			conductor: "builtin",
			budget: 30_000,
			protect: 5_000,
			telemetryOut,
			metaRefreshMs: 250,
		});

		try {
			await waitFor(() => mock.client !== null, 60_000, "host WS connect");
			await waitFor(
				() => readTelemetry(telemetryOut).some((e) => e.t === "meta_snapshot" && e.when === "start"),
				5000,
				"start meta_snapshot",
			);

			// Advance the extension's counters mid-run; a PERIODIC refresh (the WS is still
			// open — this is not the shutdown fetch) must pick the new values up as an
			// "end"-candidate snapshot.
			mock.bumpMetaCause("no-gui", 2);
			await waitFor(
				() =>
					readTelemetry(telemetryOut).some(
						(e) => e.t === "meta_snapshot" && e.when === "end" && e.planOutcomes && e.planOutcomes["no-gui"] === 2,
					),
				5000,
				"periodic end-candidate meta_snapshot with updated counters",
			);
			expect(mock.client).not.toBeNull(); // still mid-run: the WS never closed

			// Session ends; the shutdown snapshot (newest) also lands and remains the last
			// end event in the file — the collector keeps the LATEST non-null end snapshot.
			mock.bumpMetaCause("applied", 1);
			await mock.endSession();
			const code = await spawned.exit;
			expect(code).toBe(0);

			const ends = readTelemetry(telemetryOut).filter((e) => e.t === "meta_snapshot" && e.when === "end" && e.planOutcomes);
			expect(ends.length).toBeGreaterThanOrEqual(2); // at least one periodic + the shutdown one
			const last = ends[ends.length - 1];
			expect(last.planOutcomes).toMatchObject({ applied: 2, "no-gui": 2, total: 4 });
		} finally {
			await mock.close().catch(() => {});
		}
	}, 30_000);
});
