/*
 * mock-extension.mjs — a minimal stand-in for the pi extension's WS server, for the host test.
 *
 * Adapted from extension/mock-server.mjs (the accordion checkout), trimmed to exactly what
 * the host's smoke test needs and made programmatically drivable rather than browser-driven:
 *
 *   • binds a plain HTTP server (WS upgrades handled by the same server) on 127.0.0.1 on an
 *     OS-chosen ephemeral port — mirrors the real extension's topology (WS + `/__accordion/meta`
 *     on one port);
 *   • writes a session descriptor to <accordionHome>/.accordion/sessions/<id>.json (+ heartbeat)
 *     so the host's discovery poll finds it exactly as it finds a real pi session;
 *   • on connect: sends `hello` (configurable protocolVersion, default 5, recording
 *     `helloSentAt`), then a `full` sync with a batch of blocks;
 *   • records every `plan` reply the host sends, with a receive timestamp (for cadence checks);
 *   • answers `completeRequest` with junk (so an LLM conductor doesn't hang);
 *   • accepts `{type:"armed"}` and replies `{type:"armedAck", armed}` (records receipt so
 *     tests can assert the round-trip; `swallowArmed: true` disables the reply to exercise
 *     the host's ack watchdog);
 *   • exposes `sendPassthrough({reqId, cause, ops, groups, recalls})` to push a `passthrough`
 *     ack to the host (omitting `recalls` for protocol v9+, where that field was removed),
 *     and serves `planOutcomes` counters
 *     over `GET /__accordion/meta` (mutable via `bumpMetaCause`/`setMetaPlanOutcomes`) so the
 *     host's meta-snapshot fetch (src/host/main.ts `fetchMetaPlanOutcomes`) has something real
 *     to hit;
 *   • exposes `sync(blocks, {full})` to push further syncs, and `close()` to end the session.
 *
 * The block generator produces a set that is comfortably OVER the host's budget so the
 * built-in conductor MUST fold — proving the plan carries fold ops.
 */
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_PROTOCOL_VERSION = 5;
const HEARTBEAT_MS = 3000;
const ALL_PLAN_OUTCOME_CAUSES = ["applied", "empty-plan", "timeout-stale", "timeout-raw", "no-gui", "epoch-mismatch", "unsent"];

/** Build a batch of wire blocks that far exceeds a small budget so folding is forced. */
export function makeBlocks(count, startTs = 1_000_000) {
	const blocks = [];
	let ts = startTs;
	let turn = 0;
	let order = 0;
	for (let i = 0; i < count; i++) {
		turn += 1;
		// user block
		blocks.push({
			id: `u:${ts}`,
			kind: "user",
			turn,
			order: order++,
			text: `user question number ${i} — ` + "lorem ipsum ".repeat(20),
			tokens: 60,
		});
		ts += 1;
		// assistant text block (foldable, durable a: id)
		blocks.push({
			id: `a:resp-${i}:p0`,
			kind: "text",
			turn,
			order: order++,
			text: `assistant reply ${i} — ` + "detailed explanation ".repeat(60),
			tokens: 200,
			model: "mock/model",
		});
		ts += 1;
		// tool_result block (foldable, durable r: id)
		blocks.push({
			id: `r:call-${i}`,
			kind: "tool_result",
			turn,
			order: order++,
			text: `TOOL OUTPUT ${i} — ` + "row of data ".repeat(80),
			tokens: 260,
			toolName: "grep",
			callId: `call-${i}`,
		});
		ts += 1;
	}
	return blocks;
}

