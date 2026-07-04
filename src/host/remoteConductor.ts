/*
 * remoteConductor.ts — bellows' Node client for an EXTERNAL conductor process
 * (ADR 0007 escape hatch, conductor wire protocol v3).
 *
 * Mirrors the topology and behavior of Accordion's `RemoteRunner`
 * (app/src/lib/live/conductorClient.svelte.ts) — READ AS A BLUEPRINT, not imported
 * (that module is a Svelte-rune singleton built on the browser `WebSocket` global;
 * this is a fresh implementation on Node's `ws` package using its `.on()` event API).
 *
 * Topology: the CONDUCTOR hosts the WebSocket server; we dial in as a client
 * (`--conductor-url` from the runner, which discovered it via the conductor's
 * heartbeat file under `$ACCORDION_HOME/.accordion/conductors/<id>.json`).
 *
 * Async <-> sync bridge: `conduct(view)` must be synchronous (the `Conductor`
 * interface's contract) — it fires a `context/update` at the remote (fire-and-forget)
 * and returns whatever `Command[] | null` we last cached from `conductor/commands`.
 * When a fresh batch arrives we cache it and call `host.requestRerun()` so the store
 * re-enters `conduct()` on a later microtask and picks up the fresh cache — exactly
 * the same pattern RemoteRunner uses via `store.refold()`.
 */
import WebSocket from "ws";
import type { Telemetry } from "./telemetry";
import type {
	Conductor,
	ConductorHost,
	ConductorView,
	Command,
	ClampReport,
	LockName,
} from "$conductors/contract/conductor";
import {
	CONDUCTOR_PROTOCOL_VERSION,
	LOCK_NAMES,
	isConductorMessage,
	type ContentMode,
	type ConductorMessage,
	type HostHelloMessage,
	type ContextUpdateMessage,
} from "$conductors/contract/protocol";

export interface RemoteConductorSession {
	title: string;
	model: string;
	cwd: string;
}

export interface RemoteConductorOptions {
	url: string;
	/** The conductor id we expect to dial (used for telemetry + error messages). */
	id: string;
	session: RemoteConductorSession;
	budget: number;
	contextWindow: number | null;
	telemetry: Telemetry;
	/** Reconnect backoff — kept simple (single retry loop), mirrors the host's own dial retry. */
	dialTimeoutMs?: number;
	/**
	 * Called synchronously whenever a fresh `conductor/commands` batch (or a
	 * `conductor/hello`) should be applied to the store right away, bypassing the
	 * store's default microtask-queued `requestRerun()`. main.ts wires this to
	 * `store.refold()` + reading back `store.lastReports`, then replies with
	 * `host/commandResult` — the wire needs the ACTUAL clamp report, which only the
	 * real store produces (never fabricate one client-side).
	 */
	onApply?: () => void;
}

/**
 * bellows' Node-side counterpart to Accordion's `RemoteRunner`. Implements the
 * in-process `Conductor` interface so `store.attach(client)` treats it exactly like
 * any other conductor — the store has no idea the real strategy lives in another
 * process across a WebSocket.
 */
export class RemoteConductorClient implements Conductor {
	readonly id: string;
	label: string;
	locks: readonly LockName[] | undefined = undefined;

	private ws: WebSocket | null = null;
	private manualClose = false;
	private host: ConductorHost | null = null;
	private desired: Command[] | null = null;
	private wants: ContentMode = "full";
	private rev = 0;
	private lastRev = 0;
	private greeted = false;
	private suppressUpdate = false;
	/**
	 * True after an unexpected drop. (m7/m6, PM decision): conduct() no longer
	 * holds the last state once dead — `desired` is cleared to `[]` on the same
	 * disconnect, so a dead conductor's last fold batch cannot outlive it. Kept
	 * as a readable flag mirroring Accordion's RemoteRunner.isDead for tests and
	 * any future caller that wants to distinguish "dead" from "never attached."
	 */
	private _dead = false;
	get isDead(): boolean {
		return this._dead;
	}
	/** Resolves once we connect (or reject on a hard dial failure within dialTimeoutMs). */
	private connectedResolve: (() => void) | null = null;
	private connectedReject: ((e: Error) => void) | null = null;
	readonly ready: Promise<void>;

	constructor(private opts: RemoteConductorOptions) {
		this.id = opts.id;
		this.label = opts.id;
		this.ready = new Promise<void>((resolve, reject) => {
			this.connectedResolve = resolve;
			this.connectedReject = reject;
		});
	}

	// ---- Conductor interface ------------------------------------------------
	conduct(view: ConductorView): Command[] | null {
		if (this.suppressUpdate) this.suppressUpdate = false;
		else if (this.greeted) this.pushContext(view);
		return this.desired;
	}

	attach(host: ConductorHost): void {
		this.host = host;
	}

