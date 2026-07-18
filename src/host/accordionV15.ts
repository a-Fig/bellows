/*
 * Accordion protocol-v15 bridge.
 *
 * The devmain redesign moved authoritative context state and conductor execution
 * into the pi extension. Bellows is therefore a small GUI-role control client:
 * it hydrates a replica for exact telemetry, but never runs a second Truth or
 * conductor host of its own.
 */
import path from "node:path";
import { accordionRepo } from "./accordion";

const norm = (p: string) => p.split(path.sep).join("/");
const core = (rel: string) => norm(path.join(accordionRepo(), "core", rel));

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
	ENTRIES: Array<{ id: string; label: string; kind: "none" | "in-process" | "spawn" }>;
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
