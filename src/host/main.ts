/*
 * main.ts — the headless conductor host for the bellows benchmarking rig.
 *
 * Invoked once per run by the runner:
 *
 *   npx vite-node --config vite-node.config.ts src/host/main.ts -- \
 *     --accordion-home <dir> --conductor <id> --budget <n> --protect <n> \
 *     --telemetry-out <file.jsonl> [--timeout-min <n>]
 *
 * It is the GUI live-client, headless. It:
 *   1. polls $ACCORDION_HOME/.accordion/sessions/ for the single session descriptor the
 *      runner's pi session advertises, then dials its ws:// URL (retrying until timeout);
 *   2. speaks pi-wire protocol v5 exactly like `liveClient.svelte.ts` — pins the protocol
 *      version on `hello`, folds `sync` blocks into a REAL `AccordionStore`, answers the
 *      agent's `unfold` / `recall` tools, and services `host.complete()` over the
 *      `completeRequest`/`completeResult` relay;
 *   3. attaches the requested conductor from `IN_PROCESS_CONDUCTORS`;
 *   4. THE CRUX — honors the extension's ~250 ms plan-reply window: it answers each `sync`
 *      IMMEDIATELY with the plan computed from the store's LAST completed conduct pass, then
 *      ingests the new blocks + reconducts on a deferred tick. The freshly computed plan is
 *      used for the NEXT sync's reply. This mirrors the async cadence of
 *      `conductorClient.svelte.ts` (reply now with last plan, recompute in the background)
 *      and is faithful for both synchronous in-process conductors and slow / LLM ones.
 *   5. writes HostEvent JSONL telemetry throughout;
 *   6. exits 0 when the WS closes (session ended), nonzero on a fatal error, and flushes
 *      telemetry on SIGTERM.
 *
 * Environment knobs:
 *   BELLOWS_ARMED_ACK_TIMEOUT_MS — ms to wait for the extension's `armedAck` before logging
 *     a loud (non-fatal) "extension predates armed-over-wire" warning. Default 5000. Must be
 *     a finite number >= 0; 0 explicitly disables the watchdog. Anything else (unset,
 *     unparseable, negative) falls back to the default.
 */
import WebSocket from "ws";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { Telemetry } from "./telemetry";
import {
	loadAccordion,
	maybeSlowWrap,
	type AccordionStore,
	type WireBlock,
	type FoldOp,
	type GroupOp,
	type CompletionRequest,
	type CompletionResult,
	type Conductor,
} from "./accordion";
import { RemoteConductorClient } from "./remoteConductor";

// The pi-wire protocol version the host pins. Matches Accordion's protocol.ts (v5). Kept
// as a literal so a checkout on a DIFFERENT protocol version hard-fails loudly on hello,
// rather than silently driving a wire shape one side doesn't understand.
const PROTOCOL_VERSION = 5;

const REGISTRY_DIR = ".accordion";
const SESSIONS_SUBDIR = "sessions";
const STALE_AFTER_MS = 15_000;

// Backstop for an out-of-band completion the extension never answers (mirrors the GUI's
// 120 s COMPLETION_TIMEOUT_MS). Bounds a worst-case hang while allowing any real LLM call.
const COMPLETION_TIMEOUT_MS = 120_000;

// How long the host waits for an `armedAck` after declaring itself armed before it
// concludes the attached extension predates armed-over-wire. Env-tunable so the host
// test can shrink it without touching the production default (5s).
// BELLOWS_ARMED_ACK_TIMEOUT_MS: milliseconds, default 5000. Must be a finite number >= 0.
// 0 explicitly disables the watchdog (no setTimeout is armed). Anything unparseable,
// negative, or absent falls back to the default — `0 || 5000` would otherwise silently
// coerce an intentional "0" into 5000, and a negative value would fire immediately.
const armedAckTimeoutEnv = Number(process.env.BELLOWS_ARMED_ACK_TIMEOUT_MS);
const ARMED_ACK_TIMEOUT_MS = Number.isFinite(armedAckTimeoutEnv) && armedAckTimeoutEnv >= 0 ? armedAckTimeoutEnv : 5_000;

