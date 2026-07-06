/*
 * vite-node.config.ts — the compile recipe for the headless conductor host.
 *
 * The host (`src/host/*`) drives the REAL Accordion engine + conductors out of a
 * local Accordion checkout. That code is authored as Svelte 5 rune modules
 * (`*.svelte.ts` using `$state`/`$derived`) and reaches the conductor registry via
 * the `$conductors` alias. To run it under `vite-node` we must reproduce exactly what
 * Accordion's own `app/vitest.config.ts` does:
 *
 *   1. load the bare Svelte plugin with `runes: true` so `store.svelte.ts` compiles;
 *   2. mirror the `$conductors` alias (bare barrel + subpaths) at the accordion repo's
 *      top-level `conductors/` dir.
 *
 * The accordion checkout location is machine-local, so we read it from bench.config.json
 * (falling back to bench.config.example.json) — never hard-code a path. Everything the
 * host imports from the checkout is pure TS / rune modules with NO `$lib` / `$app` /
 * `$env` imports (verified), so no SvelteKit shims are required beyond `$conductors`.
 */
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * Resolve the Accordion checkout. BELLOWS_ACCORDION_REPO (set by the runner per
 * run — the pinned-worktree path for a trial's `accordionRef`) wins FIRST so the
 * `$conductors` alias points at the SAME tree accordion.ts loads the engine from.
 * If the two disagreed, the host would import store.svelte.ts from the worktree
 * but resolve $conductors into the base checkout. Falls back to bench.config.json,
 * then the example.
 */
function accordionRepo(): string {
	const envOverride = process.env.BELLOWS_ACCORDION_REPO;
	if (envOverride && envOverride.trim()) {
		return path.resolve(envOverride);
	}
	const candidates = [
		path.resolve(__dirname, "bench.config.json"),
		path.resolve(__dirname, "bench.config.example.json"),
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
	throw new Error(
		"bellows: could not resolve accordionRepo — create bench.config.json (or bench.config.example.json) with an \"accordionRepo\" path.",
	);
}

const repo = accordionRepo();
const conductorsDir = path.join(repo, "conductors");

export default defineConfig({
	plugins: [svelte({ compilerOptions: { runes: true } })],
	resolve: {
		// Mirror Accordion's vitest alias so both the bare barrel (`$conductors`) and
		// subpaths (`$conductors/contract`) resolve into the checkout's conductors/ dir.
		alias: [
			{ find: /^\$conductors$/, replacement: conductorsDir },
			{ find: /^\$conductors\//, replacement: `${conductorsDir}/` },
		],
	},
	// vite-node reads ssr.* for its module runner; keep the engine/conductor sources
	// (and the svelte runtime) inlined/transformed rather than externalized so the
	// rune compiler output is what actually runs.
	ssr: {
		noExternal: ["svelte", "@a-fig/accordion"],
	},
});
