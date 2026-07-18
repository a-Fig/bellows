import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// `test/fixtures/echo-conductor.test.mjs` is an executable fixture consumed by
		// runner tests, not a Vitest suite. Keep fixtures out of automatic discovery.
		// `.claude/worktrees/**` holds nested agent-session checkouts of this same
		// repo — without this exclude, a bare `npm test` sweeps their duplicated
		// test suites too, producing hundreds of unrelated failures (port
		// contention/resource contention between the checkouts' host tests).
		// `runs/**` is the gitignored runsDir (bench.config.json's default
		// "./runs") — accordionRef resolution checks out full Accordion repos
		// under `runs/_accordion/<sha>/` (see accordionRef.mjs), each carrying
		// its own Svelte/Vite test suite that isn't set up to run standalone
		// under this repo's Vitest config (missing $state rune globals, missing
		// $conductors alias) and has no business running as part of bellows' own
		// suite.
		exclude: [...configDefaults.exclude, "test/fixtures/**", "**/.claude/**", "runs/**"],
	},
});
