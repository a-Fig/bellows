import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// `test/fixtures/echo-conductor.test.mjs` is an executable fixture consumed by
		// runner tests, not a Vitest suite. Keep fixtures out of automatic discovery.
		exclude: [...configDefaults.exclude, "test/fixtures/**"],
	},
});
