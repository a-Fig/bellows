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

/** Set to "1" to skip patchDeepSeekCompat entirely (provisionRun then copies models.json byte-for-byte, today's behavior). */
export const DEEPSEEK_COMPAT_KILL_SWITCH_ENV = "BELLOWS_NO_DEEPSEEK_COMPAT";

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
 * @param {(m:string)=>void} [args.log]     diagnostics only (e.g. deepseek compat patch summary);
 *   never receives key material.
 * @returns {{ workspaceDir:string, agentDir:string, accordionHome:string,
 *             briefing:string, settings:object, deepseekCompat:boolean }}
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
  const settings = buildSettings({
    model: spec.model,
    thinkingLevel: spec.thinkingLevel || "medium",
    accordionRepo: config.accordionRepo,
  });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
  copyCredential(config.piAgentDir, agentDir, "auth.json");
  copyCredential(config.piAgentDir, agentDir, "models.json");

  // 3. Bench-scoped DeepSeek reasoning-compat patch — mutates only the COPY
  //    just written above, never config.piAgentDir's live source file. See
  //    applyDeepSeekCompat's jsdoc for why this is needed.
  const deepseekCompat = applyDeepSeekCompat({ agentDir, log });

  return { workspaceDir, agentDir, accordionHome, briefing, settings, deepseekCompat };
}

/**
 * Patch every DeepSeek model entry that pi's own baseUrl-based compat
 * auto-detect can't see, in place, on an already-parsed models.json.
 *
 * pi (`@earendil-works/pi-ai`'s `detectCompat` in `dist/api/openai-completions.js`)
 * only infers DeepSeek compat — `reasoning: true`-gated `thinkingFormat:
 * "deepseek"` request shaping, and injecting `reasoning_content` on replayed
 * assistant messages — when `provider === "deepseek"` or the provider's
 * `baseUrl` contains `"deepseek.com"`. Routed through TokenRouter
 * (`baseUrl: "https://api.tokenrouter.com/v1"`), a `deepseek/deepseek-v4-flash`
 * entry matches neither, so pi silently (a) clamps any requested
 * thinkingLevel to "off" (`getSupportedThinkingLevels` returns `["off"]` when
 * `!model.reasoning`) and (b) never replays real `reasoning_content`, forcing
 * bellows' `deepseekReplayCompat.mjs` extension to backfill a sentinel on
 * every tool-call turn.
 *
 * The fix is declarative: a model entry that explicitly carries
 * `reasoning: true` plus
 * `compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" }`
 * gets the identical request shaping and replay behavior pi would give a
 * native deepseek.com entry (`getCompat` prefers `model.compat.*` over the
 * auto-detected value via `??`) — real reasoning_content is captured and
 * replayed, thinkingLevel medium becomes real, and the single-space filler
 * extension only has to cover genuine gaps.
 *
 * Only touches entries that need it: a provider block whose `baseUrl`
 * already contains "deepseek.com" is left alone (auto-detect already fires
 * there), and a model id not matching `/deepseek/i` is never touched. An
 * entry that already declares `reasoning` and/or either compat field
 * explicitly is left exactly as written — this only fills gaps, never
 * overrides an operator's explicit choice.
 * @param {any} modelsJson  parsed models.json (mutated in place)
 * @returns {string[]} "provider:modelId" ids that were changed (ids only — never key material)
 */
export function patchDeepSeekCompat(modelsJson) {
  const patchedIds = [];
  const providers = modelsJson && typeof modelsJson === "object" ? modelsJson.providers : undefined;
  if (!providers || typeof providers !== "object") return patchedIds;
  for (const [providerId, block] of Object.entries(providers)) {
    if (!block || typeof block !== "object" || !Array.isArray(block.models)) continue;
    const baseUrl = typeof block.baseUrl === "string" ? block.baseUrl.toLowerCase() : "";
    if (baseUrl.includes("deepseek.com")) continue; // pi's own auto-detect already fires here
    for (const entry of block.models) {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
      if (!/deepseek/i.test(entry.id)) continue;
      let changed = false;
      if (entry.reasoning === undefined) {
        entry.reasoning = true;
        changed = true;
      }
      const existingCompat = entry.compat && typeof entry.compat === "object" ? entry.compat : {};
      const nextCompat = { ...existingCompat };
      if (nextCompat.requiresReasoningContentOnAssistantMessages === undefined) {
        nextCompat.requiresReasoningContentOnAssistantMessages = true;
        changed = true;
      }
      if (nextCompat.thinkingFormat === undefined) {
        nextCompat.thinkingFormat = "deepseek";
        changed = true;
      }
      if (changed) {
        entry.compat = nextCompat;
        patchedIds.push(`${providerId}:${entry.id}`);
      }
    }
  }
  return patchedIds;
}

/**
 * Apply patchDeepSeekCompat to the models.json already copied into a run's
 * agent dir, rewriting the file only when something changed. Honors the
 * BELLOWS_NO_DEEPSEEK_COMPAT=1 kill switch (skip entirely, copy stays
 * byte-for-byte identical to config.piAgentDir's source). Never touches the
 * source file — only the per-run copy at `<agentDir>/models.json`. Logs at
 * most one summary line, model ids only, never key material.
 * @param {object} args
 * @param {string} args.agentDir  the run's agent dir (models.json already copied here)
 * @param {(m:string)=>void} [args.log]
 * @returns {boolean} true when at least one model entry was patched
 */
export function applyDeepSeekCompat({ agentDir, log = () => {} }) {
  if (process.env[DEEPSEEK_COMPAT_KILL_SWITCH_ENV] === "1") return false;
  const modelsPath = path.join(agentDir, "models.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  } catch (e) {
    // Diagnostics only — never fail provisioning over an unreadable/malformed
    // copy (copyCredential above already guarantees the file was written; a
    // parse failure here means the operator's own models.json is malformed).
    log(`[provision] deepseek compat: skipped (could not read/parse models.json: ${e.message})`);
    return false;
  }
  const patchedIds = patchDeepSeekCompat(parsed);
  if (patchedIds.length === 0) return false;
  fs.writeFileSync(modelsPath, JSON.stringify(parsed, null, 2));
  log(
    `[provision] deepseek compat: patched ${patchedIds.length} model entr${patchedIds.length === 1 ? "y" : "ies"} (${patchedIds.join(", ")})`,
  );
  return true;
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
