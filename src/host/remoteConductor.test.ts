/*
 * remoteConductor.test.ts — protocol + end-to-end tests for external-conductor support.
 *
 * Two kinds of coverage, per the external-conductors spec:
 *
 *   1. UNIT (fake conductor WS server, driven directly): hello exchange, rev
 *      monotonicity + stale-rev drop, command caching, cap/request round-trips.
 *      These spawn the REAL host (vite-node child, exactly like host.test.ts) pointed
 *      at a fake conductor server this file controls — so "unit" here means "the
 *      conductor side is a hand-rolled fake", not that the host is mocked.
 *
 *   2. END-TO-END THROUGH THE REAL STORE (mandatory per the spec): a fake conductor
 *      sends a fold command batch; we assert against the ACTUAL wire plan the host
 *      relays back to the pi extension (MockExtension) — which only exists because the
 *      real AccordionStore actually folded the block — and that a command targeting a
 *      PROTECTED block is clamped and reported back over host/commandResult. Host
 *      clamps (not-foldable/protected) only surface through the real store; a
 *      MockHost-only unit test cannot see them (see docs/conductor-test-through-store
 *      lesson) — so this test never stubs the store, only the conductor and the pi
 *      extension either side of it.
 *
 * The host cannot be imported in-process here (it drives Svelte-rune modules via the
 * `$conductors` vite alias, which only vite-node's config wires up — see
 * accordion.ts's header) — so exactly like host.test.ts, we spawn the REAL host as a
 * child process via vite-node and drive it through two REAL WebSocket servers this
 * file hosts: one standing in for the pi extension (MockExtension, reused from
 * host.test.ts's sibling), and one standing in for an external conductor process.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockExtension, makeBlocks } from "./mock-extension.mjs";
import { foldHostTelemetry } from "../runner/collect.mjs";

const HOST_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.resolve(HOST_DIR, "../..");
const CONFIG = path.join(REPO_ROOT, "vite-node.config.ts");
const MAIN = path.join(HOST_DIR, "main.ts");

const CONDUCTOR_PROTOCOL_VERSION = 3;

const children: ChildProcess[] = [];
const servers: WebSocketServer[] = [];

afterEach(async () => {
	for (const c of children.splice(0)) {
		try {
			c.kill("SIGKILL");
		} catch {
			/* ignore */
		}
	}
	for (const s of servers.splice(0)) {
		try {
			await new Promise((r) => s.close(r));
		} catch {
			/* ignore */
		}
	}
});

function spawnHost(opts: {
	accordionHome: string;
	conductorUrl: string;
	conductorId: string;
	budget: number;
	protect: number;
	telemetryOut: string;
}): ChildProcess {
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
			"--conductor-url",
			opts.conductorUrl,
			"--conductor-id",
			opts.conductorId,
			"--budget",
			String(opts.budget),
			"--protect",
			String(opts.protect),
			"--telemetry-out",
			opts.telemetryOut,
			"--timeout-min",
			"1",
		],
		{ cwd: REPO_ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
	);
	children.push(child);
	child.stderr?.on("data", (d) => process.stderr.write(`[host] ${d}`));
	return child;
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

/**
 * A fake external conductor, fully driven by the test (no built-in policy) — the
 * unit-level counterpart to MockExtension. Records every host/hello, context/update,
 * and host/commandResult it sees, and lets the test script exactly what
 * conductor/commands to reply with.
 */
class FakeConductor {
	wss!: WebSocketServer;
	url = "";
	client: WebSocket | null = null;
	updates: any[] = []; // context/update messages received
	commandResults: any[] = []; // host/commandResult messages received
	hostHello: any = null;
	private nextCommands: { rev?: number; commands: any[] } | null = null;
	private onUpdate: ((u: any) => void) | null = null;

