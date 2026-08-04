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
 * `system` block kind is purely internal to replica.ts — no bellows change.)
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

export interface V15Modules {
	PROTOCOL_VERSION: number;
	isServerMessage(v: unknown): boolean;
	hydrateSnapshot(meta: { format: "pi"; title: string; cwd: string; model: string }, state: unknown): TruthReplica;
	applyWireEvent(truth: TruthReplica, event: unknown): void;
	// readiness/kind/label are types-only widenings for v21+ diagnostics — the
	// runtime registry already carries these fields at every supported version;
	// this just lets main-v15.ts read them without an `as any`.
	ENTRIES: Array<{
		id: string;
		label: string;
		kind: "none" | "in-process" | "spawn";
		readiness?: { state: string; reason?: string; remediation?: string };
	}>;
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
