import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
// Real production code, not a reimplementation — see its doc comment in accordionV15.ts
// for why a direct unit test of this predicate exists alongside the SIGTERM integration
// test below.
import { isGenuineMidRunDetach } from "../accordionV15";

const BELLOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// vite-node spins up a real child process + a real WebSocketServer per test; on a
// loaded CI box that alone can eat a couple of seconds before the fixture is even
// touched. The suite previously relied on vitest's 5000ms default and flaked under
// parallel load — give it real headroom. Tests that assert FAST failure (3/4/6, plus
// the persistent-refusal case) additionally assert an explicit upper bound on elapsed
// wall-clock time so a regression to the 30s attach-timeout is still caught precisely,
// rather than merely being caught eventually by this suite-wide ceiling.
const SUITE_TIMEOUT_MS = 30_000;

// Mirrors main-v15.ts's SURFACE_ID_RE (not exported) — kept in lockstep by the shared
// comment; if that regex changes, this one must change with it.
const SURFACE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function writeModule(file, source) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, source);
}

/**
 * Build a fixture Accordion checkout for `version`.
 *
 * - core/protocol.ts: PROTOCOL_VERSION is the only thing that varies here — it's what
 *   drives every version-gated branch in main-v15.ts.
 * - core/replica.ts: kept as the existing minimal stub at EVERY version, deliberately.
 *   The real module needs no adaptation for v22 — hydrateSnapshot/applyWireEvent's
 *   signatures are unchanged end to end (verified against the diff: v22's `system`
 *   block kind is purely internal to replica.ts's own bookkeeping and never reaches
 *   the wire shapes main-v15.ts parses). Stubbing it keeps this test about *host wire
 *   behavior* — hello/claim/commands/conductorState — not replica/block semantics,
 *   which belong to a different test.
 * - core/conductor/registry.ts: v15 keeps the pre-existing single-entry shape. v22 uses
 *   the real devmain registry shape (none, compaction-naive, handoff, doorman
 *   in-process; thermocline, triptych spawn) so a fixture id chosen for these tests
 *   corresponds to a real devmain conductor id, not a bellows-only invention.
 */
function makeAccordionFixture(root, version) {
	writeModule(path.join(root, "core", "protocol.ts"), `
export const PROTOCOL_VERSION = ${version};
export const isServerMessage = (value) => !!value && typeof value.type === "string";
`);
	writeModule(path.join(root, "core", "replica.ts"), `
export function hydrateSnapshot(_meta, state) {
  return {
    rev: state.rev || 0,
    blocks: state.blocks || [],
    groups: state.groups || [],
    foldedCount: () => 0,
    stats() { return { rev: this.rev, liveTokens: 0, fullTokens: 0, budget: 0, protectTokens: 0, blockCount: this.blocks.length }; },
  };
}
export function applyWireEvent(truth, event) { truth.rev = event.rev; }
`);
	const registrySource =
		version >= 22
			? `
export const ENTRIES = [
  { id: "none", label: "None", kind: "none" },
  { id: "compaction-naive", label: "Naive compaction", kind: "in-process" },
  { id: "handoff", label: "Handoff", kind: "in-process" },
  { id: "doorman", label: "Doorman", kind: "in-process" },
  { id: "thermocline", label: "Thermocline", kind: "spawn" },
  { id: "triptych", label: "Triptych", kind: "spawn" },
];
`
			: `
export const ENTRIES = [{ id: "compaction-naive", label: "Naive compaction", kind: "in-process" }];
`;
	writeModule(path.join(root, "core", "conductor", "registry.ts"), registrySource);
	fs.mkdirSync(path.join(root, "conductors"), { recursive: true });
}

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
}

function waitForExit(child, timeoutMs = 8_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("v15 host integration process timed out"));
		}, timeoutMs);
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

async function waitForFile(predicate, timeoutMs, label) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`timed out waiting for ${label}`);
}

function readTelemetry(file) {
	if (!fs.existsSync(file)) return "";
	return fs.readFileSync(file, "utf8");
}

/**
 * On POSIX, a signal sent via `child.kill()` is caught by main-v15.ts's own
 * SIGTERM/SIGINT handlers, which drive the graceful `terminating` path to a real
 * `return 0`. On Windows, `child.kill()` (any signal) is documented by Node itself to
 * unconditionally hard-terminate the target process (TerminateProcess) instead of
 * delivering something catchable — verified empirically for this exact spawn shape,
 * and already noted elsewhere in this repo (see host.test.ts's SIGTERM comment and
 * worker/__tests__/cmdWorker.test.mjs). main-v15.ts's clean-exit(0) path is reachable
 * ONLY through a caught signal, so on win32 the strongest true statement this test can
 * make is "the process was terminated, not that it self-reported success" — the wire
 * assertions made *before* the kill (URL, claim ordering, commands, attach telemetry)
 * are what actually prove the happy path; the exit code here is a secondary check.
 */
