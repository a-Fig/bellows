/**
 * Per-run directory provisioning: workspace/, agent/, accordion-home/.
 *
 * - workspace/  = rendered template (client with BASE+KEY injected, briefing,
 *   and — when meta is supplied — a `.slopcode_meta.json` the slopcode client
 *   reads at join time to label the leaderboard row).
 * - agent/      = PI_CODING_AGENT_DIR (settings.json + copied auth.json/models.json).
 * - accordion-home/ = empty dir shared by pi (ACCORDION_HOME) and the host.
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, splitModel } from "./config.mjs";

export const TEMPLATE_DIR = path.join(REPO_ROOT, "templates", "workspace");
export const BRIEFING_TMPL = path.join(TEMPLATE_DIR, "AGENT_BRIEFING.md.tmpl");
export const DEEPSEEK_REPLAY_EXTENSION = path.join(
  REPO_ROOT,
  "src",
  "runner",
  "extensions",
  "deepseekReplayCompat.mjs",
);

/** The kickoff prompt sent over RPC to start the agent. Stable string. */
export const KICKOFF_PROMPT =
  "Read AGENT_BRIEFING.md and complete the benchmark run it describes, then finalize.";

/**
 * Render the briefing text for a run. Pure — safe to hash for the fingerprint.
 *
 * The briefing is game+room+label only: the agent self-serves the game client
 * (`get-client slopcode`), joins the room, sets its label, and follows the
 * SlopCode guide. It deliberately does NOT enumerate problems — the room's own
 * problem set is authoritative (see roomConfig.mjs / the pooled-vs-scoped guards
 * in config.mjs for local specs and worker loop.mjs's resolveWorkerRoom for
 * claimed specs). So there is no `__PROBLEMS__` token to substitute.
 * @param {object} args
 * @param {string} args.roomId
 * @param {string} args.agentName
 * @param {string} args.runLabel
 * @param {string} [args.platformBase]  platform URL, rendered into the briefing for reference
 * @param {string} [args.tmpl]  raw briefing template (defaults to file on disk)
 */
export function renderBriefing({ roomId, agentName, runLabel, platformBase, tmpl }) {
  const raw = tmpl ?? fs.readFileSync(BRIEFING_TMPL, "utf8");
  return applyPlaceholders(raw, {
    __PLATFORM_BASE__: platformBase ?? "",
    __ROOM_ID__: roomId,
    __AGENT_NAME__: agentName,
    __RUN_LABEL__: runLabel,
  });
}

/** Literal-substitute every "__KEY__" occurrence. */
export function applyPlaceholders(text, map) {
  let out = text;
  for (const [k, v] of Object.entries(map)) {
    out = out.split(k).join(v);
  }
  return out;
}

/** Filename the slopcode client reads at join time for leaderboard labels. */
export const META_FILE = ".slopcode_meta.json";

/**
 * Render the vanilla platform client from the template, injecting only the
 * platform base + api key placeholders. Returns the rendered client text (also
 * written to disk by provisionRun).
 *
 * Join metadata is NOT injected into the client any more. The old bellows-only
 * slopcode fork carried a `__SLOPCODE_META_B64__` placeholder + `_load_meta()`;
 * the platform's vanilla client has neither. Leaderboard labels now travel via a
 * `.slopcode_meta.json` file written next to the client (see writeJoinMeta),
 * which the slopcode client's cmd_join reads from its CWD.
 * @param {string} clientTmpl  template contents with __PLATFORM_BASE__ / __API_KEY__
 * @param {string} base
 * @param {string} apiKey
 */
export function renderClient(clientTmpl, base, apiKey) {
  return applyPlaceholders(clientTmpl, {
    __PLATFORM_BASE__: base,
    __API_KEY__: apiKey,
  });
}

/**
 * Write the optional `.slopcode_meta.json` the slopcode client reads at join
 * time. `meta` is buildJoinMeta's output — the platform whitelists exactly
 * {display_name, model, conductor, trial} (strings) + {seed} (int), so this is
 * already the right shape. A no-op when meta is undefined (the client treats an
 * absent file as "no meta" and joins with today's body exactly).
 * @param {string} dir   workspace directory (the client's CWD at join time)
 * @param {object} [meta]
 */
export function writeJoinMeta(dir, meta) {
  if (meta === undefined) return;
  fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta, null, 2));
}

/**
 * Build the settings.json object for a run's agent dir.
 * @param {object} args
 * @param {string} args.model            "provider:modelId"
 * @param {string} args.thinkingLevel
 * @param {string} args.accordionRepo
 */
export function buildSettings({ model, thinkingLevel, accordionRepo }) {
  const { provider, modelId } = splitModel(model);
  // pi's Settings has no top-level provider/model keys — findInitialModel reads
  // defaultProvider/defaultModel (settings-manager.d.ts). Wrong keys are silently
  // ignored and pi falls back to "first model with a valid API key".
  return {
    defaultProvider: provider,
    defaultModel: modelId,
    defaultThinkingLevel: thinkingLevel,
    compaction: { enabled: false },
    extensions: [
      path.join(accordionRepo, "extension", "accordion.ts").split(path.sep).join("/"),
      DEEPSEEK_REPLAY_EXTENSION.split(path.sep).join("/"),
    ],
  };
}

