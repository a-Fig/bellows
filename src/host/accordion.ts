/*
 * accordion.ts — the bridge into the local Accordion checkout.
 *
 * The host reuses Accordion's REAL engine, mapping, plan-translation, and conductor
 * registry rather than reimplementing any of it (the brief's hard requirement). Those
 * modules live in a machine-local checkout whose path comes from bench.config.json, so
 * we cannot write literal `import "..."` specifiers for them at author time. Instead we
 * resolve the checkout once and `import()` the modules by absolute path — vite-node runs
 * each through the same svelte(runes)+`$conductors` pipeline as the config, so
 * `store.svelte.ts` compiles and its `$conductors` imports resolve exactly as they do in
 * Accordion's own vitest.
 *
 * Everything below is typed against local structural interfaces (kept minimal — only the
 * members the host actually calls) so this file type-checks without importing the
 * checkout's `.d.ts`. The runtime objects are the real ones.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * Resolve the Accordion checkout root.
 *
 * Order: BELLOWS_ACCORDION_REPO (set by the runner per run — the pinned-worktree
 * path when the trial uses `accordionRef`) FIRST, then bench.config.json, then
 * the example config. The env override lets a single run point the host at a
 * specific ref's worktree without mutating any config on disk.
 */
export function accordionRepo(): string {
	const envOverride = process.env.BELLOWS_ACCORDION_REPO;
	if (envOverride && envOverride.trim()) {
		return path.resolve(envOverride);
	}
	const candidates = [
		path.resolve(__dirname, "../../bench.config.json"),
		path.resolve(__dirname, "../../bench.config.example.json"),
	];
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		try {
			const cfg = JSON.parse(readFileSync(p, "utf8"));
			if (cfg && typeof cfg.accordionRepo === "string" && cfg.accordionRepo) {
				return path.resolve(cfg.accordionRepo);
			}
		} catch {
			/* try the next candidate */
		}
	}
	throw new Error("bellows: could not resolve accordionRepo from bench.config.json / bench.config.example.json");
}

const REPO = accordionRepo();
// Use POSIX-slash ABSOLUTE paths (not file:// URLs) as import specifiers: vite-node's
// resolver handles absolute FS paths directly, whereas a file:// URL percent-encodes the
// spaces in the checkout path ("Claude Work Space") and fails to resolve.
const norm = (p: string) => p.split(path.sep).join("/");
const engine = (rel: string) => norm(path.join(REPO, "app/src/lib/engine", rel));
const live = (rel: string) => norm(path.join(REPO, "app/src/lib/live", rel));
const conductorsIndex = () => norm(path.join(REPO, "conductors/index.ts"));

// ── Minimal structural mirrors of the checkout's public shapes ────────────────────
// We only model what the host touches. The runtime values are the real objects.

export interface WireBlock {
	id: string;
	kind: "user" | "text" | "thinking" | "tool_call" | "tool_result";
	turn: number;
	order: number;
	text: string;
	tokens: number;
	toolName?: string;
	callId?: string;
	model?: string;
	isError?: boolean;
}

export interface EngineBlock extends WireBlock {
	override: string | null;
	autoFolded: boolean;
	by: string | null;
}

export interface FoldOp {
	id: string;
	digestText: string;
}
export interface GroupOp {
	id: string;
	memberIds: string[];
	summaryText: string | null;
}

export interface CompletionRequest {
	system?: string;
	prompt: string;
	maxOutputTokens?: number;
	signal?: AbortSignal;
	model?: string;
}
export interface CompletionResult {
	text: string;
	model: string;
	inputTokens?: number;
	outputTokens?: number;
}

export interface Conductor {
	readonly id: string;
	readonly label: string;
	readonly locks?: readonly string[];
}

export interface InProcessConductor {
	id: string;
	label: string;
	locks?: readonly string[];
	create: () => Conductor;
}

/** The slice of AccordionStore the host drives. */
export interface AccordionStore {
	blocks: EngineBlock[];
	budget: number;
	contextWindow: number | null;
	protectTokens: number;
	liveTokens: number;
	fullTokens: number;
	foldedCount: number;
	groups: unknown[];
	conductor: Conductor | null;
	completer: ((req: CompletionRequest) => Promise<CompletionResult>) | null;
	wireAttached: boolean;
	appendBlocks(blocks: EngineBlock[]): void;
	setBudget(n: number): void;
	setProtect(n: number): void;
	setContextWindow(n: number): void;
	attach(c: Conductor | null): void;
	detach(): void;
	dispose(): void;
	refold(): void;
	isFolded(b: EngineBlock): boolean;
}

interface EngineModules {
	AccordionStore: new (parsed: {
		meta: { format: string; title: string; cwd: string; model: string };
		blocks: EngineBlock[];
		lineCount: number;
		skipped: number;
	}) => AccordionStore;
	wireToBlock: (w: WireBlock) => EngineBlock;
	computeFoldOps: (store: AccordionStore) => FoldOp[];
	computeGroupOps: (store: AccordionStore) => GroupOp[];
	resolveUnfold: (store: AccordionStore, codes: string[]) => { restored: unknown[]; missing: string[] };
	resolveRecall: (store: AccordionStore, codes: string[]) => { restored: unknown[]; missing: string[] };
	estTokens: (text: string) => number;
	IN_PROCESS_CONDUCTORS: InProcessConductor[];
}

/**
 * TEST SEAM (gated on BELLOWS_TEST_SLOW_CONDUCT_MS): wrap a conductor so its `conduct()`
 * busy-blocks synchronously for N ms. Used ONLY by the host's own cadence test to prove the
 * ~250 ms plan-reply window is honored even when conduct() is slow (the reply must go out
 * with the last plan; the fresh plan lands on the following sync). Never active in a real run.
 */
export function maybeSlowWrap(c: Conductor): Conductor {
	const ms = Number(process.env.BELLOWS_TEST_SLOW_CONDUCT_MS);
	if (!Number.isFinite(ms) || ms <= 0) return c;
	const inner = c as unknown as { conduct: (v: unknown) => unknown };
	const orig = inner.conduct.bind(inner);
	inner.conduct = (v: unknown) => {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			/* busy-wait: a synchronous stall inside conduct() */
		}
		return orig(v);
	};
	return c;
}

let cached: EngineModules | null = null;

/** Load the real engine/live/conductor modules from the checkout (once). */
export async function loadAccordion(): Promise<EngineModules> {
	if (cached) return cached;
	const [storeMod, mappingMod, planMod, tokensMod, conductorsMod] = await Promise.all([
		import(/* @vite-ignore */ engine("store.svelte.ts")),
		import(/* @vite-ignore */ live("mapping.ts")),
		import(/* @vite-ignore */ live("plan.ts")),
		import(/* @vite-ignore */ engine("tokens.ts")),
		import(/* @vite-ignore */ conductorsIndex()),
	]);
	cached = {
		AccordionStore: storeMod.AccordionStore,
		wireToBlock: mappingMod.wireToBlock,
		computeFoldOps: planMod.computeFoldOps,
		computeGroupOps: planMod.computeGroupOps,
		resolveUnfold: planMod.resolveUnfold,
		resolveRecall: planMod.resolveRecall,
		estTokens: tokensMod.estTokens,
		IN_PROCESS_CONDUCTORS: conductorsMod.IN_PROCESS_CONDUCTORS,
	};
	return cached;
}
