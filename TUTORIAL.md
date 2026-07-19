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
budget: 100000                  # accordion token budget the conductor folds to
protectTokens: 20000            # protected working tail
arms:
  - conductor: keel
  - conductor: compaction-naive
  - conductor: none             # raw baseline (no host attached)
seeds: 2                        # repeats per arm
caps:                           # smoke baseline: turn cap off, wall clock is the backstop
  costUsd: 10                   # per run (inert for token-router — see gotchas)
  turns: 10000                  # assistant messages per run; 10000 = effectively off
  minutes: 90
  # totalTokens: 3000000        # optional hard token backstop (see gotchas)
parallel: 2                     # runs in flight at once
room:
  create: true                  # mint a fresh room per run (PR #98 endpoint)
```

When `room.create: true`, `problems` also decides which leaderboard bucket the
created room lands on (`src/runner/roomConfig.mjs`): `all`/omitted → the full
bench (no `problem_set`); one of the canonical preset keys (`easy`, `medium`,
`hard`, `easy-1`, `easy-l1`..`easy-l4`, case-insensitive) → that `problem_set`;
any other single string or a `problems: [a, b, ...]` list → an explicit
`problems` array on the room. `room.pool` (pre-created rooms) is unaffected —
their bucket was decided when they were created.

Conductor ids: `builtin`, `cold-score`, `cold-epoch`, `sliding-window`,
`garbage-collector`, `compaction-naive`, `bear2-hybrid`, `code-skeleton`, `keel`,
plus `none` for the raw baseline. These are all **in-process** — the headless host
loads them straight out of Accordion's `IN_PROCESS_CONDUCTORS` registry.

### Bench a specific Accordion branch/PR (`accordionRef`)

By default every run uses whatever `bench.config.json → accordionRepo` currently
has checked out. To bench a **specific git rev** — typically an unmerged conductor
PR branch — add an optional `accordionRef` to the trial, and bellows uses that ref
**without touching the main checkout's working tree**:

```yaml
trial: handoff-vs-naive
accordionRef: claude/happy-fermat-8b7485   # the Handoff conductor PR branch
arms:
  - conductor: handoff                     # a conductor only present on that branch
  - conductor: compaction-naive
