/*
 * Bellows control client for Accordion's truth-in-extension protocol (v15).
 *
 * Unlike the legacy sync/plan host, this process does not execute a conductor.
 * It connects as a native GUI-role client, sets the run's dials, asks the
 * extension to attach the selected resident conductor, enables folding, and
 * mirrors Truth events only to produce benchmark telemetry.
 */
import WebSocket from "ws";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Telemetry } from "./telemetry";
import { loadAccordionV15, type TruthReplica } from "./accordionV15";

const STALE_AFTER_MS = 15_000;
const ATTACH_TIMEOUT_MS = 30_000;

interface Args {
	accordionHome: string;
	conductor: string;
	budget: number;
	protect: number;
	telemetryOut: string;
	timeoutMin: number;
	attachTimeoutMs: number;
}

interface SessionEntry {
	sessionId: string;
	port: number;
	heartbeatAt: number;
	protocolVersion: number;
}

function scriptArgs(): string[] {
	const argv = process.argv.slice(2);
	const dd = argv.indexOf("--");
	return dd >= 0 ? argv.slice(dd + 1) : argv;
}

function parseArgs(argv: string[]): Args {
	const map = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith("--")) continue;
		const key = argv[i].slice(2);
		map.set(key, argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true");
	}
	const need = (key: string) => {
		const value = map.get(key);
		if (value === undefined) throw new Error(`bellows v15 host: missing required --${key}`);
		return value;
	};
	const number = (key: string, value: string) => {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) throw new Error(`bellows v15 host: --${key} must be a number (got ${value})`);
		return parsed;
	};
	if (map.has("conductor-url") || map.has("conductor-id")) {
		throw new Error("bellows v15 host: external conductor launch flags are obsolete; select the resident conductor by id");
	}
	return {
		accordionHome: need("accordion-home"),
		conductor: need("conductor"),
		budget: number("budget", need("budget")),
		protect: number("protect", need("protect")),
		telemetryOut: need("telemetry-out"),
		timeoutMin: map.has("timeout-min") ? number("timeout-min", map.get("timeout-min")!) : 30,
		attachTimeoutMs: map.has("attach-timeout-ms")
			? number("attach-timeout-ms", map.get("attach-timeout-ms")!)
			: ATTACH_TIMEOUT_MS,
	};
}

