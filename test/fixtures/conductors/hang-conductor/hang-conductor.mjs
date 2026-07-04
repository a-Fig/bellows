#!/usr/bin/env node
// hang-conductor.mjs — a deliberately broken EXTERNAL conductor fixture for the
// M2 regression test (adversarial review): it spawns successfully and stays
// alive, but NEVER writes a discovery heartbeat under
// $ACCORDION_HOME/.accordion/conductors/<id>.json. This proves
// `spawnExternalConductor`'s heartbeat-timeout path kills the process rather
// than leaking it.
//
// Deliberately does nothing else — no WS server, no heartbeat file. Exits only
// on SIGTERM/SIGKILL (Node's default signal handling), so the test can assert
// the process is actually dead after the runner's teardown.
setInterval(() => {}, 1 << 30);