```

`accordionRef` is any git rev the accordion repo's origin knows — a branch, tag,
or full SHA (`/^[A-Za-z0-9._\/-]{1,200}$/`, must not start with `-`). When set,
the runner:

1. fetches the ref onto a **private per-ref refspec**
   (`git fetch origin +<ref>:refs/bellows-bench/<sha1-of-ref-string>`) and
   rev-parses that ref to a full SHA — race-free under parallel runs (distinct
   refs land on distinct files; `FETCH_HEAD` is never consulted). A bare-SHA ref
   the server refuses to serve falls back to the local object store;
2. checks that SHA out into a **pinned, detached worktree** under
   `<runsDir>/_accordion/<sha12>` (reused across runs — a matching worktree is
   left alone; a broken/mismatched one is recreated);
3. uses that worktree as the effective accordion repo for the run: the pi
   `extension/accordion.ts` path, the in-process/external conductors, and the
   host all load from it, and the run's **fingerprint records the resolved SHA**
   (so two runs on different refs never share a comparison key).

Absent `accordionRef` ⇒ exactly today's behavior. The pinned worktree needs no
`npm install`: the host imports only pure TS/rune modules whose `svelte` runtime
comes from bellows' own `node_modules` and whose `$conductors` alias is supplied
by `vite-node.config.ts`; the only artifact the fresh worktree lacks
(`app/.svelte-kit/tsconfig.json`) is provisioned automatically at worktree
creation. `worker.pullBeforeClaim` only ff-pulls the base checkout's current
branch and can never disturb these detached pinned worktrees.

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
   instead of `--conductor <id>` — it dials the conductor as a WebSocket **client**.
   The conductor contract version comes from the trial's effective Accordion checkout
   (including a pinned `accordionRef`), so host and conductor stay in lockstep; the
   conductor process hosts the server, matching Accordion's own remote-conductor topology.
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
  rates), so the dollar cap is inert for those models — `caps.minutes` (wall clock)
  is the backstop that actually binds; set `caps.totalTokens` only if you want a
  hard token ceiling on top of it.
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
  `bench.config.json → accordionRepo`. To bench a conductor PR without disturbing
  that checkout, set the trial's **`accordionRef`** field (see *Bench a specific
  Accordion branch/PR* above) — it fetches the ref and pins a detached worktree.
  Manually checking the branch out in the Accordion repo also works but mutates the
  shared checkout.
- The fingerprint records the Accordion commit, so mixed-checkout comparisons are
  caught by the report, not silently merged.

## Running it on the homeserver

Nothing here is Windows-specific: clone bellows + Accordion on the homeserver, `npm install`
both, copy `~/.pi/agent` credentials, set the key env var, and the same commands work.

Setup checklist, learned the hard way on the first real install (each item below was a
separate live failure — the worker claims a run, fails it cleanly, and the platform shows
the exact error, so work down this list when a fresh box fails its first run):

1. **`piAgentDir` needs `models.json`, not just `auth.json`** — run provisioning hard-fails
   with `Required credential models.json not found` without it. Copy both from a working
   box, plus any provider keys the trial models need in `auth.json` (e.g. `tokenrouter`
   for `token-router:*` models). Merge keys into an existing `auth.json`; don't overwrite.
2. **`npm install` in BOTH `app/` and `extension/` of the Accordion clone** (and
   `npx svelte-kit sync` in `app/`). The per-run pi loads
   `<accordionRepo>/extension/accordion.ts` — a bare clone is missing `ws` and pi exits 1
   with `Failed to load extension`. The `app/` install + sync is what lets conductor
   advertisement compile `store.svelte.ts` under vite-node.
3. **The bench Accordion clone is what runs, not the machine's other checkouts** — bellows
   points pi at `bench.config.json → accordionRepo`; keep it a dedicated clone so
   `pullBeforeClaim` never fights a browser-served install, and keep any *globally
   registered* accordion extension (the machine's own `~/.pi/agent/settings.json`) at a
   compatible commit — 50 commits stale caused wire-version confusion during bring-up.
4. **No GPU → no `gpu-probe` cap** (and skip `external-conductors` unless the box has the
   attention-folder Python probe stack). Trials that need them route to a capable worker.

## Worker mode (`bellows worker`)

`bellows run` schedules a trial you already know the shape of. `bellows worker` is the other
half: a long-running daemon that lets the **platform** dispatch work to this machine —
useful for a homeserver (or any spare box) that should sit and grind through whatever runs
get queued, without you hand-writing a trial YAML per machine.

```bash
node bin/bellows.mjs worker --poll     # long-running: claim, execute, repeat, forever
node bin/bellows.mjs worker --once     # claim + execute at most one run, then exit (debugging)
```

### Config

Add a `worker` section to `bench.config.json`:

```json
{
  "worker": {
    "platformUrl": "https://agent-trials-407493014719.us-west1.run.app",
    "name": "homeserver-1",
    "caps": ["in-process", "external-conductors"],
    "pullBeforeClaim": false,
    "parallel": 1,
    "autoUpdate": true
  }
}
```

- **`platformUrl`** — base URL of the agent-trials control plane (same host as `platformBase`
  in the normal `run` path; kept as a separate field since a worker fleet may point workers at
  a different base than ad hoc `bellows run` invocations).
- **`name`** — this worker's identity. Sent on every claim/heartbeat/events/complete call; the
  platform's scheduler and any per-worker dashboards key off it. Pick something stable and
  identifying (`homeserver-1`, not `worker`).
- **`caps`** — capability tags this worker advertises so the scheduler can route runs it can
  actually satisfy:
  - `in-process` — can run any conductor in Accordion's `IN_PROCESS_CONDUCTORS` registry.
  - `external-conductors` — can spawn `external:<id>` conductor processes (needs the
    conductor's own runtime deps — e.g. Python for a GPU probe — installed locally).
  - `gpu-probe` — has a GPU available for conductors that need one (e.g. thermocline).
  - `has-completions` — this worker's pi/model setup can service `host.complete()` calls for
    LLM-backed conductors.
  These are free-form strings the platform's scheduler interprets — `caps` doesn't gate
  anything client-side beyond being included in the claim request.
- **`pullBeforeClaim`** — `true` means `git pull --ff-only` the `accordionRepo` checkout before
  each claim attempt (throttled to at most once/minute, so a 5s poll cadence doesn't hammer
  git). A failed pull logs a warning and the worker keeps running against whatever's already
  checked out — it never blocks or fails a claim. Off by default because most setups pin
  `accordionRepo` to a specific branch/worktree on purpose (see the Gotchas section above);
  turn it on for a homeserver that should always track the latest `devmain`.
- **`parallel`** — reserved for running multiple claimed runs concurrently. Only `1` is
  supported today; any other value is rejected at startup with a clear error.
- **`autoUpdate`** — self-update THIS bellows checkout (not `accordionRepo`) from `origin/main`
  when idle, then exit for a supervisor to relaunch on the new code. Default `true` when absent.
  See the [Self-update](#self-update-workerautoupdate) section below for the full mechanism,
  the `BELLOWS_NO_SELF_UPDATE=1` kill switch, and required supervisor setup.

The API key **value** is never read from `bench.config.json` — only from the
environment variable named by the top-level `platformApiKeyEnv` field
(`AGENT_TRIALS_API_KEY` in the example config above), exactly like `bellows run`'s
`platformApiKeyEnv`-driven lookup. (Fixed in an adversarial-review pass — the
worker used to hardcode `AGENT_TRIALS_API_KEY` regardless of what
`platformApiKeyEnv` said; harmless as long as you never repoint that field, but
a footgun otherwise.)

### What the worker advertises on every claim

Alongside `caps`, each claim poll sends a `conductors` list: every id in Accordion's
`IN_PROCESS_CONDUCTORS` registry, plus `external:<id>` for every
`<accordionRepo>/conductors/<id>/launch.json` bellows finds. This tells the platform's
scheduler exactly which conductor ids this worker's Accordion checkout can actually run,
so it never dispatches a run for a conductor this machine doesn't have. The list is
rebuilt via a short-lived vite-node subprocess (the same mechanism `spawnHost` uses)
and cached for ~60s so the 5s poll cadence doesn't re-spawn it on every tick.

### What happens per claimed run

1. **Claim** — `POST /api/bench/workers/claim` with `{worker, caps, conductors}`. A `204`
   means nothing is queued; the worker sleeps ~5s (± jitter) and polls again. A `200` returns
   a fully-resolved run: trial config, the one arm for this run, and a seed.
2. **Execute** — the claimed run is handed to `src/runner/run.mjs`'s `executeRun` (the exact
   same function `bellows run` uses per run) under `runs/_worker/<trial>/<arm>-<seed>/`.
3. **Heartbeat** — every ~30s while executing, `POST .../heartbeat`. A `{cancel: true}` reply
   aborts the run (same teardown path as any other run ending: pi/host/conductor killed,
   `killTree` on Windows) and it completes with `status: "failed"`, `error: "cancelled by
   platform"`. A `409` means the platform already reaped this run server-side — the worker
   stops driving it immediately and skips sending further events/complete (they'd just 409
   again), logging locally and moving on to the next claim.
