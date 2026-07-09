/*
 * mock-extension.mjs — a minimal stand-in for the pi extension's WS server, for the host test.
 *
 * Adapted from extension/mock-server.mjs (the accordion checkout), trimmed to exactly what
 * the host's smoke test needs and made programmatically drivable rather than browser-driven:
 *
 *   • binds a WS server on 127.0.0.1 on an OS-chosen ephemeral port;
 *   • writes a session descriptor to <accordionHome>/.accordion/sessions/<id>.json (+ heartbeat)
 *     so the host's discovery poll finds it exactly as it finds a real pi session;
 *   • on connect: sends `hello` (protocol v5, recording `helloSentAt`), then a `full` sync
 *     with a batch of blocks;
 *   • records every `plan` reply the host sends, with a receive timestamp (for cadence checks);
 *   • answers `completeRequest` with junk (so an LLM conductor doesn't hang);
 *   • accepts `{type:"armed"}` and replies `{type:"armedAck", armed}` (records receipt so
 *     tests can assert the round-trip; `swallowArmed: true` disables the reply to exercise
 *     the host's ack watchdog);
 *   • exposes `sync(blocks, {full})` to push further syncs, and `close()` to end the session.
 *
 * The block generator produces a set that is comfortably OVER the host's budget so the
 * built-in conductor MUST fold — proving the plan carries fold ops.
 */
import { WebSocketServer } from "ws";
import * as fs from "node:fs";
import * as path from "node:path";

const PROTOCOL_VERSION = 5;
const HEARTBEAT_MS = 3000;

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
	constructor({ accordionHome, sessionId = `mock-${process.pid}`, contextWindow = 200_000, junk = "[stub completion]", swallowArmed = false }) {
		this.accordionHome = accordionHome;
		this.sessionId = sessionId;
		this.contextWindow = contextWindow;
		this.junk = junk;
		// When true, an incoming `{type:"armed"}` is recorded but never acked — simulates an
		// old extension that predates armed-over-wire, for exercising the host's watchdog.
		this.swallowArmed = swallowArmed;
		this.plans = []; // { reqId, ops, groups, at }
		this.completions = []; // { reqId, at }
		this.armedMessages = []; // { armed, at }
		this.helloSentAt = null; // timestamp of the `hello` frame this mock sent, for ordering checks
		this.client = null;
		this.reqId = 0;
		this._onPlan = null;
	}

	async start() {
		this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await new Promise((resolve) => this.wss.on("listening", resolve));
		this.port = this.wss.address().port;

		this.sessionsDir = path.join(this.accordionHome, ".accordion", "sessions");
		fs.mkdirSync(this.sessionsDir, { recursive: true });
		this.entryPath = path.join(this.sessionsDir, this.sessionId + ".json");
		this._writeEntry();
		this._hb = setInterval(() => this._writeEntry(), HEARTBEAT_MS);

		this.wss.on("connection", (ws) => {
			this.client = ws;
			ws.send(JSON.stringify({
				type: "hello",
				protocolVersion: PROTOCOL_VERSION,
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

	_writeEntry() {
		try {
			fs.writeFileSync(
				this.entryPath,
				JSON.stringify({
					registryProtocol: 1,
					protocolVersion: PROTOCOL_VERSION,
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

	async close() {
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
		await new Promise((resolve) => this.wss.close(resolve));
	}
}