	async start(opts: { locks?: string[]; wants?: string } = {}): Promise<this> {
		this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		servers.push(this.wss);
		await new Promise((resolve) => this.wss.on("listening", resolve));
		const port = (this.wss.address() as { port: number }).port;
		this.url = `ws://127.0.0.1:${port}`;

		this.wss.on("connection", (ws) => {
			this.client = ws;
			ws.on("message", (raw) => {
				let m: any;
				try {
					m = JSON.parse(raw.toString());
				} catch {
					return;
				}
				if (m.type === "host/hello") {
					this.hostHello = m;
					ws.send(
						JSON.stringify({
							type: "conductor/hello",
							conductorProtocol: CONDUCTOR_PROTOCOL_VERSION,
							id: "fake-conductor",
							label: "Fake Conductor",
							wants: { content: opts.wants ?? "full" },
							locks: opts.locks ?? [],
						}),
					);
				} else if (m.type === "context/update") {
					this.updates.push(m);
					if (this.onUpdate) this.onUpdate(m);
					if (this.nextCommands) {
						const rev = this.nextCommands.rev ?? m.rev;
						ws.send(JSON.stringify({ type: "conductor/commands", rev, commands: this.nextCommands.commands }));
					}
				} else if (m.type === "host/commandResult") {
					this.commandResults.push(m);
				} else if (m.type === "cap/request") {
					this.handleCapRequest(ws, m);
				}
				// host/event: nothing to assert by default; individual tests read via a hook if needed.
			});
		});
		return this;
	}

	private handleCapRequest(ws: WebSocket, m: any): void {
		if (m.capability === "countTokens") {
			ws.send(JSON.stringify({ type: "cap/result", reqId: m.reqId, ok: true, value: Math.ceil((m.text ?? "").length / 4) }));
		} else if (m.capability === "getDigest") {
			ws.send(JSON.stringify({ type: "cap/result", reqId: m.reqId, ok: true, value: "[fake digest]" }));
		} else if (m.capability === "complete") {
			ws.send(JSON.stringify({ type: "cap/result", reqId: m.reqId, ok: false, error: "no completion in this fixture" }));
		}
	}

	/** Arm the NEXT (and every subsequent, until re-armed) context/update reply. */
	replyWith(commands: any[], rev?: number): void {
		this.nextCommands = { commands, rev };
	}

	/** Stop auto-replying (simulate a conductor that goes silent = hold). */
	stopReplying(): void {
		this.nextCommands = null;
	}

	/** Send an arbitrary message to the host over the connected socket. */
	sendRaw(msg: unknown): void {
		if (!this.client) throw new Error("fake conductor: no client connected");
		this.client.send(JSON.stringify(msg));
	}

	waitForUpdate(pred: (u: any) => boolean, ms: number): Promise<any> {
		const existing = this.updates.find(pred);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => {
				this.onUpdate = null;
				reject(new Error("timed out waiting for context/update"));
			}, ms);
			this.onUpdate = (u) => {
				if (pred(u)) {
					clearTimeout(t);
					this.onUpdate = null;
					resolve(u);
				}
			};
		});
	}

	close(): void {
		try {
			this.client?.close();
		} catch {
			/* ignore */
		}
	}
}

describe("B1 regression — a conductor that never becomes ready must not crash the host", () => {
	it("host/client stays alive when the conductor accepts the WS connection then closes WITHOUT sending conductor/hello", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-remote-b1-nohelo-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home }).start();

		// A bare WS server that accepts the connection but never replies with
		// conductor/hello, then closes it almost immediately — this is exactly the
		// "close before greeting" rejection path in remoteConductor.ts's `ready`
		// promise (~line 184). Before the B1 fix, main.ts never handled this
		// rejection, so Node's unhandled-rejection default would kill the whole
		// host process — which would kill the pi run.
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		servers.push(wss);
		await new Promise((resolve) => wss.on("listening", resolve));
		const port = (wss.address() as { port: number }).port;
		const url = `ws://127.0.0.1:${port}`;
		wss.on("connection", (ws) => {
			// Never send conductor/hello — close right away.
			ws.close();
		});

		const host = spawnHost({ accordionHome: home, conductorUrl: url, conductorId: "no-hello-conductor", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			await waitFor(() => mock.client !== null, 60_000, "host <-pi extension connect");

			// Give the close-before-greeting rejection plenty of time to fire and
			// (pre-fix) crash the process.
			await new Promise((r) => setTimeout(r, 1500));
			expect(host.exitCode, "the host must still be alive after a conductor closes before greeting").toBeNull();

			// The host must still be answering syncs — conduct() is pass-through
			// (null/no commands applied) since the conductor never attached.
			const r = mock.sync(makeBlocks(5), { full: true });
			const p = await mock.waitForPlan(r, 8000);
			expect(p.ops.length + p.groups.length).toBe(0);
		} finally {
			await mock.close().catch(() => {});
		}
	}, 30_000);

	it("host/client stays alive on a dial timeout (nothing listening at the conductor URL)", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-remote-b1-timeout-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home }).start();

		// Bind then immediately close a port so nothing is listening there.
		const probe = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await new Promise((resolve) => probe.on("listening", resolve));
		const port = (probe.address() as { port: number }).port;
		await new Promise((resolve) => probe.close(resolve));
		const url = `ws://127.0.0.1:${port}`;

		const host = spawnHost({ accordionHome: home, conductorUrl: url, conductorId: "unreachable-conductor", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			await waitFor(() => mock.client !== null, 60_000, "host <-pi extension connect");

			// Give the dial/connect-refused error (and, pre-fix, the crash) time to happen.
			await new Promise((r) => setTimeout(r, 1500));
			expect(host.exitCode, "the host must still be alive after a dial failure to an unreachable conductor").toBeNull();

			const r = mock.sync(makeBlocks(5), { full: true });
			const p = await mock.waitForPlan(r, 8000);
			expect(p.ops.length + p.groups.length).toBe(0);
		} finally {
			await mock.close().catch(() => {});
		}
	}, 30_000);
});