4. **Events** — streamed throughout and batched (flushed every ~5s or every 20 events,
   whichever comes first, capped at 100 per POST): `run-start` (arm, seed, accordion commit
   sha), `sync` (one per pi sync — tailed straight from the host's own `host.jsonl`
   telemetry: rev, live tokens, block/fold counts, budget), `warn` (host-reported errors),
   `status-change` (done/failed/cancelling). Delivery is best-effort: a batch that fails
   after 3 retries is dropped and counted, never retried indefinitely — events are supporting
   telemetry, not the run's authoritative record.
5. **Complete** — `POST .../complete` with the full `record.json` contents, `status`
   (`"done"`/`"failed"`), the platform `room_id` if known, an `error` string on failure, and
   (if the session is ≤ 25 MB decoded) the run's pi session JSONL, gzipped and base64'd.
   Unlike events, `complete` retries hard — up to ~5 minutes of capped exponential
   backoff — before giving up. If it still fails, `record.json` stays on disk under the run
   directory and the worker logs loudly; nothing is lost, it just needs a manual resubmit
   once the platform is reachable again.

### Crash safety

An `executeRun` throw (pi crashed, the host wedged, anything) is caught around each claimed
run — it's folded into a `complete(failed, error: "executor threw: ...")` call and the worker
loop moves on to the next claim rather than dying. A `SIGINT`/`SIGTERM` to the worker process
(Ctrl-C, or a service manager stopping it) aborts whatever run is currently in flight and
makes a best-effort `complete(failed, "worker shutdown")` call before the process exits —
so a homeserver reboot or a deliberate restart doesn't leave an orphaned "running" row on the
platform.