/**
 * Provision all three directories for one run. Does NOT spawn anything.
 * @param {object} args
 * @param {string} args.runDir             runs/<trial>/<arm>-<seed>
 * @param {import("../types.ts").TrialSpec} args.spec
 * @param {import("../types.ts").BenchConfig} args.config
 * @param {string} args.roomId
 * @param {string} args.agentName
 * @param {string} args.runLabel
 * @param {string} args.apiKey             real platform key (NOT logged)
 * @param {object} [args.meta]              optional join metadata (display_name/model/conductor/
 *   trial/seed) written to workspace/.slopcode_meta.json and surfaced on the leaderboard in
 *   place of the raw agent name — see writeJoinMeta.
 * @param {(m:string)=>void} [args.log]
 * @returns {{ workspaceDir:string, agentDir:string, accordionHome:string,
 *             briefing:string, settings:object, warnings:string[] }}
 */
export function provisionRun(args) {
  const { runDir, spec, config, roomId, agentName, runLabel, apiKey, meta, log = () => {} } = args;
  const workspaceDir = path.join(runDir, "workspace");
  const agentDir = path.join(runDir, "agent");
  const accordionHome = path.join(runDir, "accordion-home");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(accordionHome, { recursive: true });

  // 1. Copy the template into workspace, rendering placeholders. The briefing
  //    template (.tmpl) is rendered to AGENT_BRIEFING.md; the client gets its
  //    BASE/KEY injected; join metadata is written as .slopcode_meta.json;
  //    everything else is copied verbatim.
  const briefing = renderBriefing({ roomId, agentName, runLabel, platformBase: config.platformBase });
  copyWorkspaceTemplate(workspaceDir, { base: config.platformBase, apiKey, briefing, meta });

  // 2. agent dir: settings + copied credentials.
  const thinkingLevel = spec.thinkingLevel || "medium";
  const settings = buildSettings({
    model: spec.model,
    thinkingLevel,
    accordionRepo: config.accordionRepo,
  });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
  copyCredential(config.piAgentDir, agentDir, "auth.json");
  copyCredential(config.piAgentDir, agentDir, "models.json");

  const warnings = [];
  const thinkingWarning = checkThinkingLevelWarning({ agentDir, model: spec.model, thinkingLevel, log });
  if (thinkingWarning) warnings.push(thinkingWarning);

  return { workspaceDir, agentDir, accordionHome, briefing, settings, warnings };
}

/**
 * Best-effort diagnostic: does the just-copied models.json declare
 * `reasoning:true` for this run's model when a non-"off" thinkingLevel was
 * requested? If not, pi clamps thinking to off regardless of settings.json's
 * defaultThinkingLevel, silently diverging from what the trial asked for
 * (found alongside — not the cause of — the 2026-07-18 sentinel-echo false
 * completions; see reports/2026-07-18-devmain-xjq-premature-stop-investigation.md).
 *
 * Diagnostics only: never throws, and a malformed/missing models.json or an
 * unresolvable model just means no warning is produced.
 * @param {object} args
 * @param {string} args.agentDir    directory containing the just-copied models.json
 * @param {string} args.model       "provider:modelId"
 * @param {string} args.thinkingLevel
 * @param {(m:string)=>void} [args.log]
 * @returns {string|null} the warning text (already logged), or null
 */
export function checkThinkingLevelWarning({ agentDir, model, thinkingLevel, log = () => {} }) {
  if (thinkingLevel === "off") return null;
  try {
    const { provider, modelId } = splitModel(model);
    const parsed = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    const providerModels = parsed?.providers?.[provider]?.models;
    const modelEntry = Array.isArray(providerModels) ? providerModels.find((m) => m && m.id === modelId) : undefined;
    if (modelEntry && modelEntry.reasoning === true) return null;
    const warning =
      `thinkingLevel '${thinkingLevel}' requested but models.json entry for ${model} lacks reasoning:true — pi will clamp thinking to off`;
    log(`[provision] WARNING: ${warning}`);
    return warning;
  } catch {
    // Never fail provisioning over a diagnostics-only check.
    return null;
  }
}

/** Copy the committed workspace template into dest, rendering placeholders. */
export function copyWorkspaceTemplate(dest, { base, apiKey, briefing, meta }) {
  for (const ent of fs.readdirSync(TEMPLATE_DIR, { withFileTypes: true })) {
    const src = path.join(TEMPLATE_DIR, ent.name);
    if (ent.name === "AGENT_BRIEFING.md.tmpl") {
      fs.writeFileSync(path.join(dest, "AGENT_BRIEFING.md"), briefing);
      continue;
    }
    if (ent.name === "platform_client.py") {
      const rendered = renderClient(fs.readFileSync(src, "utf8"), base, apiKey);
      fs.writeFileSync(path.join(dest, ent.name), rendered);
      continue;
    }
    // Verbatim copy for anything else (files or dirs).
    if (ent.isDirectory()) fs.cpSync(src, path.join(dest, ent.name), { recursive: true });
    else fs.copyFileSync(src, path.join(dest, ent.name));
  }
  // The join-meta file lives alongside the client so the slopcode client's
  // cmd_join finds it in its CWD. Written last, after the verbatim pass, so a
  // stray committed .slopcode_meta.json could never shadow the real one.
  writeJoinMeta(dest, meta);
}

/** Copy a credential file programmatically (never read/log its contents). */
function copyCredential(srcDir, destDir, name) {
  const src = path.join(srcDir, name);
  if (!fs.existsSync(src)) {
    throw new Error(`Required credential ${name} not found in piAgentDir: ${src}`);
  }
  fs.copyFileSync(src, path.join(destDir, name));
}
