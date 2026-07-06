# bellows

Conductor benchmarking rig for [Accordion](https://github.com/a-Fig/Accordion). Runs pi coding
agents on [agent-trials](https://github.com/a-Fig/agent-trials) SlopCode problems with different
conductors attached, in parallel, headlessly — and collects everything the old manual workflow
couldn't see: cost, tokens, cache behavior, per-turn usage, and fold telemetry.

*(The bellows is the part of an accordion that pumps air through it.)*

## Layout

| path | what |
|---|---|
| `src/types.ts` | Shared contracts: TrialSpec, RunRecord, Fingerprint, HostEvent. The seam between components. |
| `src/host/` | Headless conductor host — dials the accordion extension's WS like the GUI does, runs a conductor, sends fold plans. Runs under vite-node (Svelte runes). `remoteConductor.ts` is the client for an **external** (out-of-process) conductor, arm syntax `external:<id>` — see [TUTORIAL.md](TUTORIAL.md#external-conductors-externalid). |
| `src/runner/` | Trial runner — spawns `pi --mode rpc` per run with isolated `PI_CODING_AGENT_DIR` + `ACCORDION_HOME`, enforces caps, drives the platform run, collects results. Also spawns/discovers `external:<id>` conductor processes (`spawnExternalConductor` in `run.mjs`). |
| `src/report/` | Static HTML report from RunRecords, cross-trial comparison by fingerprint. |
| `src/worker/` | `bellows worker` daemon — the execution-plane half of the platform control loop: claims runs from `/api/bench/workers/claim`, drives them through `src/runner/run.mjs`'s `executeRun`, streams heartbeats/events, reports `complete`. See [TUTORIAL.md](TUTORIAL.md#worker-mode-bellows-worker). |
| `templates/workspace/` | Per-run workspace template (slopcode client + agent briefing). |
| `trials/` | Trial specs (YAML). |
| `test/fixtures/` | `conductors/echo-conductor/` — a minimal external-conductor reference/test fixture (no GPU/model dependency). |
| `runs/` | Output (gitignored): RunRecords + artifacts. |

## Setup

```bash
npm install
cp bench.config.example.json bench.config.json   # edit paths for this machine
set AGENT_TRIALS_API_KEY=at_...                   # your platform account key
```

Requires: a local Accordion checkout, pi on PATH, provider keys in `~/.pi/agent/auth.json`.

## Usage

```bash
node bin/bellows.mjs run trials/example.yaml     # run a trial
node bin/bellows.mjs report                      # render runs/ -> report.html
node bin/bellows.mjs worker --poll               # claim + execute runs the platform dispatches
```

Runs are the first-class record. Every run carries a condition fingerprint (model, budget,
problems, template hash, pi version, accordion commit, conductor); the report compares any
set of runs and warns loudly when fingerprints don't match.

To bench an unmerged conductor PR, add `accordionRef: <branch|tag|sha>` to the trial spec —
bellows fetches that ref and pins a detached Accordion worktree per run, without touching the
main checkout (see TUTORIAL.md → *Bench a specific Accordion branch/PR*).
