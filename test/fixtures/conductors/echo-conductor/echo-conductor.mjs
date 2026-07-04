#!/usr/bin/env node
// echo-conductor.mjs — a tiny, dependency-free (beyond `ws`) EXTERNAL conductor fixture
// for bellows' external-conductor tests and manual smoke-testing.
//
// Policy (deliberately trivial — this is a protocol fixture, not a real strategy):
//   On every context/update, fold the SINGLE LARGEST `tool_result` block that is not
//   already protected (inside the host's protected working tail) and not already held
//   by a human override. If none qualifies, emit no commands (clear/hold).
//
// Speaks conductor wire protocol v3 (Accordion conductors/contract/protocol.ts):
//   conductor/hello -> host/hello -> context/update <-> conductor/commands ->
//   host/commandResult, plus cap/request (echoed back trivially) and conductor/status.
//
// Discovery: like thermocline.mjs / attention-folder.mjs, this process HOSTS the
// WebSocket server and advertises itself under $ACCORDION_HOME/.accordion/conductors/
// <id>.json (registry.ts's ConductorEntry shape) so bellows' runner can find it after
// spawning it from a launch.json. Supports an optional portEnv (read from launch.json)
// so it can run in parallel across arms/runs without a fixed-port collision — see
// test/fixtures/echo-conductor.launch.json.
//
// Run standalone:  node echo-conductor.mjs
//   env ECHO_PORT (or the launch.json-declared portEnv) picks the port; default 7799.
//   env ACCORDION_HOME picks the heartbeat directory; default ~/.accordion.

import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

export const ID = "echo-conductor";
export const LABEL = "Echo Conductor (fixture)";
const CONDUCTOR_PROTOCOL_VERSION = 3;

/** Pick the single largest non-protected, non-held tool_result block. */
export function pickFoldTarget(blocks) {
	let best = null;
	for (const b of blocks) {
		if (b.kind !== "tool_result") continue;
		if (b.protected || b.held || b.folded || b.grouped) continue;
		if (!best || b.tokens > best.tokens) best = b;
	}
	return best;
}

/** Pure: build the conductor/commands payload for a view. Exported for unit tests. */
export function planFor(view) {
	const target = pickFoldTarget(view.blocks ?? []);
	if (!target) return [];
	return [{ kind: "fold", ids: [target.id] }];
}

function log(msg) {
	process.stderr.write(`[echo-conductor] ${msg}\n`);
}

/**
 * Start the echo-conductor WS server + heartbeat advertisement.
 * @param {object} [opts]
 * @param {number} [opts.port]            fixed port (0 = OS-assigned ephemeral)
 * @param {string} [opts.accordionHome]   heartbeat dir root (default: env or homedir)
 * @param {boolean} [opts.heartbeat]      advertise a heartbeat file (default true)
 * @returns {Promise<{ url:string, port:number, wss:import("ws").WebSocketServer, stop:()=>Promise<void> }>}
 */
export async function startEchoConductor(opts = {}) {
	const port = opts.port ?? Number(process.env.ECHO_PORT || 0);
	const wss = new WebSocketServer({ host: "127.0.0.1", port });
	await new Promise((resolve) => wss.on("listening", resolve));
	const actualPort = wss.address().port;
	const url = `ws://127.0.0.1:${actualPort}`;

	const accordionHome = opts.accordionHome ?? process.env.ACCORDION_HOME ?? homedir();
	const regDir = join(accordionHome, ".accordion", "conductors");
	const regFile = join(regDir, `${ID}.json`);
	const startedAt = Date.now();
	let hbTimer = null;

	function advertise() {
		mkdirSync(regDir, { recursive: true });
		const entry = {
			registryProtocol: 1,
			conductorProtocol: CONDUCTOR_PROTOCOL_VERSION,
			id: ID,
			label: LABEL,
			url,
			pid: process.pid,
			startedAt,
			heartbeatAt: Date.now(),
		};
		const tmp = `${regFile}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(entry, null, 2));
		renameSync(tmp, regFile);
	}

	const doHeartbeat = opts.heartbeat !== false;
	if (doHeartbeat) {
		advertise();
		hbTimer = setInterval(advertise, 5_000);
	}

	wss.on("connection", (ws) => onConnection(ws));

	async function stop() {
		if (hbTimer) clearInterval(hbTimer);
		try {
			rmSync(regFile, { force: true });
		} catch {
			/* already gone */
		}
		await new Promise((resolve) => wss.close(resolve));
	}

	return { url, port: actualPort, wss, stop };
}

function onConnection(ws) {
	log("host connected");
	let rev = -1;

	ws.send(
		JSON.stringify({
			type: "conductor/hello",
			conductorProtocol: CONDUCTOR_PROTOCOL_VERSION,
			id: ID,
			label: LABEL,
			wants: { content: "full" },
			// Collaborative (no locks) — this fixture never needs exclusive control, and it
			// keeps the fixture usable against the real store's held/human-override tests.
			locks: [],
		}),
	);

	ws.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}
		if (!msg || typeof msg.type !== "string") return;

		switch (msg.type) {
			case "host/hello":
				// Nothing to restore — this fixture is stateless across reconnects.
				break;
			case "context/update": {
				rev = msg.rev;
				const commands = planFor(msg);
				ws.send(JSON.stringify({ type: "conductor/commands", rev, commands }));
				break;
			}
			case "cap/request": {
				// Trivial echo answers — enough for protocol round-trip tests. A real
				// conductor would use these; this fixture doesn't need to.
				if (msg.capability === "countTokens") {
					ws.send(JSON.stringify({ type: "cap/result", reqId: msg.reqId, ok: true, value: Math.ceil((msg.text ?? "").length / 4) }));
				} else if (msg.capability === "complete") {
					ws.send(JSON.stringify({ type: "cap/result", reqId: msg.reqId, ok: false, error: "echo-conductor does not implement complete" }));
				} else {
					ws.send(JSON.stringify({ type: "cap/result", reqId: msg.reqId, ok: false, error: `unsupported capability ${msg.capability}` }));
				}
				break;
			}
			case "host/commandResult":
				if (msg.reports?.length) {
					for (const r of msg.reports) log(`clamp: ${JSON.stringify(r)}`);
				}
				break;
			case "host/event":
				log(`event: ${msg.event} ids=${(msg.ids ?? []).join(",")}`);
				break;
			default:
				break;
		}
	});

	ws.on("close", () => log("host disconnected"));
}

// ── standalone entrypoint (node echo-conductor.mjs) ──────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const { url } = await startEchoConductor({});
	log(`listening at ${url}`);
	process.on("SIGINT", () => process.exit(0));
	process.on("SIGTERM", () => process.exit(0));
}