describe("RemoteConductorClient — protocol unit tests (fake conductor server)", () => {
	it("hello exchange: host/hello arrives, conductor greets, host attaches", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-remote-hello-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home }).start();
		const fake = await new FakeConductor().start();

		const host = spawnHost({ accordionHome: home, conductorUrl: fake.url, conductorId: "fake-conductor", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			await waitFor(() => mock.client !== null, 60_000, "host <-pi extension connect");
			await waitFor(() => fake.hostHello !== null, 10_000, "host/hello at the fake conductor");

			expect(fake.hostHello.conductorProtocol).toBe(CONDUCTOR_PROTOCOL_VERSION);
			expect(typeof fake.hostHello.budget).toBe("number");
			expect(fake.hostHello.budget).toBe(30_000);

			await waitFor(() => readTelemetry(telemetryOut).some((e) => e.t === "attach" && e.conductor === "fake-conductor"), 5000, "attach telemetry");
		} finally {
			await mock.close().catch(() => {});
			fake.close();
		}
	}, 30_000);

	it("locks-bearing hello (thermocline shape) does not crash the host — LOCK_NAMES import regression", async () => {
		// Found live: thermocline greets with locks: ["human-steering"]. LOCK_NAMES
		// was imported from contract/protocol (which doesn't export it) instead of
		// contract/conductor — undefined under vite-node, so the locks filter threw
		// on the FIRST real hello and the unhandled exception killed the host.
		// Every fixture here defaulted to locks: [] (filter callback never runs),
		// which is exactly how 92 green tests missed it.
		const home = mkdtempSync(path.join(tmpdir(), "bellows-remote-locks-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home }).start();
		const fake = await new FakeConductor({ locks: ["human-steering"] }).start();

		const host = spawnHost({ accordionHome: home, conductorUrl: fake.url, conductorId: "fake-conductor", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			await waitFor(() => mock.client !== null, 60_000, "host <-pi extension connect");
			await waitFor(() => fake.hostHello !== null, 10_000, "host/hello at the fake conductor");
			// The greet info only lands if handle() survived the locks-bearing hello.
			await waitFor(
				() => readTelemetry(telemetryOut).some((e) => e.t === "info" && String(e.message).includes("greeted")),
				5000,
				"greet info telemetry after locks-bearing hello",
			);
			expect(host.exitCode).toBeNull();
			// No handler-threw error frame, and the host stayed attached.
			const errs = readTelemetry(telemetryOut).filter((e) => e.t === "error");
			expect(errs.map((e) => e.message).join("\n")).not.toMatch(/handler threw|never became ready/);
		} finally {
			await mock.close().catch(() => {});
			fake.close();
		}
	}, 30_000);

	it("rev is monotonic and a stale-rev conductor/commands reply is dropped", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-remote-rev-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home }).start();
		const fake = await new FakeConductor().start();

		const host = spawnHost({ accordionHome: home, conductorUrl: fake.url, conductorId: "fake-conductor", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			await waitFor(() => mock.client !== null, 60_000, "connect");
			await waitFor(() => fake.hostHello !== null, 10_000, "greeted");

			// Push two syncs so the host emits (at least) two context/update revs.
			mock.sync(makeBlocks(5), { full: true });
			await waitFor(() => fake.updates.length >= 1, 5000, "first context/update");
			const firstRev = fake.updates[0].rev;

			mock.sync(makeBlocks(2), { full: false });
			await waitFor(() => fake.updates.length >= 2, 5000, "second context/update");
			const secondRev = fake.updates[fake.updates.length - 1].rev;
			expect(secondRev).toBeGreaterThan(firstRev);

			// A stale-rev reply (rev < current) must be dropped: fold something the host
			// would otherwise apply, but tag it with an already-superseded rev.
			const blocks = makeBlocks(30); // guarantees at least one foldable tool_result exists
			const staleTargetId = "r:call-0";
			fake.replyWith([{ kind: "fold", ids: [staleTargetId] }], firstRev); // stale on purpose
			mock.sync(blocks, { full: false });
			await waitFor(() => fake.updates.length >= 3, 5000, "third context/update");

			// Give the host a moment to have processed any (wrongly-applied) commands, then
			// verify the block was NOT folded by checking the wire plan never names it.
			await new Promise((r) => setTimeout(r, 300));
			const anyFoldedStaleTarget = mock.plans.some((p) => p.ops.some((o: any) => o.id === staleTargetId));
			expect(anyFoldedStaleTarget).toBe(false);
		} finally {
			await mock.close().catch(() => {});
			fake.close();
		}
	}, 30_000);

	it("caches conductor/commands and answers cap/request (countTokens, getDigest)", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-remote-cap-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home }).start();
		const fake = await new FakeConductor().start();

		const host = spawnHost({ accordionHome: home, conductorUrl: fake.url, conductorId: "fake-conductor", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			await waitFor(() => mock.client !== null, 60_000, "connect");
			await waitFor(() => fake.hostHello !== null, 10_000, "greeted");

			const blocks = makeBlocks(30);
			const targetId = "r:call-0";
			fake.replyWith([{ kind: "fold", ids: [targetId] }]);
			const reqId = mock.sync(blocks, { full: true });

			// The FIRST sync reply is the last (empty) plan — the crux is unaffected by an
			// external conductor. The fold lands on a LATER sync once commands are cached.
			const firstPlan = await mock.waitForPlan(reqId, 8000);
			expect(firstPlan.ops.length + firstPlan.groups.length).toBe(0);

			let folded: any = null;
			for (let i = 0; i < 10 && !folded; i++) {
				const r = mock.sync([], { full: false });
				const p = await mock.waitForPlan(r, 8000);
				if (p.ops.some((o: any) => o.id === targetId)) folded = p;
				else await new Promise((res) => setTimeout(res, 150));
			}
			expect(folded, "the fake conductor's fold command must reach the wire plan").not.toBeNull();
		} finally {
			await mock.close().catch(() => {});
			fake.close();
		}
	}, 30_000);

	it("M3: a conductor/status message is recorded as t:'info', and folded RunRecord errors[] stays empty", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-remote-status-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home }).start();
		const fake = await new FakeConductor().start();

		const host = spawnHost({ accordionHome: home, conductorUrl: fake.url, conductorId: "fake-conductor", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			await waitFor(() => mock.client !== null, 60_000, "connect");
			await waitFor(() => fake.hostHello !== null, 10_000, "greeted");

			fake.sendRaw({ type: "conductor/status", text: "warming up the model" });

			await waitFor(
				() => readTelemetry(telemetryOut).some((e) => e.t === "info" && typeof e.message === "string" && e.message.includes("warming up the model")),
				5000,
				"info telemetry for conductor/status",
			);

			const tel = readTelemetry(telemetryOut);
			// Never duplicated onto the error channel.
			expect(tel.some((e) => e.t === "error" && typeof e.message === "string" && e.message.includes("warming up the model"))).toBe(false);

			// The greet itself (already emitted before this point) must also be info, not error.
			expect(tel.some((e) => e.t === "info" && typeof e.message === "string" && e.message.includes("greeted"))).toBe(true);
			expect(tel.some((e) => e.t === "error" && typeof e.message === "string" && e.message.includes("greeted"))).toBe(false);

			// End-to-end through the real collector: folding this telemetry stream into a
			// ConductorTelemetry must leave errors[] empty even though the conductor has
			// been plenty chatty (greet + status).
			const folded = foldHostTelemetry(readFileSync(telemetryOut, "utf8"), "fake-conductor");
			expect(folded.errors).toEqual([]);
			expect(folded.infos.length).toBeGreaterThanOrEqual(2); // greet + status
		} finally {
			await mock.close().catch(() => {});
			fake.close();
		}
	}, 30_000);
});