export class MockExtension {
	constructor({
		accordionHome,
		sessionId = `mock-${process.pid}`,
		contextWindow = 200_000,
		junk = "[stub completion]",
		swallowArmed = false,
		protocolVersion = DEFAULT_PROTOCOL_VERSION,
		hangMeta = false,
	}) {
		this.accordionHome = accordionHome;
		this.sessionId = sessionId;
		this.contextWindow = contextWindow;
		this.junk = junk;
		// When true, an incoming `{type:"armed"}` is recorded but never acked — simulates an
		// old extension that predates armed-over-wire, for exercising the host's watchdog.
		this.swallowArmed = swallowArmed;
		// When true, `GET /__accordion/meta` never completes: it sends 200 headers then
		// drip-feeds a byte every 100 ms forever — the socket never idles, so ONLY the
		// host's wall-clock deadline (not its idle timeout) can stop the fetch. Exercises
		// the drip-feed hang the adversarial review flagged in fetchMetaPlanOutcomes.
		this.hangMeta = hangMeta;
		// The protocolVersion this mock declares on `hello` (and in its session descriptor) —
		// configurable so the host's handshake tests can dial v5/v6/v7/v8/v9 without
		// separate mock classes.
		this.protocolVersion = protocolVersion;
		this.plans = []; // { reqId, ops, groups, at }
		this.completions = []; // { reqId, at }
		this.armedMessages = []; // { armed, at }
		this.passthroughsSent = []; // { reqId, cause, ops, groups, recalls?, at } — mock -> host
		this.helloSentAt = null; // timestamp of the `hello` frame this mock sent, for ordering checks
		this.client = null;
		this.reqId = 0;
		this._onPlan = null;
		// `/__accordion/meta`'s planOutcomes counters (Accordion issue #60/#22, ADR 0020) —
		// all 7 causes always present (initialized 0), mirroring the real extension's shape.
		// Mutate via bumpMetaCause()/setMetaPlanOutcomes() between the host's start/end fetches
		// to simulate the extension's lifetime counters advancing during a run.
		this.metaPlanOutcomes = Object.fromEntries(ALL_PLAN_OUTCOME_CAUSES.map((c) => [c, 0]));
	}

	async start() {
		this.httpServer = createServer((req, res) => this._handleHttp(req, res));
		this.wss = new WebSocketServer({ server: this.httpServer });
		await new Promise((resolve) => this.httpServer.listen(0, "127.0.0.1", resolve));
		this.port = this.httpServer.address().port;

		this.sessionsDir = path.join(this.accordionHome, ".accordion", "sessions");
		fs.mkdirSync(this.sessionsDir, { recursive: true });
		this.entryPath = path.join(this.sessionsDir, this.sessionId + ".json");
		this._writeEntry();
		this._hb = setInterval(() => this._writeEntry(), HEARTBEAT_MS);

		this.wss.on("connection", (ws) => {
			this.client = ws;
			ws.send(JSON.stringify({
				type: "hello",
				protocolVersion: this.protocolVersion,
				sessionId: this.sessionId,
				meta: { title: "mock session", cwd: "/mock", model: "mock/model", contextWindow: this.contextWindow, format: "pi" },
			}));
			this.helloSentAt = Date.now();
			ws.on("message", (d) => {
				let m;
				try {
					m = JSON.parse(d.toString());
				} catch {
					return;
				}
				if (m.type === "plan") {
					const rec = { reqId: m.reqId, ops: m.ops ?? [], groups: m.groups ?? [], at: Date.now() };
					this.plans.push(rec);
					if (this._onPlan) this._onPlan(rec);
				} else if (m.type === "completeRequest") {
					this.completions.push({ reqId: m.reqId, at: Date.now() });
					ws.send(JSON.stringify({ type: "completeResult", reqId: m.reqId, ok: true, text: this.junk, model: "mock/model", inputTokens: 10, outputTokens: 5 }));
				} else if (m.type === "armed") {
					this.armedMessages.push({ armed: m.armed, at: Date.now() });
					if (!this.swallowArmed) {
						ws.send(JSON.stringify({ type: "armedAck", armed: m.armed }));
					}
				}
				// unfoldResult / recallResult from the host: nothing to do here.
			});
		});
		return this;
	}

	/** Push a sync frame with the given wire blocks. Returns its reqId. */
	sync(blocks, { full = false } = {}) {
		const reqId = ++this.reqId;
		if (!this.client) throw new Error("mock: no client connected");
		this.client.send(JSON.stringify({ type: "sync", reqId, full, blocks, contextWindow: this.contextWindow }));
		return reqId;
	}

