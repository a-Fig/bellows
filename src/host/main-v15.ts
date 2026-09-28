/*
 * Bellows control client for Accordion's truth-in-extension protocol (v15-v22).
 *
 * Unlike the legacy sync/plan host, this process does not execute a conductor.
 * It connects as a native GUI-role client, sets the run's dials, asks the
 * extension to attach the selected resident conductor, enables folding, and
 * mirrors Truth events only to produce benchmark telemetry.
 *
 * The filename is retained as "main-v15" despite supporting through v22 — a
 * live worker (see bellows-worker-update-procedure) references this path, and
 * renaming it would require a coordinated deploy. The supported range lives in
 * accordionV15.ts's MIN/MAX_SUPPORTED_PROTOCOL constants, not the filename.
 */
import WebSocket from "ws";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Telemetry } from "./telemetry";
import { loadAccordionV15, isGenuineMidRunDetach, MIN_SUPPORTED_PROTOCOL, MAX_SUPPORTED_PROTOCOL, type TruthReplica, type HelloConductorEntry } from "./accordionV15";

const STALE_AFTER_MS = 15_000;
const ATTACH_TIMEOUT_MS = 30_000;
// v16 introduced the single-controller lease: a GUI socket must claim it or every
// mutating command is silently refused (see the claimController handling below).
const CONTROLLER_PROTOCOL_MIN = 16;
// v21 introduced per-conductor readiness on the hello message.
const READINESS_PROTOCOL_MIN = 21;
// One retry: enough to recover from a lease we lost to a stale reconnect race,
// not so many that a genuinely-foreign holder drags us out to the 30s
// attach-timeout instead of failing fast. Bounding this is what makes the
// read-only recovery path fail CLOSED — once the bound is spent the run fatals
// rather than resending forever against a lease it is never going to win.
const CLAIM_RETRY_LIMIT = 1;
const SURFACE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