	detach(): void {
		this.host = null;
	}

	// ---- lifecycle -----------------------------------------------------------
	connect(): this {
		this.manualClose = false;
		let ws: WebSocket;
		try {
			ws = new WebSocket(this.opts.url);
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			this.opts.telemetry.emit({ t: "error", at: Date.now(), message: `conductor dial: ${err.message}` });
			this.connectedReject?.(err);
			return this;
		}
		this.ws = ws;

		const dialTimer = setTimeout(() => {
			if (!this.greeted) {
				const err = new Error(`conductor "${this.id}" did not send conductor/hello in time`);
				this.opts.telemetry.emit({ t: "error", at: Date.now(), message: err.message });
				this.connectedReject?.(err);
			}
		}, this.opts.dialTimeoutMs ?? 10_000);

		ws.on("open", () => {
			const hello: HostHelloMessage = {
				type: "host/hello",
				conductorProtocol: CONDUCTOR_PROTOCOL_VERSION,
				session: this.opts.session,
				budget: this.opts.budget,
				contextWindow: this.opts.contextWindow,
			};
			this.send(hello);
		});

		ws.on("message", (data: WebSocket.RawData) => {
			let msg: unknown;
			try {
				msg = JSON.parse(data.toString());
			} catch {
				return;
			}
			this.handle(msg);
			if (this.greeted) {
				clearTimeout(dialTimer);
				this.connectedResolve?.();
			}
		});

		ws.on("error", (e: Error) => {
			this.opts.telemetry.emit({ t: "error", at: Date.now(), message: `conductor ws: ${e.message}` });
		});

		ws.on("close", () => {
			clearTimeout(dialTimer);
			if (this.ws !== ws) return;
			this.ws = null;
			if (!this.manualClose) {
				// Unexpected drop (m7/m6, PM decision): mirror Accordion's RemoteRunner --
				// clear the desired state to [] so conduct() reports raw rather than
				// perpetuating a stale fold against a dead conductor, and surface a loud,
				// non-error info event (never buried in errors[]) marking the death point.
				this._dead = true;
				this.desired = [];
				this.opts.telemetry.emit({
					t: "info",
					at: Date.now(),
					message: `conductor "${this.id}" died -- cleared to raw`,
				});
				// Re-run the conductor pass immediately so the store reflects raw NOW,
				// exactly like RemoteRunner's disconnect handler (this.store.refold()).
				this.host?.requestRerun();
				if (!this.greeted) {
					this.connectedReject?.(new Error(`conductor "${this.id}" closed before greeting`));
				}
			}
		});
		return this;
	}

	close(): void {
		this.manualClose = true;
		const ws = this.ws;
		this.ws = null;
		try {
			ws?.close();
		} catch {
			/* already gone */
		}
	}

	// ---- inbound --------------------------------------------------------------
	private handle(msg: unknown): void {
		if (!isConductorMessage(msg)) return;
		const m: ConductorMessage = msg;
		switch (m.type) {
			case "conductor/hello": {
				if (m.conductorProtocol !== CONDUCTOR_PROTOCOL_VERSION) {
					const err = new Error(
						`conductor protocol mismatch — conductor "${this.id}" speaks v${m.conductorProtocol}, host v${CONDUCTOR_PROTOCOL_VERSION}`,
					);
					this.opts.telemetry.emit({ t: "error", at: Date.now(), message: err.message });
					this.close();
					this.connectedReject?.(err);
					return;
				}
				if (m.wants?.content) this.wants = m.wants.content;
				if (typeof m.label === "string" && m.label) this.label = m.label;
				const rawLocks = Array.isArray(m.locks) ? m.locks : [];
				const validLocks = rawLocks.filter((l): l is LockName => LOCK_NAMES.includes(l as LockName));
				this.locks = validLocks.length > 0 ? Object.freeze(validLocks) : undefined;
				this.greeted = true;
				// The host-level "attach" HostEvent is emitted once by main.ts when the store
				// itself attaches (pi hello). This is the LATER, conductor-side greet — surface
				// it as a non-error info note (M3: greet/status/disconnect are healthy, chatty
				// events, not failures — folding them into errors[] made a healthy run look
				// error-laden) so it is recorded but never counted as an error.
				this.opts.telemetry.emit({
					t: "info",
					at: Date.now(),
					message: `conductor "${this.id}" greeted: label=${this.label} locks=${(this.locks ?? []).join(",") || "(none)"} wants=${this.wants}`,
				});
				this.applyNow();
				break;
			}
			case "conductor/commands": {
				if (!this.greeted) break;
				if (m.rev !== undefined && m.rev < this.rev) break; // stale-rev drop
				this.desired = Array.isArray(m.commands) ? m.commands : [];
				this.lastRev = m.rev ?? this.rev;
				this.suppressUpdate = true;
				this.applyNow();
				break;
			}
			case "cap/request":
				this.serveCapability(m);
				break;
			case "conductor/status":
				this.opts.telemetry.emit({
					t: "info", // healthy chatty status note (M3) -- recorded, never counted as an error
					at: Date.now(),
					message: `status: ${m.text ?? ""}`,
				});
				break;
		}
	}

