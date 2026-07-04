/*
 * enumerate-conductors.ts — tiny vite-node entry that prints the ids of every
 * in-process conductor Accordion ships (IN_PROCESS_CONDUCTORS), as a JSON array
 * on stdout. Invoked by the worker's conductor-advertisement seam (see
 * src/worker/conductorAdvertise.mjs) exactly like src/host/main.ts is invoked by
 * the runner — same vite-node config, same svelte(runes)+$conductors pipeline —
 * because `loadAccordion()` (src/host/accordion.ts) ultimately imports
 * `store.svelte.ts`, which needs the Svelte rune compiler even though this
 * script itself never touches a store.
 *
 * Kept separate from main.ts (rather than adding a "--list-conductors" mode to
 * it) so the worker's polling path never touches the run-driving host logic.
 */
import { loadAccordion } from "./accordion";

async function main(): Promise<number> {
	const acc = await loadAccordion();
	process.stdout.write(JSON.stringify(acc.IN_PROCESS_CONDUCTORS.map((c) => c.id)));
	return 0;
}

main()
	.then((code) => process.exit(code))
	.catch((e) => {
		console.error(`[enumerate-conductors] ${e instanceof Error ? e.message : String(e)}`);
		process.exit(1);
	});