interface Args {
	accordionHome: string;
	conductor: string;
	budget: number;
	protect: number;
	telemetryOut: string;
	timeoutMin: number;
	attachTimeoutMs: number;
	surfaceId: string;
	surfaceLabel: string;
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
	// --surface-id/--surface-label exist for test determinism; production runs rely
	// on the generated default. The default is built from pid+random bytes rather
	// than the run label because labels are "<trial>/<arm>/<seed>" — the "/" would
	// fail SURFACE_ID_RE below and a caller-supplied bad surface must throw, so a
	// silently-invalid label-derived surface is exactly the failure mode we avoid.
	const surfaceId = map.has("surface-id") ? map.get("surface-id")! : `bellows-${process.pid}-${randomBytes(6).toString("hex")}`;
	if (!SURFACE_ID_RE.test(surfaceId)) {
		throw new Error(`bellows v15 host: --surface-id "${surfaceId}" is invalid — must match ${SURFACE_ID_RE} (max 64 chars); a socket with an invalid surface can never hold the controller lease`);
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
		surfaceId,
		surfaceLabel: map.has("surface-label") ? map.get("surface-label")! : "Bellows bench",
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

	if (accordion.PROTOCOL_VERSION < MIN_SUPPORTED_PROTOCOL || accordion.PROTOCOL_VERSION > MAX_SUPPORTED_PROTOCOL) {
		const message = `bellows host: Accordion protocol v${accordion.PROTOCOL_VERSION} is outside the supported range v${MIN_SUPPORTED_PROTOCOL}-v${MAX_SUPPORTED_PROTOCOL} (see core/protocol.ts History block)`;
		tel.emit({ t: "error", at: Date.now(), message });
		await tel.close();
		throw new Error(message);
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
	let claimRetries = 0;
	let configureTimer: ReturnType<typeof setTimeout> | null = null;

	const sendCommand = (cmd: Record<string, unknown>): number | null => {
		if (!ws || ws.readyState !== WebSocket.OPEN) return null;
		const seq = ++commandSeq;
		ws.send(JSON.stringify({ type: "command", seq, cmd }));
		return seq;
	};

	// The four configure commands, in the order they must be applied: establish the
	// dials first, attach the conductor against those dials, then opt this benchmark
	// session into folding. `setFolding:true` is LAST and is the one that actually
	// makes this a conducted arm — a run missing it attaches, syncs and completes while
	// folding nothing, i.e. a raw baseline mislabelled as a conducted arm.
	const configurePlan: Record<string, unknown>[] = [
		{ kind: "setBudget", value: args.budget },
		{ kind: "setProtect", value: args.protect },
		{ kind: "selectConductor", id: args.conductor },
		{ kind: "setFolding", value: true },
	];
	// Per-command send/ack bookkeeping, indexed alongside configurePlan.
	//   configureSeq[i]   the `seq` of the most recent SEND of configurePlan[i] (0 = not
	//                     currently outstanding — never sent, or the send never left the
	//                     socket). Commands carry seq >= 1, so 0 correlates to nothing.
	//   configureAcked[i] true once a `commandResult` for THAT exact seq came back
	//                     WITHOUT refused:"read-only" — i.e. the extension reached
	//                     applyCommand for it (extension/accordion.ts ~line 1980).
	//
	// This is per-command state on purpose. `attached` is NOT a proxy for "the batch was
	// applied": `attached` only proves selectConductor (index 2) landed, and says nothing
	// about setFolding (index 3), which is sent in a LATER WS frame and re-gated
	// independently. See the commandResult handler for the mid-batch lease flip this
	// exists to defend against.
	const configureSeq: number[] = configurePlan.map(() => 0);
	const configureAcked: boolean[] = configurePlan.map(() => false);
	const unackedConfigure = (): number[] => configurePlan.flatMap((_, i) => (configureAcked[i] ? [] : [i]));
	const describeConfigure = (indices: number[]) => indices.map((i) => String(configurePlan[i].kind)).join(", ");
	/**
	 * Send (or re-send) exactly the listed configure commands and record the seq each one
	 * went out under, so its reply can be correlated back to it. Re-sending only the
	 * UNACKNOWLEDGED subset is what makes a resend safe: `selectConductor` is destructive
	 * (it unconditionally calls detachActive(), freezing Truth as actor "you" and
	 * inheriting the conductor's tail into human protectTokens), so it must never be
	 * resent once it has been acknowledged as applied.
	 */
	const sendConfigureCommands = (indices: number[] = configurePlan.map((_, i) => i)) => {
		for (const i of indices) configureSeq[i] = sendCommand(configurePlan[i]) ?? 0;
	};
	const sendClaimController = () => {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify({ type: "claimController" }));
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

	// v15 gets a byte-identical URL to before (proves no v15 regression); v16+
	// must carry `surface` or the extension can never grant us the controller
	// lease and every mutating command below is silently refused.
	const connectUrl =
		accordion.PROTOCOL_VERSION >= CONTROLLER_PROTOCOL_MIN
			? `ws://127.0.0.1:${session.port}/?role=gui&surface=${encodeURIComponent(args.surfaceId)}&label=${encodeURIComponent(args.surfaceLabel)}`
			: `ws://127.0.0.1:${session.port}/?role=gui`;
	// No surface is ever sent to a v15 peer (see connectUrl above) — a "connecting with
	// surfaceId" line there would describe a value the wire never carries. Gate to v16+.
	if (accordion.PROTOCOL_VERSION >= CONTROLLER_PROTOCOL_MIN) {
		tel.emit({ t: "info", at: Date.now(), message: `connecting with surfaceId "${args.surfaceId}"` });
	}

	const done = await new Promise<"closed" | "fatal">((resolve) => {
		const socket = new WebSocket(connectUrl);
		ws = socket;
		socket.on("message", (data: WebSocket.RawData) => {
			let raw: unknown;
			try { raw = JSON.parse(data.toString()); } catch { return; }
			if (!accordion.isServerMessage(raw)) return;
			const msg = raw as any;
			// Once fatal is set, beginFatal() has already emitted the error and scheduled
			// the socket close — we're tearing down. Any later frame (including one of our
			// own detach() commands echoing back before the socket is actually closed, or a
			// duplicate refusal from an already-superseded batch) must not be processed: e.g.
			// a late conductorState here could re-set `attached = true` and emit a fresh
			// "t":"attach" telemetry line after the run already tore itself down and exited,
			// producing a self-contradicting stream.
			if (fatal) return;
			try {
				switch (msg.type) {
				case "hello": {
					if (msg.protocolVersion !== accordion.PROTOCOL_VERSION || msg.role !== "gui") {
						beginFatal(new Error(`protocol/role mismatch — expected v${accordion.PROTOCOL_VERSION} gui, got v${msg.protocolVersion} ${msg.role}`));
						return;
					}
					const available = Array.isArray(msg.conductors) ? msg.conductors.map((c: any) => c?.id) : [];
					if (!available.includes(args.conductor)) {
						beginFatal(new Error(`extension did not advertise conductor "${args.conductor}" (available: ${available.join(", ")})`));
						return;
					}
					// v21: a conductor can be advertised (present in `conductors[]`) yet still
					// unable to run (e.g. a spawn-kind conductor whose binary is missing). Preflight
					// this here and fail fast — selectConductor for an unavailable conductor is
					// silently ignored by the extension, which would otherwise hang to the 30s
					// attach-timeout with a misleading "did not become active" error.
					if (accordion.PROTOCOL_VERSION >= READINESS_PROTOCOL_MIN) {
						// Typed against HelloConductorEntry (accordionV15.ts) — readiness is carried
						// on THIS message's conductors[], not on the registry's ENTRIES (see that
						// type's doc comment for why the two must not be conflated).
						const conductors: HelloConductorEntry[] = Array.isArray(msg.conductors) ? msg.conductors : [];
						const entry = conductors.find((c) => c?.id === args.conductor);
						const readiness = entry?.readiness;
						// Invert to a deny-list of exactly "ready": readiness is a closed union
						// (`{state:"ready"}` or `{state:"unavailable", reason, ...}`), and anything
						// malformed or unrecognized (e.g. `{}`, or a future state this bellows
						// version doesn't know about) must be treated as unavailable, not as ready.
						if (readiness?.state !== "ready") {
							const reason = readiness?.reason ?? "extension reported no readiness for this conductor";
							const remediation = readiness?.remediation ? ` (${readiness.remediation})` : "";
							beginFatal(new Error(`conductor "${args.conductor}" is unavailable — ${reason}${remediation}`));
							return;
						}
					}
					// v16: mutating commands are silently refused unless this socket holds the
					// controller lease. A foreign *fresh* holder here should be impossible — each
					// run gets its own ACCORDION_HOME — so it's logged as a signal that isolation
					// broke, not treated as fatal (the claim below still wins if the other holder
					// is stale). We do NOT wait for a `{type:"controller"}` ack: the extension
					// dedupes that broadcast on holder, so re-claiming a lease we already hold may
					// emit nothing, and waiting would deadlock. The extension applies the lease
					// synchronously on receipt and frames are processed in order, so by the time
					// the `snapshot` handler below sends the four configure commands, this claim
					// has already taken effect.
					if (accordion.PROTOCOL_VERSION >= CONTROLLER_PROTOCOL_MIN) {
						const controller = msg.controller;
						if (controller?.fresh && controller.surfaceId !== args.surfaceId) {
							tel.emit({ t: "info", at: Date.now(), message: `foreign fresh controller lease held by surfaceId "${controller.surfaceId}" at hello — per-run ACCORDION_HOME isolation should make this impossible` });
						}
						sendClaimController();
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
						sendConfigureCommands();
						attachTimer = setTimeout(() => {
							if (attached) return;
							beginFatal(new Error(`conductor "${args.conductor}" did not become active within ${args.attachTimeoutMs}ms`));
						}, args.attachTimeoutMs);
						// A conductor can go active (attachTimer satisfied) while a LATER configure
						// command is still unacknowledged — attaching proves selectConductor landed,
						// nothing more. Without this deadline a command that draws no reply at all
						// (as opposed to an explicit read-only refusal, which the commandResult
						// handler recovers from or fatals on immediately) would leave the run
						// executing to completion with a dial silently unapplied. The extension
						// replies to every `command` frame carrying a numeric seq, so anything still
						// outstanding this late is a broken peer, not a slow one. Fail mid-run rather
						// than at exit: the runner only converts a host failure into status=error
						// while the run is still live (run.mjs's onHostExit), so a run-end-only check
						// would be observed too late to keep the run out of the report.
						configureTimer = setTimeout(() => {
							const pending = unackedConfigure();
							if (!pending.length) return;
							beginFatal(new Error(`configure command(s) [${describeConfigure(pending)}] were never acknowledged within ${args.attachTimeoutMs}ms — this run's dials are not fully applied and its telemetry is not a valid "${args.conductor}" arm`));
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
					// `terminating` is part of the attach guard, not just the detach guard below.
					// onSignal() emits `t:"detach"` and then leaves the socket open for ~50ms while
					// detach() drains; a conductorState{active:<our conductor>} landing in that
					// window would otherwise set attached = true and append a `t:"attach"` line
					// AFTER the `t:"detach"` line — telemetry that contradicts its own ordering and
					// that foldHostTelemetry folds into attachCount: 1 regardless. It would also
					// mask a genuinely-never-attached run from the `if (!attached) throw` at the
					// bottom of main(). Nothing useful can be learned from an attach observed after
					// we have already begun tearing down, so ignore it outright.
					if (!terminating && msg.active?.id === args.conductor && !attached) {
						attached = true;
						if (attachTimer) clearTimeout(attachTimer);
						tel.emit({ t: "attach", at: Date.now(), sessionId: session!.sessionId, conductor: args.conductor, budget: args.budget, protectTokens: args.protect, protocolVersion: accordion.PROTOCOL_VERSION });
						tel.emit({ t: "info", at: Date.now(), message: `Accordion v${accordion.PROTOCOL_VERSION} resident conductor active: ${args.conductor}` });
					} else if (isGenuineMidRunDetach(terminating, attached, msg.active, args.conductor)) {
						// The extension broadcasts conductorState OPTIMISTICALLY at spawn time for
						// spawn-kind conductors (thermocline/triptych) — up to 10s before the runner
						// actually dials in. If it never dials, the extension auto-detaches. Without
						// this check bellows would silently keep recording a "conducted" arm that was
						// really a raw baseline for the rest of the run, poisoning the comparison.
						//
						// isGenuineMidRunDetach (accordionV15.ts) is what excludes our own shutdown
						// echo: onSignal()'s detach() sends `{kind:"selectConductor", id:null}` on a
						// normal exit, which the extension broadcasts back to every client — including
						// us — inside the ~50ms teardown window. See that function's doc comment for
						// the full shutdown-echo rationale. (The `if (fatal) return` above the switch
						// already keeps an already-fatal run from re-entering this branch at all.)
						beginFatal(new Error(`conductor "${args.conductor}" detached mid-run`));
						return;
					}
					break;
				}
				case "conductorStatus":
					if (typeof msg.text === "string" && msg.text) tel.emit({ t: "info", at: Date.now(), message: `status: ${msg.text}` });
					break;
				case "commandResult": {
					if (msg.refused !== "read-only") break;
					// detach() sends its two teardown commands (setFolding:false,
					// selectConductor:null) at batchStartSeq+4/+5 — deliberately OUTSIDE the
					// retryable configure batch (see sendConfigureCommands()'s doc comment). Once
					// onSignal() has set terminating, ANY commandResult we see from here on can
					// only belong to that teardown pair (or to a stale reply superseded by it), and
					// must never be treated as a configure-batch refusal: doing so would emit a
					// spurious "t":"error" into an otherwise-clean run's telemetry AND resend
					// sendConfigureCommands() — including `selectConductor: <benchmark conductor>` —
					// re-arming the extension that onSignal() was in the middle of disarming. Bail
					// out before the seq check below even runs.
					if (terminating) break;
					// sendConfigureCommands() sends FOUR separate `command` frames spanning
					// [batchStartSeq, batchStartSeq+3]. Bound BOTH sides of that window: a refusal
					// for a seq outside it (notably detach()'s teardown pair immediately following
					// the batch) belongs to a different command entirely and must not be mistaken
					// for a configure-batch refusal. The `terminating` guard above states the
					// intent; this bound is the mechanical backstop in case teardown commands are
					// ever in flight for a reason other than terminating.
					if (typeof msg.seq !== "number" || msg.seq < batchStartSeq || msg.seq > batchStartSeq + 3) break;
					if (claimRetries < CLAIM_RETRY_LIMIT) {
						claimRetries++;
						tel.emit({ t: "error", at: Date.now(), message: `command seq ${msg.seq} refused as read-only — re-claiming controller lease and reconfiguring (attempt ${claimRetries}/${CLAIM_RETRY_LIMIT})` });
						sendClaimController();
						// Belt-and-braces: only resend the configure batch — including the destructive
						// `selectConductor` — while we are not yet attached. The read-only gate is
						// evaluated per inbound `command` frame before applyCommand and cannot change
						// mid-burst, so today a refused batch is refused in full and nothing in it was
						// ever applied, which is what makes resending `selectConductor` safe. But if a
						// partial batch ever did apply with `selectConductor` accepted, this resend
						// would hit detachActive() a second time — a real Truth mutation (freeze as
						// actor "you" + clearLocks) that would silently corrupt the measurement.
						// Guarding on `!attached` closes that off for free.
						if (!attached) sendConfigureCommands();
					} else {
						beginFatal(new Error(`bellows v15 host: controller lease refused as read-only for surfaceId "${args.surfaceId}" after ${CLAIM_RETRY_LIMIT} re-claim retry attempt(s) — the extension is not granting this surface the controller lease`));
						return;
					}
					break;
				}
				case "notice":
					if (typeof msg.text === "string" && msg.text) tel.emit({ t: "info", at: Date.now(), message: `notice: ${msg.text}` });
					break;
				case "controller": {
					// ControllerMessage (protocol.ts) is flat: `{type, surfaceId, label}` — there is
					// no nested `controller` object and no `fresh` field on this message at all
					// (that flag lives on HelloMessage's `controller: ControllerInfo | null`, a
					// different message). The old `msg.controller ?? msg` fallback always fell
					// through to `msg`, and `msg.fresh` was always undefined, so this line always
					// logged "fresh=?" regardless of what was broadcast.
					tel.emit({ t: "info", at: Date.now(), message: `controller lease broadcast: surfaceId=${msg.surfaceId ?? "?"} label=${msg.label ?? "?"}` });
					break;
				}
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
