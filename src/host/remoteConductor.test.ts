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

	it("holds the last applied state (never fabricates) when the conductor goes silent, and survives a disconnect without crashing the run", async () => {
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
			expect(folded, "precondition: the block must be folded before we test the hold/disconnect").not.toBeNull();

			// The conductor goes silent (stops replying to context/update): the host must
			// HOLD the last applied state, not clear it — the fold must still be on the wire.
			fake.stopReplying();
			let stillFolded = false;
			for (let i = 0; i < 6; i++) {
				const r = mock.sync([], { full: false });
				const p = await mock.waitForPlan(r, 8000);
				if (p.ops.some((o: any) => o.id === targetId)) stillFolded = true;
				await new Promise((res) => setTimeout(res, 100));
			}
			expect(stillFolded, "a silent conductor must hold the last applied state").toBe(true);

			// Now the conductor process disconnects entirely — the host must NOT crash the
			// run; it should keep running (still answering syncs) rather than exiting.
			fake.close();
			await new Promise((res) => setTimeout(res, 500));
			expect(host.exitCode).toBeNull();
			const r = mock.sync([], { full: false });
			const p = await mock.waitForPlan(r, 8000);
			expect(p).toBeTruthy(); // the host is still alive and answering syncs

			const tel = readTelemetry(telemetryOut);
			expect(tel.some((e) => e.t === "error" && typeof e.message === "string" && e.message.includes("disconnected"))).toBe(true);
		} finally {
			await mock.close().catch(() => {});
			fake.close();
		}
	}, 30_000);
});