	/** Resolve once a plan reply for `reqId` arrives (or reject on timeout). */
	waitForPlan(reqId, timeoutMs = 4000) {
		const existing = this.plans.find((p) => p.reqId === reqId);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => {
				this._onPlan = null;
				reject(new Error(`mock: timed out waiting for plan reqId=${reqId}`));
			}, timeoutMs);
			this._onPlan = (rec) => {
				if (rec.reqId === reqId) {
					clearTimeout(t);
					this._onPlan = null;
					resolve(rec);
				}
			};
		});
	}

	/**
	 * Send a `passthrough` ack (mock -> host direction; Accordion issue #60/#22, ADR 0020) —
	 * mirrors what the real extension sends after every `context` hook resolution.
	 */
	sendPassthrough({ reqId, cause, ops = 0, groups = 0, recalls = 0 }) {
		if (!this.client) throw new Error("mock: no client connected");
		const rec = {
			reqId,
			cause,
			ops,
			groups,
			...(this.protocolVersion < 9 ? { recalls } : {}),
			at: Date.now(),
		};
		this.passthroughsSent.push(rec);
		this.client.send(JSON.stringify({ type: "passthrough", ...rec }));
		return rec;
	}

	/** Bump one `/__accordion/meta` planOutcomes cause by `by` (default 1) and the total. */
	bumpMetaCause(cause, by = 1) {
		this.metaPlanOutcomes[cause] = (this.metaPlanOutcomes[cause] ?? 0) + by;
	}

	/**
	 * Replace the whole `/__accordion/meta` planOutcomes object (missing causes stay 0).
	 * `total` is always DERIVED (see `_metaTotal`), so a stray `total` key in `partial` is
	 * ignored rather than stored — only the 7 real cause keys are meaningful input.
	 */
	setMetaPlanOutcomes(partial) {
		const base = Object.fromEntries(ALL_PLAN_OUTCOME_CAUSES.map((c) => [c, 0]));
		for (const c of ALL_PLAN_OUTCOME_CAUSES) {
			if (typeof partial[c] === "number") base[c] = partial[c];
		}
		this.metaPlanOutcomes = base;
	}

	_metaTotal() {
		return ALL_PLAN_OUTCOME_CAUSES.reduce((sum, c) => sum + (this.metaPlanOutcomes[c] ?? 0), 0);
	}

	/** Plain HTTP handler alongside the WS upgrade — mirrors the real extension's
	 *  ungated `GET /__accordion/meta` (src/host/main.ts `fetchMetaPlanOutcomes` polls this). */
	_handleHttp(req, res) {
		let pathname = "/";
		try {
			pathname = new URL(req.url, "http://127.0.0.1").pathname;
		} catch {
			/* malformed URL: fall through to 404 below */
		}
		if (pathname === "/__accordion/meta") {
			if (this.hangMeta) {
				// Drip-feed forever: the connection never idles and never ends. The host's
				// wall-clock deadline must destroy the request; that destroy fires "close"
				// here, which stops the drip so the mock can still shut down cleanly.
				res.writeHead(200, { "content-type": "application/json" });
				const drip = setInterval(() => {
					try {
						res.write(" ");
					} catch {
						clearInterval(drip);
					}
				}, 100);
				res.on("close", () => clearInterval(drip));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					served: true,
					sessionId: this.sessionId,
					protocolVersion: this.protocolVersion,
					planOutcomes: { ...this.metaPlanOutcomes, total: this._metaTotal() },
				}),
			);
			return;
		}
		res.writeHead(404);
		res.end();
	}

	_writeEntry() {
		try {
			fs.writeFileSync(
				this.entryPath,
				JSON.stringify({
					registryProtocol: 1,
					protocolVersion: this.protocolVersion,
					sessionId: this.sessionId,
					port: this.port,
					pid: process.pid,
					cwd: "/mock",
					title: "mock session",
					model: "mock/model",
					tokens: null,
					contextWindow: this.contextWindow,
					startedAt: Date.now(),
					heartbeatAt: Date.now(),
				}),
			);
		} catch {
			/* best-effort */
		}
	}

	/**
	 * End the pi-wire session (close the WS connection + stop accepting new WS upgrades,
	 * unlink the session descriptor) WITHOUT tearing down the HTTP server — so
	 * `GET /__accordion/meta` keeps working after "session end", exactly like the host's
	 * detach/shutdown-time meta fetch (src/host/main.ts `snapshotMetaEnd`) needs it to.
	 * Split out from `close()` so a test can assert on the host's post-session-end behavior
	 * before finally tearing down the mock's HTTP server too.
	 */
	async endSession() {
		clearInterval(this._hb);
		try {
			fs.unlinkSync(this.entryPath);
		} catch {
			/* already gone */
		}
		if (this.client) {
			try {
				this.client.close();
			} catch {
				/* ignore */
			}
		}
		// `wss` was built on top of `httpServer` (the `server:` option) — ws does NOT close a
		// server it doesn't own, so the http server survives this and keeps serving
		// `/__accordion/meta` until `close()` explicitly closes it too.
		await new Promise((resolve) => this.wss.close(resolve));
	}

	async close() {
		await this.endSession();
		// A hangMeta drip (or any straggling keep-alive request) holds its connection open,
		// and http.Server.close() waits for open connections — sever them so close resolves.
		this.httpServer.closeAllConnections?.();
		await new Promise((resolve) => this.httpServer.close(resolve));
	}
}