function findSession(accordionHome: string): SessionEntry | null {
	const dir = path.join(accordionHome, ".accordion", "sessions");
	if (!existsSync(dir)) return null;
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return null;
	}
	const now = Date.now();
	const live: SessionEntry[] = [];
	for (const file of files) {
		try {
			const entry = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
			if (
				typeof entry.sessionId === "string" &&
				typeof entry.port === "number" &&
				entry.port > 0 &&
				typeof entry.heartbeatAt === "number" &&
				now - entry.heartbeatAt <= STALE_AFTER_MS
			) live.push(entry);
		} catch {
			/* half-written descriptor */
		}
	}
	live.sort((a, b) => b.heartbeatAt - a.heartbeatAt);
	return live[0] ?? null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
	const args = parseArgs(scriptArgs());
	const tel = new Telemetry(args.telemetryOut);
	const accordion = await loadAccordionV15();
	const deadline = Date.now() + args.timeoutMin * 60_000;

	if (accordion.PROTOCOL_VERSION !== 15) {
		tel.emit({ t: "error", at: Date.now(), message: `v15 controller loaded Accordion protocol v${accordion.PROTOCOL_VERSION}` });
		await tel.close();
		throw new Error(`bellows v15 host: expected Accordion protocol v15, got v${accordion.PROTOCOL_VERSION}`);
	}
	const registryEntry = accordion.ENTRIES.find((entry) => entry.id === args.conductor && entry.kind !== "none");
	if (!registryEntry) {
		const ids = accordion.ENTRIES.filter((entry) => entry.kind !== "none").map((entry) => entry.id).join(", ");
		tel.emit({ t: "error", at: Date.now(), message: `unknown conductor "${args.conductor}" (available: ${ids})` });
		await tel.close();
		throw new Error(`bellows v15 host: unknown conductor "${args.conductor}" — available: ${ids}`);
	}

	let session: SessionEntry | null = null;
	while (Date.now() < deadline && !session) {
		session = findSession(args.accordionHome);
		if (!session) await sleep(250);
	}
	if (!session) {
		tel.emit({ t: "error", at: Date.now(), message: "no session descriptor appeared before timeout" });
		await tel.close();
		throw new Error("bellows v15 host: no session descriptor appeared before timeout");
	}
	if (session.protocolVersion !== accordion.PROTOCOL_VERSION) {
		tel.emit({ t: "error", at: Date.now(), message: `registry protocol mismatch — session v${session.protocolVersion}, controller v${accordion.PROTOCOL_VERSION}` });
		await tel.close();
		throw new Error(`bellows v15 host: session advertises protocol v${session.protocolVersion}`);
	}

	let ws: WebSocket | null = null;
	let replica: TruthReplica | null = null;
	let meta = { format: "pi" as const, title: "", cwd: "", model: "" };
	let commandSeq = 0;
	let attached = false;
	let helloSeen = false;
	let terminating = false;
	let fatal: Error | null = null;
	let attachTimer: ReturnType<typeof setTimeout> | null = null;
	let lastHookCount = 0;
	let lastHoldTimeouts = 0;
	let configured = false;

	const sendCommand = (cmd: Record<string, unknown>) => {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify({ type: "command", seq: ++commandSeq, cmd }));
	};
	const emitSnapshot = () => {
		if (!replica) return;
		const stats = replica.stats();
		tel.emit({
			t: "sync",
			at: Date.now(),
			rev: stats.rev,
			blocks: replica.blocks.length,
			liveTokens: stats.liveTokens,
			foldedBlocks: replica.foldedCount(),
		});
	};
	const detach = () => {
		if (ws?.readyState === WebSocket.OPEN) {
			sendCommand({ kind: "setFolding", value: false });
			sendCommand({ kind: "selectConductor", id: null });
		}
	};
	const beginFatal = (error: Error) => {
		if (fatal) return;
		fatal = error;
		tel.emit({ t: "error", at: Date.now(), message: error.message });
		// Resident v15 conductors outlive this GUI socket. If Bellows changed
		// extension state, restore it before closing so failure cannot leave the
		// rest of the pi run armed with a benchmark conductor.
		if (configured) detach();
		setTimeout(() => ws?.close(), 50).unref?.();
	};
	const sigterm = () => onSignal("SIGTERM");
	const sigint = () => onSignal("SIGINT");
	process.once("SIGTERM", sigterm);
	process.once("SIGINT", sigint);

	const done = await new Promise<"closed" | "fatal">((resolve) => {
		const socket = new WebSocket(`ws://127.0.0.1:${session!.port}/?role=gui`);
		ws = socket;
		socket.on("message", (data: WebSocket.RawData) => {
			let raw: unknown;
			try { raw = JSON.parse(data.toString()); } catch { return; }
			if (!accordion.isServerMessage(raw)) return;
			const msg = raw as any;
			try {
				switch (msg.type) {
				case "hello": {
					if (msg.protocolVersion !== accordion.PROTOCOL_VERSION || msg.role !== "gui") {
						beginFatal(new Error(`protocol/role mismatch — expected v15 gui, got v${msg.protocolVersion} ${msg.role}`));
						return;
					}
					const available = Array.isArray(msg.conductors) ? msg.conductors.map((c: any) => c?.id) : [];
					if (!available.includes(args.conductor)) {
						beginFatal(new Error(`extension did not advertise conductor "${args.conductor}" (available: ${available.join(", ")})`));
						return;
					}
					helloSeen = true;
					meta = { format: "pi", title: msg.meta?.title || "", cwd: msg.meta?.cwd || "", model: msg.meta?.model || "" };
					break;
				}
				case "snapshot": {
					if (!helloSeen || !msg.state) return;
					replica = accordion.hydrateSnapshot(meta, msg.state);
					emitSnapshot();
					if (!configured) {
						configured = true;
						// Ordered commands: establish dials first, attach the conductor against those
						// dials, then opt this benchmark session into folding.
						sendCommand({ kind: "setBudget", value: args.budget });
						sendCommand({ kind: "setProtect", value: args.protect });
						sendCommand({ kind: "selectConductor", id: args.conductor });
						sendCommand({ kind: "setFolding", value: true });
						attachTimer = setTimeout(() => {
							if (attached) return;
							beginFatal(new Error(`conductor "${args.conductor}" did not become active within ${args.attachTimeoutMs}ms`));
						}, args.attachTimeoutMs);
					}
					break;
				}
				case "event": {
					if (!replica || !msg.event) return;
					if (msg.event.kind === "reset") {
						socket.send(JSON.stringify({ type: "resnapshot" }));
						return;
					}
					accordion.applyWireEvent(replica, msg.event);
					if (replica.rev !== msg.event.rev) socket.send(JSON.stringify({ type: "resnapshot" }));
					if (msg.event.kind === "ops" && msg.event.by === "auto") {
						const ops = Array.isArray(msg.event.ops) ? msg.event.ops : [];
						const groups = ops.filter((op: any) => op?.kind === "group").length;
						tel.emit({ t: "plan", at: Date.now(), rev: msg.event.rev, ops: ops.length - groups, groups });
					}
					emitSnapshot();
					break;
				}
				case "conductorState": {
					if (msg.active?.id === args.conductor && !attached) {
						attached = true;
						if (attachTimer) clearTimeout(attachTimer);
						tel.emit({ t: "attach", at: Date.now(), sessionId: session!.sessionId, conductor: args.conductor, budget: args.budget, protectTokens: args.protect });
						tel.emit({ t: "info", at: Date.now(), message: `Accordion v15 resident conductor active: ${args.conductor}` });
					}
					break;
				}
				case "conductorStatus":
					if (typeof msg.text === "string" && msg.text) tel.emit({ t: "info", at: Date.now(), message: `status: ${msg.text}` });
					break;
				case "telemetry": {
					if (typeof msg.hookCount === "number" && msg.hookCount > lastHookCount) {
						const holdTimeouts = Number(msg.holdTimeouts) || 0;
						lastHookCount = msg.hookCount;
						tel.emit({ t: "conduct", at: Date.now(), rev: replica?.rev ?? 0, latencyMs: Number(msg.lastHookMs) || 0, commands: 0, heldLastPlan: holdTimeouts > lastHoldTimeouts });
						lastHoldTimeouts = holdTimeouts;
					}
					break;
				}
				}
			} catch (error) {
				beginFatal(new Error(`v15 message handling failed: ${error instanceof Error ? error.message : String(error)}`));
			}
		});
		socket.on("error", (error: Error) => beginFatal(new Error(`ws: ${error.message}`)));
		socket.on("close", () => {
			if (!terminating && !fatal) {
				fatal = new Error("Accordion v15 session socket closed unexpectedly");
				tel.emit({ t: "error", at: Date.now(), message: fatal.message });
			}
			resolve(fatal ? "fatal" : "closed");
		});
	});

	if (attachTimer) clearTimeout(attachTimer);
	process.removeListener("SIGTERM", sigterm);
	process.removeListener("SIGINT", sigint);
	if (!terminating) tel.emit({ t: "detach", at: Date.now(), reason: done === "fatal" ? "fatal" : "session-closed" });
	await tel.close();
	if (fatal) throw fatal;
	if (!attached) throw new Error("bellows v15 host: conductor never attached");
	return 0;

	function onSignal(signal: string): void {
		if (terminating) return;
		terminating = true;
		tel.emit({ t: "detach", at: Date.now(), reason: signal });
		detach();
		setTimeout(() => ws?.close(), 50).unref?.();
	}
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		console.error(`[bellows-host-v15] ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