	private serveCapability(m: Extract<ConductorMessage, { type: "cap/request" }>): void {
		if (m.capability === "complete") {
			void (async () => {
				if (!this.host || !this.host.can("complete")) {
					this.send({ type: "cap/result", reqId: m.reqId, ok: false, error: "completion unavailable" });
					return;
				}
				const prompt = m.completion?.prompt;
				if (typeof prompt !== "string" || !prompt) {
					this.send({ type: "cap/result", reqId: m.reqId, ok: false, error: "missing completion.prompt" });
					return;
				}
				try {
					const r = await this.host.complete({
						system: m.completion?.system,
						prompt,
						maxOutputTokens: m.completion?.maxOutputTokens,
					});
					this.send({
						type: "cap/result",
						reqId: m.reqId,
						ok: true,
						value: r.text,
						model: r.model,
						inputTokens: r.inputTokens,
						outputTokens: r.outputTokens,
					});
				} catch (e) {
					this.send({ type: "cap/result", reqId: m.reqId, ok: false, error: String((e as Error)?.message ?? e) });
				}
			})();
			return;
		}

		let value: string | number | undefined;
		let ok = true;
		let error: string | undefined;
		switch (m.capability) {
			case "countTokens":
				if (this.host) value = this.host.countTokens(m.text ?? "");
				else ((ok = false), (error = "countTokens unavailable"));
				break;
			case "getContent":
				// bellows' headless host does not keep a separate content store beyond what
				// the engine's AccordionStore already holds; getDigest below covers the
				// digest case. A bare getContent (raw text of a block by id) is not wired
				// through ConductorHost today — report unavailable rather than guessing.
				ok = false;
				error = "getContent unavailable on the bellows host";
				break;
			case "getDigest": {
				const id = m.ids?.[0];
				const d = id && this.host ? this.host.digestOf(id) : null;
				if (d != null) value = d;
				else ((ok = false), (error = `no digest for ${id ?? "(missing id)"}`));
				break;
			}
			default:
				ok = false;
				error = `unknown capability ${(m as { capability?: string }).capability}`;
		}
		this.send({ type: "cap/result", reqId: m.reqId, ok, value, error });
	}

	/**
	 * Apply the newly-cached `desired` commands to the store IMMEDIATELY (synchronously,
	 * on this WS message tick) rather than waiting on `host.requestRerun()`'s microtask —
	 * so the `host/commandResult` we send back reflects THIS batch's actual clamp report,
	 * not a report from whatever refold happens to run next. `onApply` is main.ts's
	 * callback that calls `store.refold()` and then this.sendCommandResult(...) with
	 * `store.lastReports` (the only place the real clamp report exists).
	 */
	private applyNow(): void {
		if (this.opts.onApply) this.opts.onApply();
		else this.host?.requestRerun();
	}

	// ---- outbound ---------------------------------------------------------
	notifyEvent(event: "agentUnfold" | "humanOverride", ids: string[], detail?: string): void {
		this.send({ type: "host/event", event, ids, detail });
	}

	/** Report the clamps the host applied for the batch at `rev` (mirrors RemoteRunner). */
	sendCommandResult(reports: ClampReport[]): void {
		this.send({ type: "host/commandResult", rev: this.lastRev, reports });
	}

	private pushContext(view: ConductorView): void {
		const blocks =
			this.wants === "full"
				? view.blocks
				: view.blocks.map((b) => {
						const { text: _text, ...rest } = b;
						return { ...rest, preview: firstLine(b.text ?? "", 100) };
					});
		const update: ContextUpdateMessage = {
			type: "context/update",
			rev: ++this.rev,
			budget: view.budget,
			contextWindow: view.contextWindow,
			liveTokens: view.liveTokens,
			protectedFromIndex: view.protectedFromIndex,
			protectTokens: view.protectTokens,
			blocks,
		};
		this.send(update);
	}

	private send(msg: object): void {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		try {
			ws.send(JSON.stringify(msg));
		} catch {
			/* socket gone — a later context/update will retry */
		}
	}
}

/** Local firstLine helper (mirrors engine/tokens.ts's firstLine; kept dependency-free here). */
function firstLine(text: string, maxLen: number): string {
	const nl = text.indexOf("\n");
	const line = nl === -1 ? text : text.slice(0, nl);
	return line.length > maxLen ? line.slice(0, maxLen) + "…" : line;
}