// ── CLI parsing ───────────────────────────────────────────────────────────────
interface Args {
	accordionHome: string;
	/** In-process conductor id (IN_PROCESS_CONDUCTORS). Mutually exclusive with conductorUrl/conductorId. */
	conductor: string | null;
	/** ws:// URL of an already-running external conductor process (bellows spawned it). */
	conductorUrl: string | null;
	/** The external conductor's stable id, for telemetry + error messages. */
	conductorId: string | null;
	budget: number;
	protect: number;
	telemetryOut: string;
	timeoutMin: number;
}

function parseArgs(argv: string[]): Args {
	const map = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
			map.set(key, val);
		}
	}
	const need = (k: string): string => {
		const v = map.get(k);
		if (v === undefined) throw new Error(`bellows host: missing required --${k}`);
		return v;
	};
	const num = (k: string, v: string): number => {
		const n = Number(v);
		if (!Number.isFinite(n)) throw new Error(`bellows host: --${k} must be a number (got ${v})`);
		return n;
	};

	const conductor = map.get("conductor") ?? null;
	const conductorUrl = map.get("conductor-url") ?? null;
	const conductorId = map.get("conductor-id") ?? null;
	if (conductor && (conductorUrl || conductorId)) {
		throw new Error("bellows host: pass either --conductor OR --conductor-url/--conductor-id, not both");
	}
	if (!conductor && !conductorUrl) {
		throw new Error("bellows host: missing required --conductor (or --conductor-url + --conductor-id)");
	}
	if (conductorUrl && !conductorId) {
		throw new Error("bellows host: --conductor-url requires --conductor-id");
	}

	return {
		accordionHome: need("accordion-home"),
		conductor,
		conductorUrl,
		conductorId,
		budget: num("budget", need("budget")),
		protect: num("protect", need("protect")),
		telemetryOut: need("telemetry-out"),
		timeoutMin: map.has("timeout-min") ? num("timeout-min", map.get("timeout-min")!) : 30,
	};
}

// vite-node passes script args after "--"; process.argv is [node, main.ts, ...args].
function scriptArgs(): string[] {
	const argv = process.argv.slice(2);
	const dd = argv.indexOf("--");
	return dd >= 0 ? argv.slice(dd + 1) : argv;
}

// ── session discovery ───────────────────────────────────────────────────────────
interface SessionEntry {
	sessionId: string;
	port: number;
	heartbeatAt: number;
	protocolVersion: number;
}

/** Find the single live session descriptor the runner's pi session advertised. */
function findSession(accordionHome: string): SessionEntry | null {
	const dir = path.join(accordionHome, REGISTRY_DIR, SESSIONS_SUBDIR);
	if (!existsSync(dir)) return null;
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return null;
	}
	const now = Date.now();
	const live: SessionEntry[] = [];
	for (const f of files) {
		try {
			const e = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
			if (typeof e.port === "number" && e.port > 0 && typeof e.heartbeatAt === "number" && now - e.heartbeatAt <= STALE_AFTER_MS) {
				live.push(e);
			}
		} catch {
			/* skip a half-written descriptor */
		}
	}
	if (!live.length) return null;
	// Runner sets ACCORDION_HOME per run so exactly one session appears; if several race,
	// prefer the freshest heartbeat.
	live.sort((a, b) => b.heartbeatAt - a.heartbeatAt);
	return live[0];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── the host ────────────────────────────────────────────────────────────────────