function expectGracefulExit(exit) {
	if (process.platform === "win32") {
		expect(exit.code === null || exit.signal != null).toBe(true);
	} else {
		expect(exit.code).toBe(0);
	}
}

function spawnHost({ accordionRepo, accordionHome, telemetryOut, conductor, budget = 100000, protect = 20000, timeoutMin = 1, attachTimeoutMs = 100, extraArgs = [] }) {
	const child = spawn(process.execPath, [
		path.join(BELLOWS_ROOT, "node_modules", "vite-node", "vite-node.mjs"),
		"--config", "vite-node.config.ts",
		"src/host/main-v15.ts", "--",
		"--accordion-home", accordionHome,
		"--conductor", conductor,
		"--budget", String(budget),
		"--protect", String(protect),
		"--telemetry-out", telemetryOut,
		"--timeout-min", String(timeoutMin),
		"--attach-timeout-ms", String(attachTimeoutMs),
		...extraArgs,
	], {
		cwd: BELLOWS_ROOT,
		env: { ...process.env, BELLOWS_ACCORDION_REPO: accordionRepo },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
	return { child, getStderr: () => stderr };
}

function writeSession({ accordionHome, port, protocolVersion, sessionId = "test-session" }) {
	const sessionDir = path.join(accordionHome, ".accordion", "sessions");
	fs.mkdirSync(sessionDir, { recursive: true });
	fs.writeFileSync(path.join(sessionDir, `${sessionId}.json`), JSON.stringify({
		sessionId,
		port,
		heartbeatAt: Date.now(),
		protocolVersion,
	}));
}

/**
 * A WebSocketServer stand-in for the Accordion extension's GUI-role socket, extended
 * (beyond the original ordering-only mock) to actually model the v16 read-only
 * controller-lease gate: it captures the raw upgrade URL, tracks whether a
 * valid-surface `claimController` has landed on the connection, and refuses every
 * `command` frame with `{type:"commandResult", seq, results:[], rev:0,
 * refused:"read-only"}` until one has. `requireClaims` lets a test simulate a lease
 * that isn't granted on the very first claim (e.g. a stale prior holder) — the claim
 * only "lands" once at least that many `claimController` messages have arrived.
 * `requireClaims: 0` disables the gate entirely (every command is accepted from the
 * start) — used for pre-v16 connections, which never send `claimController` at all,
 * so a nonzero requirement could never be satisfied.
 */
function makeLeaseServer({ requireClaims = 1 } = {}) {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	const commands = [];
	const events = []; // ordered list of every inbound message type, for ordering assertions
	let upgradeUrl = null;
	let claimCount = 0;
	let claimed = requireClaims <= 0;
	let socketRef = null;

	server.on("connection", (socket, request) => {
		upgradeUrl = request.url;
		socketRef = socket;
		socket.on("message", (data) => {
			let msg;
			try { msg = JSON.parse(data.toString()); } catch { return; }
			events.push(msg.type);
			if (msg.type === "claimController") {
				claimCount++;
				if (claimCount >= requireClaims) claimed = true;
				return;
			}
			if (msg.type !== "command") return;
			commands.push(msg.cmd);
			if (!claimed) {
				socket.send(JSON.stringify({ type: "commandResult", seq: msg.seq, results: [], rev: 0, refused: "read-only" }));
				return;
			}
			server.emit("acceptedCommand", { socket, msg, commands });
		});
	});

	return {
		server,
		commands,
		events,
		getUpgradeUrl: () => upgradeUrl,
		getSocket: () => socketRef,
		getClaimCount: () => claimCount,
		isClaimed: () => claimed,
	};
}

function sendHello(socket, { version, conductorId, cwd, conductors, includeReadiness = version >= 21 }) {
	socket.send(JSON.stringify({
		type: "hello",
		protocolVersion: version,
		sessionId: "test-session",
		role: "gui",
		meta: { format: "pi", title: "test", cwd, model: "fake", contextWindow: 100_000 },
		conductors: conductors ?? [
			{ id: conductorId, label: conductorId, kind: "in-process", ...(includeReadiness ? { readiness: { state: "ready" } } : {}) },
		],
	}));
}

function sendSnapshot(socket) {
	socket.send(JSON.stringify({ type: "snapshot", state: { rev: 0, blocks: [], groups: [], overlay: [] } }));
}

describe.each([15, 22])("Accordion v%i resident host — happy path", (version) => {
	it(
		"configures, claims the controller (v16+), and attaches",
		async () => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bellows-host-v${version}-`));
			const accordionRepo = path.join(tmp, "accordion");
			const accordionHome = path.join(tmp, "home");
			const telemetryOut = path.join(tmp, "host.jsonl");
			const lease = makeLeaseServer({ requireClaims: version >= 16 ? 1 : 0 });
			let child;
			try {
				makeAccordionFixture(accordionRepo, version);
				await listen(lease.server);
				const port = lease.server.address().port;
				writeSession({ accordionHome, port, protocolVersion: version });

				lease.server.on("connection", (socket) => {
					sendHello(socket, { version, conductorId: "compaction-naive", cwd: tmp });
					sendSnapshot(socket);
				});
				lease.server.on("acceptedCommand", ({ socket, commands }) => {
					if (commands.length === 4) {
						socket.send(JSON.stringify({ type: "conductorState", active: { id: "compaction-naive" } }));
					}
				});

				({ child } = spawnHost({ accordionRepo, accordionHome, telemetryOut, conductor: "compaction-naive" }));

				await waitForFile(() => readTelemetry(telemetryOut).includes('"t":"attach"'), 18_000, "attach telemetry");

				if (version >= 16) {
					const url = lease.getUpgradeUrl();
					expect(url).toMatch(/[?&]role=gui(&|$)/);
					const surfaceMatch = url.match(/[?&]surface=([^&]+)/);
					expect(surfaceMatch).toBeTruthy();
					expect(decodeURIComponent(surfaceMatch[1])).toMatch(SURFACE_ID_RE);
					const claimIdx = lease.events.indexOf("claimController");
					const firstCommandIdx = lease.events.indexOf("command");
					expect(claimIdx).toBeGreaterThanOrEqual(0);
					expect(firstCommandIdx).toBeGreaterThan(claimIdx);
				} else {
					// v15 non-regression: byte-identical URL, no controller-lease traffic at all.
					expect(lease.getUpgradeUrl()).toBe("/?role=gui");
					expect(lease.getClaimCount()).toBe(0);
				}

				expect(lease.commands.slice(0, 4)).toEqual([
					{ kind: "setBudget", value: 100000 },
					{ kind: "setProtect", value: 20000 },
					{ kind: "selectConductor", id: "compaction-naive" },
					{ kind: "setFolding", value: true },
				]);
				const telemetryText = readTelemetry(telemetryOut);
				expect(telemetryText).toContain('"t":"attach"');
				// Defect 3 regression: v19 folded the system prompt's tokens into liveTokens/
				// fullTokens, and v22 made the system prompt a real WireBlock (blocks.length
				// +1) — so a v15 run's and a v22 run's "t":"sync" series are on different
				// scales. protocolVersion on "t":"attach" is what lets downstream analysis tell
				// which scale a given run's series is on; assert it matches this matrix row's
				// own version, not a hardcoded constant, so both the v15 and v22 parameterized
				// runs are checked against themselves.
				const attachLine = telemetryText.split("\n").find((line) => line.includes('"t":"attach"'));
				expect(attachLine).toBeTruthy();
				expect(JSON.parse(attachLine).protocolVersion).toBe(version);

				child.kill("SIGTERM");
				const exit = await waitForExit(child);
				expectGracefulExit(exit);
			} finally {
				await new Promise((resolve) => lease.server.close(resolve));
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		SUITE_TIMEOUT_MS,
	);
});

describe("Accordion v15 resident host — pre-existing regression coverage", () => {
	async function runV15Controller(mode) {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-v15-host-"));
		const accordionRepo = path.join(tmp, "accordion");
		const accordionHome = path.join(tmp, "home");
		const telemetryOut = path.join(tmp, "host.jsonl");
		const commands = [];
		const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		let child;
		let getStderr = () => "";
		try {
			makeAccordionFixture(accordionRepo, 15);
			await listen(server);
			const port = server.address().port;
			writeSession({ accordionHome, port, protocolVersion: 15 });

			server.on("connection", (socket) => {
				socket.send(JSON.stringify({
					type: "hello",
					protocolVersion: 15,
					sessionId: "test-session",
					role: "gui",
					meta: { format: "pi", title: "test", cwd: tmp, model: "fake", contextWindow: 100_000 },
					conductors: [{ id: "compaction-naive", label: "Naive compaction", kind: "in-process" }],
				}));
				socket.send(JSON.stringify({
					type: "snapshot",
					state: { rev: 0, blocks: [], groups: [], overlay: [] },
				}));
				socket.on("message", (data) => {
					const message = JSON.parse(data.toString());
					if (message.type !== "command") return;
					commands.push(message.cmd);
					if (mode === "unexpected-close" && commands.length === 4) {
						socket.send(JSON.stringify({ type: "conductorState", active: { id: "compaction-naive" } }));
						setTimeout(() => socket.close(1011, "simulated server failure"), 25);
					}
				});
			});

			({ child, getStderr } = spawnHost({ accordionRepo, accordionHome, telemetryOut, conductor: "compaction-naive" }));
			const exit = await waitForExit(child);
			return { commands, exit, stderr: getStderr(), telemetry: readTelemetry(telemetryOut) };
		} finally {
			await new Promise((resolve) => server.close(resolve));
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	}

	it(
		"configures and attaches, then fails closed on unexpected socket loss",
		async () => {
			const result = await runV15Controller("unexpected-close");
			expect(result.commands.slice(0, 4)).toEqual([
				{ kind: "setBudget", value: 100000 },
				{ kind: "setProtect", value: 20000 },
				{ kind: "selectConductor", id: "compaction-naive" },
				{ kind: "setFolding", value: true },
			]);
			expect(result.exit.code).toBe(1);
			expect(result.telemetry).toContain('"t":"attach"');
			expect(result.stderr).toContain("session socket closed unexpectedly");
		},
		SUITE_TIMEOUT_MS,
	);

	it(
		"disarms folding and detaches before exiting on attach timeout",
		async () => {
			const result = await runV15Controller("attach-timeout");
			expect(result.commands).toEqual([
				{ kind: "setBudget", value: 100000 },
				{ kind: "setProtect", value: 20000 },
				{ kind: "selectConductor", id: "compaction-naive" },
				{ kind: "setFolding", value: true },
				{ kind: "setFolding", value: false },
				{ kind: "selectConductor", id: null },
			]);
			expect(result.exit.code).toBe(1);
			expect(result.stderr).toContain("did not become active within 100ms");
		},
		SUITE_TIMEOUT_MS,
	);
});

/*
 * FIXED DEFECT (was reported as a deliberately-failing test, now fixed in main-v15.ts):
 * the "commandResult" handler (around lines 393-412) used to check only a single global
 * `claimRetries` counter, with no correlation between an incoming `refused:"read-only"`
 * reply and the batch/attempt it belonged to. sendConfigureCommands() always fires four
 * separate `command` frames, and per this file's mock server (refuse EVERY command
 * individually while unclaimed), an unclaimed burst of four draws FOUR separate
 * `commandResult{refused:"read-only"}` replies — not one. The FIRST used to correctly
 * trigger the one allowed retry (re-claim + resend), but the SECOND — still in flight
 * from the *original, now-superseded* batch — arrived shortly after and, with
 * `claimRetries` already at `CLAIM_RETRY_LIMIT`, immediately fataled, even though the
 * retry itself was independently in flight and succeeding. A second, compounding bug:
 * no message-handling `case` was guarded by `if (fatal) return`, so a legitimately-
 * arriving `conductorState` acknowledging the successful retry was still processed
 * after the fatal fired, setting `attached = true` and emitting a `"t":"attach"`
 * telemetry line AFTER the run had already torn itself down and exited 1 — a
 * self-contradicting telemetry stream.
 *
 * Fix: sendConfigureCommands() now records `batchStartSeq = commandSeq + 1` before
 * sending, and the commandResult handler ignores any refusal whose `seq < batchStartSeq`
 * as a stale reply from a superseded batch. Separately, an early `if (fatal) return` at
 * the top of the message handler stops any case from running once fatal is set. The
 * test below asserts the spec's required behavior and now passes.
 */
describe("Accordion v22 resident host — v16-v22 behaviors", () => {
	it(
		"recovers from one read-only refusal — exactly one re-claim and one re-send, then attaches",
		async () => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-host-v22-refuse-"));
			const accordionRepo = path.join(tmp, "accordion");
			const accordionHome = path.join(tmp, "home");
			const telemetryOut = path.join(tmp, "host.jsonl");
			// requireClaims:2 simulates a lease not yet released (e.g. a stale prior holder) —
			// the FIRST claimController (sent unconditionally on hello) does not land; only the
			// retry claimController (triggered by the read-only refusal) does.
			const lease = makeLeaseServer({ requireClaims: 2 });
			let child;
			try {
				makeAccordionFixture(accordionRepo, 22);
				await listen(lease.server);
				const port = lease.server.address().port;
				writeSession({ accordionHome, port, protocolVersion: 22 });

				lease.server.on("connection", (socket) => {
					sendHello(socket, { version: 22, conductorId: "compaction-naive", cwd: tmp });
					sendSnapshot(socket);
				});
				lease.server.on("acceptedCommand", ({ socket, commands }) => {
					if (commands.length === 8) {
						socket.send(JSON.stringify({ type: "conductorState", active: { id: "compaction-naive" } }));
					}
				});

				({ child } = spawnHost({ accordionRepo, accordionHome, telemetryOut, conductor: "compaction-naive", extraArgs: ["--surface-id", "test-surface-retry"] }));

				await waitForFile(() => readTelemetry(telemetryOut).includes('"t":"attach"'), 18_000, "attach telemetry");

				expect(lease.getClaimCount()).toBe(2);
				const fourCommands = [
					{ kind: "setBudget", value: 100000 },
					{ kind: "setProtect", value: 20000 },
					{ kind: "selectConductor", id: "compaction-naive" },
					{ kind: "setFolding", value: true },
				];
				expect(lease.commands).toEqual([...fourCommands, ...fourCommands]);
				const telemetry = readTelemetry(telemetryOut);
				expect(telemetry).toContain('"t":"attach"');
				// The retry must actually RECOVER, not merely avoid fataling early: no fatal
				// telemetry line should exist at all (the pre-fix bug reached beginFatal() from
				// the second, stale refusal even while the retry was independently succeeding).
				expect(telemetry).not.toMatch(/"t":"error".*could not be claimed/);
				expect(telemetry).not.toMatch(/"t":"error".*controller lease refused/);

				child.kill("SIGTERM");
				const exit = await waitForExit(child);
				expectGracefulExit(exit);
				// Recovery, not just "didn't fatal yet": the process must actually reach a
				// successful attach and (on platforms where the signal is real) exit 0.
				if (process.platform !== "win32") expect(exit.code).toBe(0);
			} finally {
				await new Promise((resolve) => lease.server.close(resolve));
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		SUITE_TIMEOUT_MS,
	);

	it(
		"exits fast (not the 30s attach-timeout) when the server refuses the controller lease persistently",
		async () => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-host-v22-persist-refuse-"));
			const accordionRepo = path.join(tmp, "accordion");
			const accordionHome = path.join(tmp, "home");
			const telemetryOut = path.join(tmp, "host.jsonl");
			// requireClaims set impossibly high — the lease is never granted, no matter how
			// many times the host re-claims.
			const lease = makeLeaseServer({ requireClaims: 1_000_000 });
			let child;
			let getStderr = () => "";
			try {
				makeAccordionFixture(accordionRepo, 22);
				await listen(lease.server);
				const port = lease.server.address().port;
				writeSession({ accordionHome, port, protocolVersion: 22 });

				lease.server.on("connection", (socket) => {
					sendHello(socket, { version: 22, conductorId: "compaction-naive", cwd: tmp });
					sendSnapshot(socket);
				});

				const start = Date.now();
				({ child, getStderr } = spawnHost({
					accordionRepo, accordionHome, telemetryOut, conductor: "compaction-naive",
					attachTimeoutMs: 30_000,
					extraArgs: ["--surface-id", "test-surface-persistent"],
				}));

				const exit = await waitForExit(child, 10_000);
				const elapsedMs = Date.now() - start;

				expect(exit.code).toBe(1);
				expect(elapsedMs).toBeLessThan(5_000); // must fail fast, nowhere near the 30s attach timeout
				expect(getStderr()).toContain("controller lease");
				expect(getStderr()).toContain("test-surface-persistent");
			} finally {
				await new Promise((resolve) => lease.server.close(resolve));
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		SUITE_TIMEOUT_MS,
	);

	it(
		"fails fast pre-flight when hello marks the requested conductor unavailable — no commands are ever sent",
		async () => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-host-v22-unavailable-"));
			const accordionRepo = path.join(tmp, "accordion");
			const accordionHome = path.join(tmp, "home");
			const telemetryOut = path.join(tmp, "host.jsonl");
			const lease = makeLeaseServer();
			let child;
			let getStderr = () => "";
			try {
				makeAccordionFixture(accordionRepo, 22);
				await listen(lease.server);
				const port = lease.server.address().port;
				writeSession({ accordionHome, port, protocolVersion: 22 });

				lease.server.on("connection", (socket) => {
					sendHello(socket, {
						version: 22,
						conductorId: "thermocline",
						cwd: tmp,
						conductors: [{
							id: "thermocline",
							label: "Thermocline",
							kind: "spawn",
							readiness: { state: "unavailable", reason: "python probe binary missing", remediation: "install the thermocline python probe" },
						}],
					});
					// Deliberately never send a snapshot — the pre-flight must fatal before the
					// host would even reach the point of waiting on one.
				});

				const start = Date.now();
				({ child, getStderr } = spawnHost({ accordionRepo, accordionHome, telemetryOut, conductor: "thermocline", attachTimeoutMs: 30_000 }));

				const exit = await waitForExit(child, 10_000);
				const elapsedMs = Date.now() - start;

				expect(exit.code).toBe(1);
				expect(elapsedMs).toBeLessThan(5_000);
				expect(getStderr()).toContain("install the thermocline python probe");
				expect(lease.commands).toEqual([]);
			} finally {
				await new Promise((resolve) => lease.server.close(resolve));
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		SUITE_TIMEOUT_MS,
	);

	it(
		"fails as detached-mid-run when conductorState reports the conductor gone after attach, still sending teardown",
		async () => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-host-v22-detach-"));
			const accordionRepo = path.join(tmp, "accordion");
			const accordionHome = path.join(tmp, "home");
			const telemetryOut = path.join(tmp, "host.jsonl");
			const lease = makeLeaseServer();
			let child;
			let getStderr = () => "";
			try {
				makeAccordionFixture(accordionRepo, 22);
				await listen(lease.server);
				const port = lease.server.address().port;
				writeSession({ accordionHome, port, protocolVersion: 22 });

				lease.server.on("connection", (socket) => {
					sendHello(socket, { version: 22, conductorId: "compaction-naive", cwd: tmp });
					sendSnapshot(socket);
				});
				lease.server.on("acceptedCommand", ({ socket, commands }) => {
					if (commands.length === 4) {
						socket.send(JSON.stringify({ type: "conductorState", active: { id: "compaction-naive" } }));
						setTimeout(() => {
							socket.send(JSON.stringify({ type: "conductorState", active: null }));
						}, 50);
					}
				});

				({ child, getStderr } = spawnHost({ accordionRepo, accordionHome, telemetryOut, conductor: "compaction-naive" }));

				const exit = await waitForExit(child, 10_000);

				expect(exit.code).toBe(1);
				expect(getStderr()).toContain("detached mid-run");
				expect(lease.commands).toEqual([
					{ kind: "setBudget", value: 100000 },
					{ kind: "setProtect", value: 20000 },
					{ kind: "selectConductor", id: "compaction-naive" },
					{ kind: "setFolding", value: true },
					{ kind: "setFolding", value: false },
					{ kind: "selectConductor", id: null },
				]);
			} finally {
				await new Promise((resolve) => lease.server.close(resolve));
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		SUITE_TIMEOUT_MS,
	);
});

describe("Accordion v22 resident host — defect 1 regression (shutdown-echo false-fatal)", () => {
	// Unit-level "equivalent via the code path" coverage — see the doc comment on
	// isGenuineMidRunDetach in accordionV15.ts for why this exists alongside (not instead
	// of) the SIGTERM integration test below: the scenario this guards against can only be
	// driven end-to-end by a REAL, JS-catchable SIGTERM, and on Windows `child_process.kill()`
	// cannot deliver one (libuv maps it to a bare TerminateProcess — verified empirically,
	// see the integration test's platform guard below). This test exercises the real,
	// exported production predicate directly, on every platform including Windows, so the
	// fix is never covered on only some CI workers.
	it("isGenuineMidRunDetach treats a conductorState:null arriving while terminating as our own shutdown echo, not a fatal", () => {
		// The exact defect 1 scenario: attached, then onSignal() has set terminating=true
		// and called detach() — the extension echoes {active:null} back to the sender
		// inside the teardown window. Must NOT read as a genuine mid-run detach.
		expect(isGenuineMidRunDetach(/* terminating */ true, /* attached */ true, null, "compaction-naive")).toBe(false);
		// Same shape, but NOT terminating: a genuine mid-run detach must still fatal.
		expect(isGenuineMidRunDetach(false, true, null, "compaction-naive")).toBe(true);
		// A conductor switch mid-run (active becomes a DIFFERENT id) while terminating is
		// still ours to ignore — we're already tearing down, nothing else matters.
		expect(isGenuineMidRunDetach(true, true, { id: "handoff" }, "compaction-naive")).toBe(false);
		// Not attached yet: neither branch of the caller's switch applies regardless of
		// terminating (the other arm of the caller's if/else handles the attach case).
		expect(isGenuineMidRunDetach(false, false, null, "compaction-naive")).toBe(false);
	});

	// child_process.kill("SIGTERM")/("SIGINT") on Windows cannot deliver a JS-catchable
	// signal to a spawned child — libuv's uv_kill maps every signal Node exposes here
	// (SIGTERM, SIGINT, SIGKILL) to a bare TerminateProcess on win32, which kills the
	// target before its `process.on("SIGTERM", …)` handler ever runs. Verified empirically
	// for this repo's exact spawn shape: a minimal child that logs on catching SIGTERM and
	// installs the handler before signaling readiness never logs it when the parent calls
	// child.kill("SIGTERM") — the child just exits with signal:"SIGTERM" attached by Node's
	// own bookkeeping, having never executed the handler. This is also why the existing
	// happy-path tests' `expectGracefulExit()` already tolerates a hard-kill outcome on
	// win32 instead of asserting exit code 0. Since main-v15.ts's entire graceful-shutdown
	// path (onSignal → terminating=true → detach() → clean exit 0) is reachable ONLY
	// through a caught signal, this specific end-to-end integration test cannot run on
	// Windows at all — there is no code path left to "assert the equivalent" through at the
	// integration level; that equivalent is the unit test above, which runs unconditionally.
	const maybeIt = process.platform === "win32" ? it.skip : it;
	maybeIt(
		"SIGTERM on a clean, successful run: the extension's own conductorState:null echo does not fatal, and the host exits 0",
		async () => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-host-v22-shutdown-echo-"));
			const accordionRepo = path.join(tmp, "accordion");
			const accordionHome = path.join(tmp, "home");
			const telemetryOut = path.join(tmp, "host.jsonl");
			const lease = makeLeaseServer();
			let child;
			let getStderr = () => "";
			try {
				makeAccordionFixture(accordionRepo, 22);
				await listen(lease.server);
				const port = lease.server.address().port;
				writeSession({ accordionHome, port, protocolVersion: 22 });

				lease.server.on("connection", (socket) => {
					sendHello(socket, { version: 22, conductorId: "compaction-naive", cwd: tmp });
					sendSnapshot(socket);
				});
				lease.server.on("acceptedCommand", ({ socket, commands }) => {
					if (commands.length === 4) {
						socket.send(JSON.stringify({ type: "conductorState", active: { id: "compaction-naive" } }));
					}
					// Mirror the real extension's liveHost.select(null) (extension/accordion.ts):
					// on the teardown pair landing, broadcast the resulting conductorState back to
					// EVERY client, including the sender — this is the shutdown echo defect 1 is
					// about. Sent synchronously off the same message handler that received the
					// teardown, so it reliably lands within onSignal()'s 50ms close window.
					if (commands.length === 6) {
						socket.send(JSON.stringify({ type: "conductorState", active: null }));
					}
				});

				({ child, getStderr } = spawnHost({ accordionRepo, accordionHome, telemetryOut, conductor: "compaction-naive" }));

				await waitForFile(() => readTelemetry(telemetryOut).includes('"t":"attach"'), 18_000, "attach telemetry");

				// Drives the REAL signal path: main-v15.ts's own process.once("SIGTERM", …).
				child.kill("SIGTERM");
				const exit = await waitForExit(child, 10_000);

				expect(lease.commands).toEqual([
					{ kind: "setBudget", value: 100000 },
					{ kind: "setProtect", value: 20000 },
					{ kind: "selectConductor", id: "compaction-naive" },
					{ kind: "setFolding", value: true },
					{ kind: "setFolding", value: false },
					{ kind: "selectConductor", id: null },
				]);
				const telemetry = readTelemetry(telemetryOut);
				expect(telemetry).not.toContain("detached mid-run");
				expect(telemetry).not.toContain('"t":"error"');
				expect(getStderr()).not.toContain("detached mid-run");
				expect(exit.code).toBe(0);
			} finally {
				await new Promise((resolve) => lease.server.close(resolve));
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		SUITE_TIMEOUT_MS,
	);
});

/*
 * FIXED DEFECT (v22 adversarial review, bug #2): the "commandResult" handler's
 * `refused:"read-only"` branch bounded only the LOWER edge of the retryable
 * configure-batch window (`msg.seq < batchStartSeq`). detach()'s two teardown
 * commands (setFolding:false, selectConductor:null) are sent — via onSignal() — at
 * batchStartSeq+4 and +5, immediately after a successful attach: outside the
 * configure batch, but ABOVE the old lower-only bound, so a read-only refusal of
 * either teardown command during the ~50ms pre-close window (lease gone stale/
 * stolen) was misread as a configure-batch refusal. That both emitted a spurious
 * "t":"error" into an otherwise-clean run's telemetry AND (claimRetries still 0)
 * re-sent sendConfigureCommands() — re-arming `selectConductor:<benchmark
 * conductor>` and `setFolding:true` during the very teardown meant to disarm them
 * — or (claimRetries already 1 from an earlier retry) fatal'd a clean shutdown.
 *
 * Fix: the handler now bails out immediately `if (terminating) break;` (teardown
 * commands are only ever sent once terminating is true) AND bounds the seq window
 * on both sides (`seq < batchStartSeq || seq > batchStartSeq + 3`), so the guard
 * holds even if a teardown-like command were ever sent for a reason other than
 * terminating. The resend itself also gained a `!attached` guard as belt-and-
 * braces against a hypothetical future partial-batch-applied scenario.
 *
 * The scenario is real, JS-catchable-SIGTERM-only (same as the defect-1 regression
 * above) — child_process.kill() on Windows cannot deliver one (TerminateProcess,
 * not a signal), so main-v15.ts's onSignal()/detach() path is simply never reached
 * there. Unlike defect-1's isGenuineMidRunDetach, this guard is inline in
 * main-v15.ts's message handler rather than an exported pure predicate — extracting
 * one would mean importing main-v15.ts as a module, which unconditionally runs
 * `main()` (and eventually `process.exit()`) at import time, so it isn't a safe
 * target for a direct unit test the way accordionV15.ts's predicate is. This test
 * is therefore skipped on win32 with no unit-level fallback; the win32 CI gap is
 * identical in kind to defect-1's integration test, just without that test's
 * separate always-runs unit-test half.
 */
describe("Accordion v22 resident host — v22 regression: teardown read-only refusal must not re-arm or misreport", () => {
	const maybeIt = process.platform === "win32" ? it.skip : it;
	maybeIt(
		"SIGTERM on a clean run: the extension refusing detach()'s teardown commands as read-only does not resend the configure batch and does not emit a spurious error",
		async () => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-host-v22-teardown-refuse-"));
			const accordionRepo = path.join(tmp, "accordion");
			const accordionHome = path.join(tmp, "home");
			const telemetryOut = path.join(tmp, "host.jsonl");
			const commands = [];
			const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
			let child;
			try {
				makeAccordionFixture(accordionRepo, 22);
				await listen(server);
				const port = server.address().port;
				writeSession({ accordionHome, port, protocolVersion: 22 });

				server.on("connection", (socket) => {
					sendHello(socket, { version: 22, conductorId: "compaction-naive", cwd: tmp });
					sendSnapshot(socket);
					socket.on("message", (data) => {
						let msg;
						try { msg = JSON.parse(data.toString()); } catch { return; }
						if (msg.type !== "command") return;
						commands.push(msg.cmd);
						if (commands.length === 4) {
							socket.send(JSON.stringify({ type: "conductorState", active: { id: "compaction-naive" } }));
							return;
						}
						if (commands.length > 4) {
							// Commands 5 and 6 are detach()'s teardown pair, sent from onSignal() once
							// SIGTERM lands. Refuse them as read-only — simulating the controller
							// lease going stale/stolen inside the ~50ms pre-close window — which is
							// exactly the defect-2 trigger: the fix must not mistake this for a
							// configure-batch refusal.
							socket.send(JSON.stringify({ type: "commandResult", seq: msg.seq, results: [], rev: 0, refused: "read-only" }));
						}
					});
				});

				({ child } = spawnHost({ accordionRepo, accordionHome, telemetryOut, conductor: "compaction-naive" }));

				await waitForFile(() => readTelemetry(telemetryOut).includes('"t":"attach"'), 18_000, "attach telemetry");

				child.kill("SIGTERM");
				const exit = await waitForExit(child, 10_000);

				// Exactly six commands, ever: the configure batch once, then the teardown pair
				// once. No re-sent configure batch — which would show up as a SECOND
				// `selectConductor:"compaction-naive"`/`setFolding:true` pair appended after
				// the teardown commands — in response to the refused teardown pair.
				expect(commands).toEqual([
					{ kind: "setBudget", value: 100000 },
					{ kind: "setProtect", value: 20000 },
					{ kind: "selectConductor", id: "compaction-naive" },
					{ kind: "setFolding", value: true },
					{ kind: "setFolding", value: false },
					{ kind: "selectConductor", id: null },
				]);
				// Belt-and-braces on the assertion itself: no re-armed selectConductor at all
				// after teardown began (i.e. among commands sent after the first 4).
				expect(commands.slice(4).some((c) => c.kind === "selectConductor" && c.id === "compaction-naive")).toBe(false);

				const telemetry = readTelemetry(telemetryOut);
				expect(telemetry).not.toContain('"t":"error"');
				expect(exit.code).toBe(0);
			} finally {
				await new Promise((resolve) => server.close(resolve));
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		SUITE_TIMEOUT_MS,
	);
});

describe("Accordion resident host — protocol range validation", () => {
	it(
		"rejects a fixture whose PROTOCOL_VERSION is outside the supported range",
		async () => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-host-out-of-range-"));
			const accordionRepo = path.join(tmp, "accordion");
			const accordionHome = path.join(tmp, "home");
			const telemetryOut = path.join(tmp, "host.jsonl");
			try {
				makeAccordionFixture(accordionRepo, 23);
				// No session descriptor and no server at all — the version gate is checked
				// before session discovery ever runs, so this must fail before it would matter.

				const start = Date.now();
				const { child, getStderr } = spawnHost({ accordionRepo, accordionHome, telemetryOut, conductor: "compaction-naive", attachTimeoutMs: 30_000, timeoutMin: 1 });
				const exit = await waitForExit(child, 10_000);
				const elapsedMs = Date.now() - start;

				expect(exit.code).toBe(1);
				expect(elapsedMs).toBeLessThan(5_000);
				expect(getStderr()).toContain("outside the supported range");
			} finally {
				fs.rmSync(tmp, { recursive: true, force: true });
			}
		},
		SUITE_TIMEOUT_MS,
	);
});
