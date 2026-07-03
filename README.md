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
| `src/host/` | Headless conductor host — dials the accordion extension's WS like the GUI does, runs a conductor, sends fold plans. Runs under vite-node (Svelte runes). |
| `src/runner/` | Trial runner — spawns `pi --mode rpc` per run with isolated `PI_CODING_AGENT_DIR` + `ACCORDION_HOME`, enforces caps, drives the platform run, collects results. |
| `src/report/` | Static HTML report from RunRecords, cross-trial comparison by fingerprint. |
| `templates/workspace/` | Per-run workspace template (slopcode client + agent briefing). |
| `trials/` | Trial specs (YAML). |
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
```

Runs are the first-class record. Every run carries a condition fingerprint (model, budget,
problems, template hash, pi version, accordion commit, conductor); the report compares any
set of runs and warns loudly when fingerprints don't match.