### Self-update (`worker.autoUpdate`)

A worker fleet drifts: leave a machine running long enough and its checkout falls behind
`origin/main` — one worker has been observed sitting 4 PRs stale, and another burned a whole
run on ancient code. Self-update closes that gap without a human SSHing in: **when idle**
(never mid-run), the worker checks whether its own checkout (this bellows repo, not
`accordionRepo`) is behind `origin/main`, fast-forwards it, and exits cleanly so its supervisor
relaunches it on the new code.

This only works because the worker already runs under something that relaunches it on exit —
a Windows while-loop supervisor script, or a macOS LaunchAgent with `KeepAlive`. Self-update
itself never restarts the process in place; it just fast-forwards the checkout and calls
`process.exit(0)`, logging `[worker] self-update: <from>→<to> — exiting for supervisor
relaunch` first. See the background-service section below for both supervisor setups —
**self-update is a no-op improvement without one** (an unsupervised `node bin/bellows.mjs
worker --poll` that self-updates just exits and stays dead).

Checked (see `src/worker/selfUpdate.mjs`), in order:

1. **Dirty working tree** (`git status --porcelain` non-empty) → skipped. The same machine may
   also be a dev box with in-progress work — self-update never clobbers it.
2. **HEAD not on `main`** → skipped. A feature branch checked out for dev/debugging is never
   yanked out from under whoever's using it.
3. **No `origin` remote** → skipped.
4. **Fetch fails** (network, auth) → skipped, logged.
5. **Already up to date** → no-op, logged once (not every idle poll).
6. **Behind, but fast-forwardable** → fast-forwards (`merge --ff-only`), then exits for relaunch.
   If `package-lock.json` changed in the fast-forward, `npm ci` runs first (with
   `--include=dev` — bellows needs vite-node/vite/svelte, all devDependencies, at *runtime*,
   and the flag also defends against a fleet box exporting `NODE_ENV=production`). If npm ci
   fails, the *code* is rolled back (`git reset --hard` to the pre-update sha) so the worker
   keeps running the old code without relaunching — but note `node_modules` itself may be left
   partially installed by the failed npm ci (a WARN is logged saying so); if the worker
   misbehaves afterwards, run `npm install` in the checkout manually.
7. **Behind, but diverged** (ff-only refuses — e.g. a force-push, or local commits on `main`) →
   skipped, logged loudly. Never rewrites history unattended.

**Config** — `worker.autoUpdate` in `bench.config.json`, default `true` when absent (opt-out,
not opt-in):

```json
{ "worker": { "autoUpdate": false } }
```

**Kill switch** — `BELLOWS_NO_SELF_UPDATE=1` in the environment force-disables self-update
regardless of config, for a fleet-wide "stop touching checkouts right now" lever that doesn't
require editing every machine's `bench.config.json`.

**Check timing** — once (unthrottled) at worker startup, then at most once every ~10 minutes
thereafter, checked both after each completed run and during idle claim-polling (both share one
throttle clock, so a burst of short runs can't turn this into "check on every tick"). Every
worker also logs its own HEAD sha once at startup and includes it as `version` on every claim
request, purely for fleet visibility (the platform ignores the field today).

**Auth for the fetch.** `bellows` (a-Fig/bellows) is public, so the default case needs no
credential at all: a checkout whose `origin` is the anonymous HTTPS URL fetches and
fast-forwards with zero setup. Only a **private fork** needs a credential — for that, generate
an SSH keypair on the worker, add it as a read-only GitHub deploy key on the fork, and point
the checkout's `origin` remote at the SSH URL (scoped to one repo, no write access, easy to
revoke per-machine). Either way, self-update never needs a token with WRITE access — it only
ever fetches and fast-forwards.