async function main(): Promise<number> {
	const args = parseArgs(scriptArgs());
	const tel = new Telemetry(args.telemetryOut);
	const deadline = Date.now() + args.timeoutMin * 60_000;

	const acc = await loadAccordion();

	// Resolve the requested conductor up front so a bad id/URL fails before we dial the
	// pi session. Exactly one of `entry` (in-process) or `remoteUrl` (external) is set —
	// parseArgs already enforced that --conductor and --conductor-url are mutually exclusive.
	let entry: (typeof acc.IN_PROCESS_CONDUCTORS)[number] | null = null;
	if (args.conductor) {
		const found = acc.IN_PROCESS_CONDUCTORS.find((c) => c.id === args.conductor);
		if (!found) {
			const ids = acc.IN_PROCESS_CONDUCTORS.map((c) => c.id).join(", ");
			tel.emit({ t: "error", at: Date.now(), message: `unknown conductor "${args.conductor}" (available: ${ids})` });
			await tel.close();
			throw new Error(`bellows host: unknown conductor "${args.conductor}" — available: ${ids}`);
		}
		entry = found;
	}
	// `entry` is non-null exactly when args.conductor was set — capture in a const so
	// narrowing survives inside the WS closures created below (mirrors the original code).
	const inProcEntry = entry;

	// ── discover + dial (retry until timeout) ──────────────────────────────────
	let session: SessionEntry | null = null;
	while (Date.now() < deadline) {
		session = findSession(args.accordionHome);
		if (session) break;
		await sleep(250);
	}
	if (!session) {
		tel.emit({ t: "error", at: Date.now(), message: "no session descriptor appeared before timeout" });
		await tel.close();
		throw new Error("bellows host: no session descriptor appeared before timeout");
	}

	const wsUrl = `ws://127.0.0.1:${session.port}`;

	// State shared across the socket lifecycle. `store` is assigned only inside the WS
	// message closures, so TS's flow analysis narrows top-level reads to null; a typed
	// accessor keeps the real union at the post-loop teardown sites.
	let store: AccordionStore | null = null;
	const currentStore = (): AccordionStore | null => store;
	let socket: WebSocket | null = null;
	let helloSeen = false;
	let attached = false;
	let syncs = 0;
	// The live external-conductor client, if args.conductorUrl was given — kept so the
	// unfoldRequest/recallRequest handlers can forward host/event, and so the deferred
	// conduct can send host/commandResult with the store's clamp reports after applying
	// the remote's last batch. Null for an in-process conductor (no wire round-trip).
	let remoteConductor: RemoteConductorClient | null = null;

	/** Build a fresh conductor instance for a (re)attach — in-process id or external URL. */
	function buildConductor(meta?: { title?: string; model?: string; cwd?: string }): Conductor {
		// A rebuild (e.g. a `full` sync reset) must not leak the previous client's WS —
		// a single-connection conductor would otherwise see two live host connections.
		try {
			remoteConductor?.close();
		} catch {
			/* ignore */
		}
		if (inProcEntry) {
			remoteConductor = null;
			return maybeSlowWrap(inProcEntry.create() as unknown as Conductor);
		}
		const client = new RemoteConductorClient({
			url: args.conductorUrl!,
			id: args.conductorId!,
			session: {
				title: meta?.title || "bellows run",
				model: meta?.model || "",
				cwd: meta?.cwd || "",
			},
			budget: args.budget,
			contextWindow: null,
			telemetry: tel,
			// Apply synchronously against the REAL store so host/commandResult carries the
			// actual clamp report (ClampReport is only ever produced by AccordionStore's
			// applyCommands — never fabricated client-side). Guarded on `store === s` /
			// `remoteConductor === client` so a stale callback from a torn-down attach (a
			// `full` reset, or a swap) can't touch a store/conductor it no longer owns.
			onApply: () => {
				if (remoteConductor !== client) return;
				const s = store;
				if (!s || s.conductor !== client) return;
				try {
					s.refold();
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					tel.emit({ t: "error", at: Date.now(), message: `remote conductor apply: ${msg}` });
				}
				client.sendCommandResult(s.lastReports);
				// Keep the sync-reply cache in step so the next `sync`'s IMMEDIATE reply
				// (the 250ms-window crux) reflects this batch, exactly like the deferred
				// in-process path does after its own refold().
				lastPlan = computePlan();
			},
		});
		client.connect();
		// B1 (adversarial review): `ready` rejects on dial exception, dial timeout,
		// protocol mismatch, or close-before-greeting. Node kills the whole process on
		// an unhandled rejection — that is EXACTLY the failure this design must never
		// allow (a dead/misbehaving external conductor must never take down the host,
		// which would take down the pi run with it). Route the rejection to telemetry
		// and otherwise swallow it: remoteConductor.conduct() already returns `null`
		// (pass-through / raw) whenever nothing has been applied, so a client that
		// never gets past hello simply leaves the run on raw context.
		client.ready.catch((e: Error) => {
			tel.emit({ t: "error", at: Date.now(), message: `remote conductor "${client.id}" never became ready: ${e.message}` });
		});
		remoteConductor = client;
		return client;
	}
	// NB: aggregate ConductorTelemetry (plansSent, totalFoldOps, heldPlanReplies,
	// conductLatencyMs, completeCostUsd, budgetSeries) is NOT computed here — the report
	// collector (src/runner/collect.mjs) folds the HostEvent JSONL stream this host emits
	// into that shape. The host's job is to emit accurate, well-formed events.

	// The last plan the conductor produced — replied IMMEDIATELY to each sync (the crux).
	let lastPlan: { ops: FoldOp[]; groups: GroupOp[] } = { ops: [], groups: [] };
	// A deferred conduct is scheduled after a sync so the reply never waits on conduct().
	let deferPending = false;
	// True when a sync since the last conduct had to reply with the PRIOR plan because a
	// fresh conduct was not ready in time (a window-forced held reply). Surfaced on the
	// next conduct event's `heldLastPlan` so the collector counts it.
	let heldSinceLastConduct = false;

	// Out-of-band completion relay (host.complete()).
	const pendingCompletions = new Map<number, {
		resolve: (r: CompletionResult) => void;
		reject: (e: Error) => void;
		timer: ReturnType<typeof setTimeout>;
		startedAt: number;
	}>();
	let completionReqId = 0;

	function drainCompletions(reason: string): void {
		for (const { reject, timer } of pendingCompletions.values()) {
			clearTimeout(timer);
			reject(new Error(reason));
		}
		pendingCompletions.clear();
	}

	/** The completer the store hands to conductors via host.complete(). */
	function sendCompletion(req: CompletionRequest): Promise<CompletionResult> {
		const ws = socket;
		if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected"));
		if (req.signal?.aborted) return Promise.reject(new Error("aborted"));
		const reqId = ++completionReqId;
		const startedAt = Date.now();
		return new Promise<CompletionResult>((resolve, reject) => {
			let abortListener: (() => void) | null = null;
			let timer: ReturnType<typeof setTimeout>;
			const settle = (fn: () => void): void => {
				clearTimeout(timer);
				if (abortListener && req.signal) req.signal.removeEventListener("abort", abortListener);
				pendingCompletions.delete(reqId);
				fn();
			};
			timer = setTimeout(() => {
				if (pendingCompletions.has(reqId)) settle(() => reject(new Error("completion timed out")));
			}, COMPLETION_TIMEOUT_MS);
			pendingCompletions.set(reqId, {
				resolve: (r) => settle(() => resolve(r)),
				reject: (e) => settle(() => reject(e)),
				timer,
				startedAt,
			});
			if (req.signal) {
				abortListener = () => settle(() => reject(new Error("aborted")));
				req.signal.addEventListener("abort", abortListener, { once: true });
			}
			try {
				ws.send(JSON.stringify({ type: "completeRequest", reqId, system: req.system, prompt: req.prompt, maxOutputTokens: req.maxOutputTokens }));
			} catch (e) {
				settle(() => reject(new Error(e instanceof Error ? e.message : "send failed")));
			}
		});
	}

	/** Recompute the wire plan from the store's CURRENT (last-conducted) state. Pure read. */
	function computePlan(): { ops: FoldOp[]; groups: GroupOp[] } {
		if (!store || !store.conductor) return { ops: [], groups: [] };
		return { ops: acc.computeFoldOps(store), groups: acc.computeGroupOps(store) };
	}

	/**
	 * Deferred conduct: ingest the newly-synced blocks and let the conductor reconduct,
	 * OFF the sync-reply path so a slow/synchronous conduct() can never blow the 250 ms
	 * window. Runs at most once per macrotask; coalesces bursts. When it finishes it
	 * caches the fresh plan (via computePlan) for the NEXT sync reply.
	 */
	function scheduleConduct(): void {
		if (deferPending || !store) return;
		deferPending = true;
		setImmediate(() => {
			deferPending = false;
			if (!store) return;
			const s = store;
			const t0 = Date.now();
			// Held iff a sync since the last conduct had to reuse the prior plan (window-forced),
			// OR this conduct errors and we fall back to the last state.
			let heldLastPlan = heldSinceLastConduct;
			heldSinceLastConduct = false;
			try {
				// appendBlocks was already applied synchronously in the sync handler; here we
				// simply re-run the conductor so a conductor that returned null last pass (or
				// finished async work) reaches its steady state. refold() runs conduct().
				s.refold();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				tel.emit({ t: "error", at: Date.now(), message: `conduct: ${msg}` });
				heldLastPlan = true;
			}
			const latency = Date.now() - t0;
			const fresh = computePlan();
			const commands = fresh.ops.length + fresh.groups.length;
			tel.emit({ t: "conduct", at: Date.now(), rev: syncs, latencyMs: latency, commands, heldLastPlan });
			lastPlan = fresh;
		});
	}

	// ── connect (retry until timeout) ──────────────────────────────────────────
	let closedCleanly = false;
	let fatal: Error | null = null;

	async function connectOnce(): Promise<"closed" | "retry"> {
		return new Promise<"closed" | "retry">((resolve) => {
			let settled = false;
			const done = (r: "closed" | "retry") => {
				if (!settled) {
					settled = true;
					resolve(r);
				}
			};
			let ws: WebSocket;
			try {
				ws = new WebSocket(wsUrl);
			} catch (e) {
				tel.emit({ t: "error", at: Date.now(), message: `dial: ${e instanceof Error ? e.message : String(e)}` });
				return done("retry");
			}
			socket = ws;

			// Watchdog for the armedAck round-trip declared right after hello. Scoped to this
			// connection so a reconnect can never fire a timer left over from a prior attempt.
			let armedAckTimer: ReturnType<typeof setTimeout> | null = null;
			const clearArmedAckTimer = () => {
				if (armedAckTimer) {
					clearTimeout(armedAckTimer);
					armedAckTimer = null;
				}
			};

			ws.on("open", () => {
				/* wait for hello */
			});

			ws.on("message", (data: WebSocket.RawData) => {
				let msg: any;
				try {
					msg = JSON.parse(data.toString());
				} catch {
					return;
				}
				if (!msg || typeof msg.type !== "string") return;

				if (msg.type === "hello") {
					if (msg.protocolVersion !== PROTOCOL_VERSION) {
						fatal = new Error(`protocol mismatch — extension v${msg.protocolVersion}, host v${PROTOCOL_VERSION}`);
						tel.emit({ t: "error", at: Date.now(), message: fatal.message });
						try {
							ws.close();
						} catch {
							/* ignore */
						}
						return;
					}
					helloSeen = true;

					// Declare ourselves armed right after hello. helloSeen only flips once per
					// process — a post-hello WS close is treated as the session ending and
					// terminates this host rather than reconnecting (see the "closed" branch
					// below), so in practice this fires (at most) once per host lifetime, not
					// once per connectOnce rerun. Placed here defensively, mirroring where
					// `hello` itself is handled, in case that assumption ever changes.
					// A client that gets no ack is talking to an old extension: fail LOUDLY (but
					// not fatally) rather than silently running with 250ms non-blocking plan waits.
					try {
						ws.send(JSON.stringify({ type: "armed", armed: true }));
						clearArmedAckTimer();
						// 0 explicitly disables the watchdog — skip arming the timer entirely.
						if (ARMED_ACK_TIMEOUT_MS > 0) {
							armedAckTimer = setTimeout(() => {
								armedAckTimer = null;
								const message =
									"extension did not acknowledge armed — it likely predates armed-over-wire; " +
									"benchmark plan waits will NOT block; update the Accordion checkout";
								console.error(message);
								tel.emit({ t: "armed_unacked", at: Date.now(), message });
							}, ARMED_ACK_TIMEOUT_MS);
						}
					} catch (e) {
						tel.emit({ t: "error", at: Date.now(), message: `armed: ${e instanceof Error ? e.message : String(e)}` });
					}

					const meta = msg.meta ?? {};
					store = new acc.AccordionStore({
						meta: { format: "pi", title: meta.title || "live pi session", cwd: meta.cwd || "", model: meta.model || "" },
						blocks: [],
						lineCount: 0,
						skipped: 0,
					});
					store.completer = sendCompletion;
					store.wireAttached = true;
					store.setBudget(args.budget);
					store.setProtect(args.protect);
					if (typeof meta.contextWindow === "number" && meta.contextWindow > 0) {
						store.setContextWindow(meta.contextWindow);
					}
					// Attach the requested conductor now that the store exists.
					store.attach(buildConductor(meta));
					attached = true;
					lastPlan = { ops: [], groups: [] };
					tel.emit({
						t: "attach",
						at: Date.now(),
						sessionId: typeof msg.sessionId === "string" ? msg.sessionId : session!.sessionId,
						conductor: args.conductor ?? args.conductorId ?? "",
						budget: args.budget,
						protectTokens: args.protect,
					});
					return;
				}

				if (msg.type === "armedAck") {
					// Only a genuine armed===true ack disarms the watchdog. An ack with armed
					// !== true means the extension explicitly did not arm — let the timer run
					// out and fire the loud "not armed" telemetry/log rather than silently
					// treating it as success.
					if (msg.armed === true) {
						clearArmedAckTimer();
					}
					return;
				}

				if (!store) return;

				if (msg.type === "sync") {
					// STRUCTURAL RESET — rebuild the store, preserving budget/protect/window.
					if (msg.full && store.blocks.length) {
						const prevWindow = store.contextWindow;
						store.dispose();
						store = new acc.AccordionStore({
							meta: { format: "pi", title: "live pi session", cwd: "", model: "" },
							blocks: [],
							lineCount: 0,
							skipped: 0,
						});
						store.completer = sendCompletion;
						store.wireAttached = true;
						store.setBudget(args.budget);
						store.setProtect(args.protect);
						if (prevWindow !== null) store.setContextWindow(prevWindow);
						store.attach(buildConductor());
						lastPlan = { ops: [], groups: [] };
					}
					const cw = msg.contextWindow;
					if (typeof cw === "number" && cw > 0) store.setContextWindow(cw);

					// THE CRUX. Reply IMMEDIATELY with the last computed plan (empty on the first
					// sync) — never wait on conduct(). Detect a "held" reply (we are re-using a
					// plan while a fresh conduct is still pending) for telemetry.
					const priorPlan = lastPlan;
					const held = deferPending; // a conduct from a prior sync had not yet landed
					// A window-forced held reply: surfaced on the next conduct's heldLastPlan so
					// the collector counts it into ConductorTelemetry.heldPlanReplies.
					if (held) heldSinceLastConduct = true;
					const reply = { type: "plan", reqId: msg.reqId, ops: priorPlan.ops, groups: priorPlan.groups };
					try {
						ws.send(JSON.stringify(reply));
						tel.emit({ t: "plan", at: Date.now(), rev: msg.reqId, ops: priorPlan.ops.length, groups: priorPlan.groups.length });
					} catch {
						/* socket gone — extension times out and passes through */
					}

					// Ingest the fresh blocks synchronously (append is cheap; conduct is what we
					// defer). appendBlocks calls refold() internally — but for a SLOW conductor we
					// still get a fresh conduct off the reply path because the reply already went
					// out above. We then schedule an explicit reconduct so an async conductor
					// (returned null) reaches steady state and its plan is ready for next sync.
					syncs++;
					const wireBlocks: WireBlock[] = Array.isArray(msg.blocks) ? msg.blocks : [];
					const blocks = wireBlocks.map((w) => acc.wireToBlock(w));
					// Defer the whole ingest+conduct so a synchronously-slow conduct() cannot
					// stall the event loop between receiving the sync and future messages.
					queueMicrotask(() => {
						if (!store) return;
						try {
							if (blocks.length) store.appendBlocks(blocks);
						} catch (e) {
							const m = e instanceof Error ? e.message : String(e);
							tel.emit({ t: "error", at: Date.now(), message: `append: ${m}` });
						}
						scheduleConduct();
						tel.emit({
							t: "sync",
							at: Date.now(),
							rev: msg.reqId,
							blocks: store.blocks.length,
							liveTokens: store.liveTokens,
							foldedBlocks: store.foldedCount,
						});
					});
					return;
				}

				if (msg.type === "unfoldRequest") {
					const codes = Array.isArray(msg.codes) ? msg.codes : [];
					const { restored, missing } = acc.resolveUnfold(store, codes);
					try {
						ws.send(JSON.stringify({ type: "unfoldResult", reqId: msg.reqId, restored, missing }));
					} catch {
						/* ignore */
					}
					// The agent pulled blocks back — recompute so the next plan reflects it.
					scheduleConduct();
					// Tell an external conductor about the agent's self-unfold (host/event,
					// mirrors RemoteRunner.notifyEvent — same wire event an in-process conductor's
					// view.blocks would reflect automatically on the next context/update).
					if (remoteConductor) {
						const ids = (restored as Array<{ ids?: string[] }>).flatMap((r) => r.ids ?? []);
						if (ids.length) remoteConductor.notifyEvent("agentUnfold", ids);
					}
					return;
				}

				if (msg.type === "recallRequest") {
					const codes = Array.isArray(msg.codes) ? msg.codes : [];
					const { restored, missing } = acc.resolveRecall(store, codes);
					try {
						ws.send(JSON.stringify({ type: "recallResult", reqId: msg.reqId, restored, missing }));
					} catch {
						/* ignore */
					}
					return;
				}

				if (msg.type === "completeResult") {
					if (typeof msg.reqId !== "number") return;
					const pending = pendingCompletions.get(msg.reqId);
					if (!pending) return;
					const latency = Date.now() - pending.startedAt;
					// The extension does not send cost; we record latency and leave cost null
					// unless a future extension supplies token usage the collector can price.
					tel.emit({ t: "complete", at: Date.now(), costUsd: null, latencyMs: latency });
					if (msg.ok) {
						pending.resolve({ text: msg.text ?? "", model: msg.model ?? "", inputTokens: msg.inputTokens, outputTokens: msg.outputTokens });
					} else {
						pending.reject(new Error(msg.error ?? "completion failed"));
					}
					return;
				}
				// stream frames + anything else: ignore (presentation-only in the GUI).
			});

			ws.on("error", (e: Error) => {
				clearArmedAckTimer();
				tel.emit({ t: "error", at: Date.now(), message: `ws: ${e.message}` });
			});

			ws.on("close", () => {
				clearArmedAckTimer();
				drainCompletions("disconnected");
				if (socket === ws) socket = null;
				if (fatal) {
					done("closed"); // a protocol mismatch closed us — do not retry
				} else if (helloSeen) {
					// We had a live session; the WS closing means the session ended → clean exit.
					closedCleanly = true;
					done("closed");
				} else {
					// Never greeted — the extension may not be up yet. Retry until timeout.
					done("retry");
				}
			});
		});
	}

	// ── lifecycle: SIGTERM flushes telemetry and detaches ──────────────────────
	let terminating = false;
	const onSignal = (sig: string) => {
		if (terminating) return;
		terminating = true;
		tel.emit({ t: "detach", at: Date.now(), reason: sig });
		try {
			currentStore()?.dispose();
		} catch {
			/* ignore */
		}
		try {
			remoteConductor?.close();
		} catch {
			/* ignore */
		}
		try {
			socket?.close();
		} catch {
			/* ignore */
		}
		// Flush and exit; the WS close resolve races with this, so force-exit after flush.
		void tel.close().then(() => process.exit(0));
	};
	process.on("SIGTERM", () => onSignal("SIGTERM"));
	process.on("SIGINT", () => onSignal("SIGINT"));

	// ── connect loop ───────────────────────────────────────────────────────────
	while (Date.now() < deadline && !terminating) {
		const r = await connectOnce();
		if (r === "closed") break;
		if (fatal) break;
		await sleep(250); // retry backoff before re-dialing
	}

	// Timeout while never connecting is a detach-by-timeout, not a clean close.
	if (!closedCleanly && !fatal && !terminating) {
		tel.emit({ t: "detach", at: Date.now(), reason: attached ? "timeout" : "never-connected" });
	} else if (closedCleanly) {
		tel.emit({ t: "detach", at: Date.now(), reason: "session-closed" });
	}

	drainCompletions("shutdown");
	try {
		currentStore()?.dispose();
	} catch {
		/* ignore */
	}
	try {
		remoteConductor?.close();
	} catch {
		/* ignore */
	}
	await tel.close();

	if (fatal) throw fatal;
	if (!attached) throw new Error("bellows host: never attached to a session before timeout");
	return 0;
}

main()
	.then((code) => process.exit(code))
	.catch((e) => {
		// Telemetry is already flushed in main()'s error paths; surface the message + nonzero exit.
		console.error(`[bellows-host] ${e instanceof Error ? e.message : String(e)}`);
		process.exit(1);
	});
