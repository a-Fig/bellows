/*
 * Accordion protocol-v15..v22 bridge.
 *
 * The devmain redesign moved authoritative context state and conductor execution
 * into the pi extension. Bellows is therefore a small GUI-role control client:
 * it hydrates a replica for exact telemetry, but never runs a second Truth or
 * conductor host of its own.
 *
 * Snapshot hydration and event application are loaded dynamically from the
 * Accordion checkout itself (below), so they auto-upgrade with whatever ref is
 * checked out — bellows never parses a block. Two wire-shape changes DO reach
 * bellows directly (v16 controller lease, v21 conductor readiness); they are
 * handled in main-v15.ts, gated on the version constants exported here. (v22's
 * `system` block kind is NOT purely internal to replica.ts: the system prompt
 * becomes a real WireBlock at order -1, so `replica.blocks.length` — which
 * main-v15.ts reads straight into the `t:"sync"` telemetry series — is +1
 * from v22 onward. Combined with v19 folding the system prompt's tokens into
 * `liveTokens`/`fullTokens`, a v22 run's `t:"sync"` numbers are on a different
 * scale than a pre-v19 run's. main-v15.ts records `protocolVersion` on the
 * `t:"attach"` event specifically so downstream analysis can tell which scale
 * a given run's series is on.)
 */
import path from "node:path";
import { accordionRepo } from "./accordion";

const norm = (p: string) => p.split(path.sep).join("/");
const core = (rel: string) => norm(path.join(accordionRepo(), "core", rel));

// Single source of truth for the protocol range main-v15.ts and its tests gate
// on — see core/protocol.ts's History block for what changed at each version.
export const MIN_SUPPORTED_PROTOCOL = 15;
export const MAX_SUPPORTED_PROTOCOL = 22;

export interface TruthStats {
	rev: number;
	liveTokens: number;
	fullTokens: number;
	budget: number;
	protectTokens: number;
	blockCount: number;
}

export interface TruthReplica {
	readonly rev: number;
	readonly blocks: unknown[];
	readonly groups: unknown[];
	foldedCount(): number;
	stats(): TruthStats;
}

// v21+ readiness of a conductor's required startup capabilities, as carried on the
// `hello` message's `conductors[]` (protocol.ts's `ActiveConductorMeta.readiness` /
// `ConductorReadiness`) — NOT on the registry's `RegistryEntry`. The registry
// (core/conductor/registry.ts) is deliberately filesystem-free; readiness is computed
// by the extension (`catalogMeta(readinessOf)`) and only ever reaches bellows over the
// wire on `hello`. Optional because pre-v21 hellos never carry it.
export interface HelloConductorEntry {
	id: string;
	label: string;
	readiness?: { state: string; reason?: string; remediation?: string };
}

export interface V15Modules {
	PROTOCOL_VERSION: number;
	isServerMessage(v: unknown): boolean;
	hydrateSnapshot(meta: { format: "pi"; title: string; cwd: string; model: string }, state: unknown): TruthReplica;
	applyWireEvent(truth: TruthReplica, event: unknown): void;
	// kind/label are types-only widenings — the runtime registry already carries these
	// fields at every supported version; this just lets main-v15.ts read them without
	// an `as any`. readiness is NOT here — see HelloConductorEntry above.
	ENTRIES: Array<{
		id: string;
		label: string;
		kind: "none" | "in-process" | "spawn";
	}>;
}

/**
 * Whether an inbound `conductorState` update represents a genuine mid-run detach of
 * `conductorId` — as opposed to it attaching, or main-v15.ts's own shutdown echo.
 *
 * On a normal exit, main-v15.ts's onSignal() sets `terminating = true` synchronously,
 * THEN calls detach(), which sends `{kind:"selectConductor", id:null}`. The extension's
 * liveHost.select(null) broadcasts the resulting `{type:"conductorState", active:null}`
 * to every connected client — including the sender — and that echo can land inside the
 * ~50ms window between detach() sending and the socket actually closing. Without
 * checking `terminating` first, that self-inflicted echo is indistinguishable from a
 * genuine mid-run detach and every clean shutdown would false-fatal (this was exactly
 * the defect: it fired on every successful POSIX run, since `child.kill("SIGTERM")` is
 * how run.mjs ends a normal run).
 *
 * Exported — and used verbatim by main-v15.ts — so this exact guard can be unit-tested
 * directly. That matters because the scenario it guards against can only be exercised
 * through a REAL, JS-catchable SIGTERM, and `child_process.kill()` cannot deliver one
 * on Windows: libuv's `uv_kill` maps SIGTERM (and SIGINT) to a bare `TerminateProcess`
 * there, which kills the target before its `process.on("SIGTERM", …)` handler ever
 * runs (verified empirically for this repo's exact spawn shape — see the integration
 * test suite's `expectGracefulExit` comment). A pure unit test of this predicate is
 * the "equivalent via the code path" for platforms where the OS signal itself is a
 * dead end.
 */
export function isGenuineMidRunDetach(
	terminating: boolean,
	attached: boolean,
	active: { id: string } | null | undefined,
	conductorId: string,
): boolean {
	return !terminating && attached && (active === null || active === undefined || active.id !== conductorId);
}

let cached: V15Modules | null = null;

export async function loadAccordionV15(): Promise<V15Modules> {
	if (cached) return cached;
	const [protocol, replica, registry] = await Promise.all([
		import(/* @vite-ignore */ core("protocol.ts")),
		import(/* @vite-ignore */ core("replica.ts")),
		import(/* @vite-ignore */ core("conductor/registry.ts")),
	]);
	cached = {
		PROTOCOL_VERSION: protocol.PROTOCOL_VERSION,
		isServerMessage: protocol.isServerMessage,
		hydrateSnapshot: replica.hydrateSnapshot,
		applyWireEvent: replica.applyWireEvent,
		ENTRIES: registry.ENTRIES,
	};
	return cached;
}
