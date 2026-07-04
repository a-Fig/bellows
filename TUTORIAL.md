# bellows tutorial

How to run a conductor benchmark, from zero to report.

## One-time setup

```bash
cd bellows
npm install
cp bench.config.example.json bench.config.json    # already correct for this machine
```

Set the platform API key in your shell (the same `at_...` key your slopcode clients use):

```powershell
$env:AGENT_TRIALS_API_KEY = "at_..."
```

That's it. pi credentials are copied automatically from `~/.pi/agent` into each run's
isolated agent dir — you never touch them.

## Write a trial

A trial is one YAML file in `trials/`:

```yaml
trial: keel-vs-naive-xjq        # unique name; becomes the label prefix
problems: xjq                   # problem name(s) the agent is told to solve
model: token-router:deepseek/deepseek-v4-flash
thinkingLevel: medium
budget: 25000                   # accordion token budget the conductor folds to
protectTokens: 10000            # protected working tail
arms:
  - conductor: keel
  - conductor: compaction-naive
  - conductor: none             # raw baseline (no host attached)
seeds: 2                        # repeats per arm
caps:
  costUsd: 2                    # per run
  turns: 120                    # assistant messages per run
  minutes: 60
  totalTokens: 3000000          # IMPORTANT for token-router (see gotchas)
parallel: 2                     # runs in flight at once
room:
  create: true                  # mint a fresh room per run (PR #98 endpoint)
```

Conductor ids: `builtin`, `cold-score`, `cold-epoch`, `sliding-window`,
`garbage-collector`, `compaction-naive`, `bear2-hybrid`, `code-skeleton`, `keel`,
plus `none` for the raw baseline. These are all **in-process** — the headless host
loads them straight out of Accordion's `IN_PROCESS_CONDUCTORS` registry.

### External conductors (`external:<id>`)

A conductor that runs as its **own process** (the ADR 0007 escape hatch — e.g.
`thermocline`, which needs its own GPU/Python probe) is addressed with an
`external:` prefix instead of a bare id:

```yaml
arms:
  - conductor: external:thermocline
  - conductor: keel
```

What bellows does differently for an `external:<id>` arm:

1. It looks for `<accordionRepo>/conductors/<id>/launch.json` — a small manifest:
   ```json
   { "id": "thermocline", "label": "Thermocline", "command": "node", "args": ["thermocline.mjs"], "portEnv": "THERMO_PORT" }
   ```
   Missing `launch.json` fails the run immediately with a clear error, before pi is
   even spawned.
