/**
 * M3 (adversarial review): builds the SIGINT/SIGTERM handler for `bellows worker`.
 * A first signal asks the loop to wind down gracefully (abort the controller,
 * which the loop turns into a short-deadline complete() for any in-flight
 * run — see loop.mjs's shutdownCompleteDeadlineMs). A SECOND signal means the
 * operator already asked once and the process still hasn't gone away (e.g.
 * complete()'s retry/backoff sleep, or an executor that isn't honoring the
 * abort signal promptly) — force-exit immediately rather than making them
 * wait out whatever's stuck.
 *
 * Kept in its own dependency-free module (rather than inlined in
 * bin/bellows.mjs) for two reasons: it's pure logic that belongs next to the
 * rest of the worker code, and bin/bellows.mjs carries a `#!/usr/bin/env node`
 * shebang — importing a shebang'd file as a non-entrypoint dependency breaks
 * vitest's esbuild-based transform (SyntaxError at the shebang), so anything
 * meant to be unit-tested directly needs to live outside that file.
 */

/**
 * @param {object} args
 * @param {AbortController} args.abortController
 * @param {(m:string)=>void} args.log
 * @param {(code:number)=>void} [args.exit]  test seam for process.exit
 * @returns {(sig:string)=>void}
 */
export function makeShutdownSignalHandler({ abortController, log, exit = process.exit }) {
  let signalCount = 0;
  return function onSignal(sig) {
    signalCount++;
    if (signalCount === 1) {
      log(`[worker] received ${sig} — finishing the in-flight run (if any) then exiting`);
      abortController.abort();
    } else {
      log(`[worker] received ${sig} again — forcing immediate exit`);
      exit(130);
    }
  };
}