describe("RemoteConductorClient — end to end through the REAL AccordionStore", () => {
	it("folds the targeted block, clamps a protected one, and reports the clamp back over host/commandResult", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-remote-e2e-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home }).start();
		const fake = await new FakeConductor().start();

		// Small budget + small protect so a handful of blocks land inside the protected tail
		// deterministically (host policy — the REAL store computes protectedFromIndex, not us).
		const host = spawnHost({ accordionHome: home, conductorUrl: fake.url, conductorId: "fake-conductor", budget: 30_000, protect: 2_000, telemetryOut });

		try {
			await waitFor(() => mock.client !== null, 60_000, "connect");
			await waitFor(() => fake.hostHello !== null, 10_000, "greeted");

			const blocks = makeBlocks(60); // far over budget -> a substantial protected/foldable split
			const reqId = mock.sync(blocks, { full: true });
			await mock.waitForPlan(reqId, 8000);

			// Wait for the first context/update carrying the real store's view so we can identify
			// a genuinely protected block id (protected: true) vs a foldable one, straight from
			// the REAL store's own protectedFromIndex/tail computation — never assumed by the test.
			const firstUpdate = await fake.waitForUpdate((u) => Array.isArray(u.blocks) && u.blocks.length > 0, 8000);
			const protectedBlock = firstUpdate.blocks.find((b: any) => b.kind === "tool_result" && b.protected);
			const foldableBlock = firstUpdate.blocks.find((b: any) => b.kind === "tool_result" && !b.protected && !b.folded);
			expect(protectedBlock, "the batch must produce at least one protected tool_result").toBeTruthy();
			expect(foldableBlock, "the batch must produce at least one foldable tool_result").toBeTruthy();

			// Command a batch that folds BOTH: the foldable one should succeed; the protected
			// one must be clamped (reason "protected") by the REAL store's applyCommands —
			// this is exactly the clamp a MockHost-only test cannot observe.
			fake.replyWith([{ kind: "fold", ids: [foldableBlock.id, protectedBlock.id] }]);
			mock.sync([], { full: false }); // nudge a context/update if one isn't already pending

			// The wire plan must eventually carry the foldable block's fold op, never the
			// protected one's.
			let folded: any = null;
			for (let i = 0; i < 12 && !folded; i++) {
				const r = mock.sync([], { full: false });
				const p = await mock.waitForPlan(r, 8000);
				if (p.ops.some((o: any) => o.id === foldableBlock.id)) folded = p;
				else await new Promise((res) => setTimeout(res, 150));
			}
			expect(folded, "the foldable block must actually be folded on the wire").not.toBeNull();
			expect(folded!.ops.some((o: any) => o.id === protectedBlock.id)).toBe(false);

			// host/commandResult must carry the ACTUAL clamp report from the real store —
			// reason "protected", naming the protected block id.
			await waitFor(
				() => fake.commandResults.some((r) => Array.isArray(r.reports) && r.reports.some((rep: any) => rep.reason === "protected" && rep.ids.includes(protectedBlock.id))),
				8000,
				"host/commandResult carrying a protected clamp",
			);
			const resultWithClamp = fake.commandResults.find((r) => r.reports?.some((rep: any) => rep.reason === "protected"));
			expect(resultWithClamp).toBeTruthy();
		} finally {
			await mock.close().catch(() => {});
			fake.close();
		}
	}, 30_000);

	it("holds the last applied state while the conductor is silent but still connected", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-remote-hold-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home }).start();
		const fake = await new FakeConductor().start();

		const host = spawnHost({ accordionHome: home, conductorUrl: fake.url, conductorId: "fake-conductor", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			await waitFor(() => mock.client !== null, 60_000, "connect");
			await waitFor(() => fake.hostHello !== null, 10_000, "greeted");

			const blocks = makeBlocks(40);
			const targetId = "r:call-0";
			fake.replyWith([{ kind: "fold", ids: [targetId] }]);
			mock.sync(blocks, { full: true });

			let folded: any = null;
			for (let i = 0; i < 12 && !folded; i++) {
				const r = mock.sync([], { full: false });
				const p = await mock.waitForPlan(r, 8000);
				if (p.ops.some((o: any) => o.id === targetId)) folded = p;
				else await new Promise((res) => setTimeout(res, 150));
			}
			expect(folded, "precondition: the block must be folded before we test the hold").not.toBeNull();

			// The conductor goes silent but stays CONNECTED (stops replying to
			// context/update): the host must HOLD the last applied state, not clear
			// it — the fold must still be on the wire. This is distinct from an
			// actual WS drop (covered below and in the m7 test), which now clears to
			// raw instead of holding.
			fake.stopReplying();
			let stillFolded = false;
			for (let i = 0; i < 6; i++) {
				const r = mock.sync([], { full: false });
				const p = await mock.waitForPlan(r, 8000);
				if (p.ops.some((o: any) => o.id === targetId)) stillFolded = true;
				await new Promise((res) => setTimeout(res, 100));
			}
			expect(stillFolded, "a silent-but-connected conductor must hold the last applied state").toBe(true);
		} finally {
			await mock.close().catch(() => {});
			fake.close();
		}
	}, 30_000);

	it("m7/m6: an unexpected WS drop clears the desired state to raw, keeps the host alive, and emits an info (not error) death notice", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "bellows-remote-died-"));
		const telemetryOut = path.join(home, "telemetry.jsonl");
		const mock = await new MockExtension({ accordionHome: home }).start();
		const fake = await new FakeConductor().start();

		const host = spawnHost({ accordionHome: home, conductorUrl: fake.url, conductorId: "fake-conductor", budget: 30_000, protect: 5_000, telemetryOut });

		try {
			await waitFor(() => mock.client !== null, 60_000, "connect");
			await waitFor(() => fake.hostHello !== null, 10_000, "greeted");

			// Get a real fold batch applied first (the "connected conductor sends a
			// fold batch" precondition from the required-tests list).
			const blocks = makeBlocks(40);
			const targetId = "r:call-0";
			fake.replyWith([{ kind: "fold", ids: [targetId] }]);
			mock.sync(blocks, { full: true });

			let folded: any = null;
			for (let i = 0; i < 12 && !folded; i++) {
				const r = mock.sync([], { full: false });
				const p = await mock.waitForPlan(r, 8000);
				if (p.ops.some((o: any) => o.id === targetId)) folded = p;
				else await new Promise((res) => setTimeout(res, 150));
			}
			expect(folded, "precondition: the block must be folded before the conductor dies").not.toBeNull();

			// Now the conductor process disconnects entirely (WS drop) — the host must
			// NOT crash the run; it should keep running (still answering syncs) rather
			// than exiting, AND the store must clear back to raw (no fold survives).
			fake.close();
			await new Promise((res) => setTimeout(res, 500));
			expect(host.exitCode).toBeNull();

			let clearedToRaw = false;
			for (let i = 0; i < 10 && !clearedToRaw; i++) {
				const r = mock.sync([], { full: false });
				const p = await mock.waitForPlan(r, 8000);
				if (!p.ops.some((o: any) => o.id === targetId)) clearedToRaw = true;
				else await new Promise((res) => setTimeout(res, 150));
			}
			expect(clearedToRaw, "the fold must be cleared back to raw after the conductor dies").toBe(true);

			const tel = readTelemetry(telemetryOut);
			// The death notice must be a non-error "info" event (M3/m7) — never folded
			// into RunRecord.errors[] — and must name the "cleared to raw" semantics.
			const deathNotice = tel.find((e) => e.t === "info" && typeof e.message === "string" && e.message.includes("cleared to raw"));
			expect(deathNotice, "expected an info-level death notice mentioning 'cleared to raw'").toBeTruthy();
			// And it must NOT also appear as an error-kind event.
			expect(tel.some((e) => e.t === "error" && typeof e.message === "string" && e.message.includes("cleared to raw"))).toBe(false);
		} finally {
			await mock.close().catch(() => {});
			fake.close();
		}
	}, 30_000);
});