2. It spawns that command (cwd = the conductor's own directory) with
   `ACCORDION_HOME` set to the run's isolated accordion-home dir, so the conductor's
   discovery heartbeat and any per-session persistence stay scoped to this run.
3. **`portEnv`**: if `launch.json` declares one, bellows allocates a free TCP port
   and sets that env var before spawning, so the conductor binds a run-private port.
   **A conductor with no `portEnv` binds its hardcoded default port and therefore
   cannot appear in more than one arm/run at a time on the same machine** — bellows
   logs a warning and runs it anyway (useful for a quick single-arm check, unsafe for
   `parallel > 1` trials or two trials sharing a conductor). Note the free-port pick
   is TOCTOU: the port is only free at the instant bellows checks it, and another
   process (or a concurrent `parallel: N` run) can grab it before the conductor binds.
   A lost race surfaces as a clean heartbeat-timeout failure, not a hang or crash.
4. It polls `<accordionHome>/.accordion/conductors/<id>.json` for a fresh heartbeat
   (the `ConductorEntry` shape from Accordion's `registry.ts`: `id`, `url`, `pid`,
   `heartbeatAt`, stale after 15s) for up to ~20s, then fails the run with a clear
   timeout error if the conductor never advertises itself.
5. The headless host is launched with `--conductor-url <ws url> --conductor-id <id>`
   instead of `--conductor <id>` — it dials the conductor as a WebSocket **client**
   (conductor wire protocol v3; the conductor process hosts the server, same topology
   as Accordion's own remote-conductor support) rather than instantiating it in-process.
6. The conductor process is killed alongside pi and the host when the run ends —
   success, cap, crash, or teardown — so nothing is left running after a trial
   (on Windows this is a `taskkill /T` process-tree kill, so a conductor's own
   subprocesses — e.g. a GPU/Python probe — are reaped too, not just the direct child).
7. **If the external conductor dies mid-run** (unexpected WS drop), the host clears
   its desired state to raw — the run continues with unfolded context from that
   point on, exactly as if no conductor were attached — and records a prominent
   `"conductor died — cleared to raw"` telemetry note (with conductor id and
   timestamp) so the death point is visible in the report and the run is never
   silently left folding against a conductor that is no longer there.

`test/fixtures/conductors/echo-conductor/` is a minimal reference implementation of
this contract (folds the largest non-protected `tool_result` block; no GPU/Python
dependency) — read it as a template for wiring up a new external conductor, or run it
directly for a protocol smoke test:

```bash
cd test/fixtures/conductors/echo-conductor
node echo-conductor.mjs                 # binds ws://127.0.0.1:7799 by default
ECHO_PORT=0 node echo-conductor.mjs     # OS-assigned ephemeral port (what bellows uses via portEnv)
```

It writes its heartbeat to `$ACCORDION_HOME/.accordion/conductors/echo-conductor.json`
exactly like a real external conductor, so pointing a trial's `bench.config.json →
accordionRepo` at a directory containing `test/fixtures/conductors/echo-conductor/`
(or symlinking it under a real Accordion checkout's `conductors/`) is enough to
exercise the whole spawn → discover → dial → fold pipeline end to end without any
model/GPU dependency.

## Run it

```bash
node bin/bellows.mjs run trials/keel-vs-naive-xjq.yaml --dry   # sanity-check the plan first
node bin/bellows.mjs run trials/keel-vs-naive-xjq.yaml        # the real thing
```

Per run, bellows: provisions an isolated workspace + pi agent dir (model pinned,
pi auto-compaction off, accordion extension wired) → spawns `pi --mode rpc` and the
headless conductor host → the agent joins its room, labels the run, and solves →
caps are enforced live → results are collected into `runs/<trial>/<arm>-<seed>/record.json`.

Each run gets a **unique agent name and label** automatically (`<trial>-<arm>-s<seed>` /
`<trial>/<arm>/<seed>`) — required because the leaderboard keeps one row per agent name.

## Read the results

```bash
node bin/bellows.mjs report            # runs/ -> report.html
```

The report groups runs by **condition fingerprint** (model, budget, problems, template,
prompt — the things that must match for a comparison to be fair) and compares conductors
within each group: checkpoints solved, cost, tokens, wall clock, cache share. Runs that
don't share a fingerprint are never silently compared — near-misses are called out with
the differing field named. Per-run detail rows show per-turn cost/token sparklines and
the conductor's budget-adherence chart (wire tokens vs budget over time).

Old manual runs on the platform are still comparable by score (query the same
leaderboard), but they have no cost/token data — the report can't include them.

## What a run records

`runs/<trial>/<arm>-<seed>/record.json`:
- `usage` — input/output/cacheRead/cacheWrite tokens, cost, turns (from pi's session JSONL)
- `turns[]` — per-assistant-message usage + wire size at each call
- `conductor` — syncs, plans, fold ops, held-plan replies, conduct latency, budget series
- `platform` — the leaderboard row harvested by label (partial `final:false` rows are
  kept for capped runs — aborted runs never vanish)
- `fingerprint` — everything needed to know if two runs are comparable

Also in the run dir: `host.jsonl` (raw telemetry), `pi-rpc.log`, the full workspace
and agent dir for forensics.

## Gotchas

- **token-router prices everything at $0** (its models.json entries carry no cost
  rates), so the dollar cap is inert for those models — always set `caps.totalTokens`.
  To get real dollar numbers in records, add rates to `bench.config.json`:
  ```json
  "pricing": { "deepseek/deepseek-v4-flash": { "inputPerMtok": 0.0, "outputPerMtok": 0.0, "cacheReadPerMtok": 0.0 } }
  ```
  (fill in The Token Company's actual rates; estimated costs are marked `costEstimated`).
- **Problem choice**: 12 of 25 problems (Medium/Hard) have only smoke-verified grading
  budgets and can time out legitimate solutions. Stick to the Easy set
  (`cfgpipe, code_search, etl_pipeline, forge, l2m, migrate_configs, textdrop, xjq`)
  until those budgets are re-verified.
- **Never delete platform rooms as cleanup** — deleting a room cascades and permanently
  erases that run's scores from the platform.
- **Unmerged conductor branches**: bellows runs whatever is checked out at
  `bench.config.json → accordionRepo`. To bench a conductor PR, check out that branch
  in the Accordion repo (or point accordionRepo at a worktree of it).
- The fingerprint records the Accordion commit, so mixed-checkout comparisons are
  caught by the report, not silently merged.

## Running it on the homeserver

Nothing here is Windows-specific: clone bellows + Accordion on the homeserver, `npm install`
both, copy `~/.pi/agent` credentials, set the key env var, and the same commands work.
(A `bench worker --poll` daemon mode that picks up trials queued from the platform is the
designed Phase 2 — not built yet.)