**Known rollout risk: CRLF phantom-dirty checkouts.** A checkout with `core.autocrlf` drift
(common after copying/zipping a repo across OSes, or a stale `.gitattributes`) can show every
text file as modified in `git status --porcelain` even though the content is byte-for-byte the
same aside from line endings. Self-update's dirty check treats that exactly like real
uncommitted work and skips forever — permanently disabling self-update on that machine (watch
the logs for repeated `WARN: self-update skipped (dirty working tree)` lines).
This has actually been observed on this project's homeserver checkout. Before relying on
self-update on a given machine, confirm `git status --porcelain` is empty on a fresh idle
worker; if it isn't, normalize line endings once (`git config core.autocrlf false` — or `true`,
whichever matches the rest of the fleet — then `git add --renormalize . && git commit`) rather
than assuming self-update is broken.

### Running it as a background service

Self-update (above) only relaunches the worker on new code if something relaunches the process
after it exits — pick one of these per platform:

**Windows: PowerShell supervisor + Task Scheduler.** `scripts/bellows-worker-supervisor.ps1` is
the supervisor: a `while ($true)` loop that starts `node bin/bellows.mjs worker --poll`,
`Wait-Process`es on it, and relaunches after any exit (crash, `--once` exhaustion, or a
self-update relaunch) after a 10s pause. Run it directly, or point a Task Scheduler action at
it:

```powershell
powershell -File "C:\path\to\bellows\scripts\bellows-worker-supervisor.ps1" -BellowsDir "C:\path\to\bellows"
```

`-BellowsDir` defaults to a generic space-free placeholder (`C:\bellows`); always pass your
machine's real checkout path explicitly. Notes carried over from the original ad hoc version
of this script:
- **Space-free path matters for Task Scheduler.** A `-BellowsDir` (or the script's own path)
  containing spaces can break a bare `-File` argument in a Scheduled Task's action string —
  quote the whole action command, and prefer a space-free path for the *script* itself if
  Task Scheduler ever mangles the quoting.
- **The task must NOT use action-level "restart on failure".** This script's own `while(true)`
  loop is the supervisor; a Scheduled Task `RestartCount` on top of it can spawn a *second*
  supervisor competing for the same worker identity. The task's only jobs are: start this script
  at logon, and set `MultipleInstances = IgnoreNew` so a second logon (or manual re-run) doesn't
  stack duplicate supervisors.
- Every launch path in the script is wrapped in `try`/`catch` so a transient `Start-Process`
  failure logs and retries rather than silently killing the supervisor loop itself.

**macOS: LaunchAgent with `KeepAlive`.** A minimal launchd plist to keep `bellows worker`
running on a Mac homeserver (`~/Library/LaunchAgents/dev.bellows.worker.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.bellows.worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/bellows/bin/bellows.mjs</string>
    <string>worker</string>
    <string>--poll</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/bellows</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_TRIALS_API_KEY</key><string>at_...</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/path/to/bellows/worker.log</string>
  <key>StandardErrorPath</key><string>/path/to/bellows/worker.err.log</string>
</dict>
</plist>
```

`launchctl load ~/Library/LaunchAgents/dev.bellows.worker.plist` starts it; `KeepAlive`
restarts it if it ever exits (a `SIGINT`/`SIGTERM` still exits cleanly per the crash-safety
note above — this is just the belt-and-suspenders "come back up after a crash or reboot"),
and it's also what makes self-update's clean `process.exit(0)` relaunch onto new code rather
than just leaving the worker dead.

### Debugging: `--once`

`bellows worker --once` claims and executes at most one run, then exits — useful for
verifying a worker's config/connectivity/conductor list end to end without leaving a
long-running process around, or for a cron-style dispatch instead of a daemon.
