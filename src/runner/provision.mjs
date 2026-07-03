/**
 * Per-run directory provisioning: workspace/, agent/, accordion-home/.
 *
 * - workspace/  = rendered template (client with BASE+KEY injected, briefing).
 * - agent/      = PI_CODING_AGENT_DIR (settings.json + copied auth.json/models.json).
 * - accordion-home/ = empty dir shared by pi (ACCORDION_HOME) and the host.
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, splitModel } from "./config.mjs";

export const TEMPLATE_DIR = path.join(REPO_ROOT, "templates", "workspace");
export const BRIEFING_TMPL = path.join(TEMPLATE_DIR, "AGENT_BRIEFING.md.tmpl");

/** The kickoff prompt sent over RPC to start the agent. Stable string. */
export const KICKOFF_PROMPT =
  "Read AGENT_BRIEFING.md and complete the benchmark run it describes, then finalize.";

/**
 * Render the briefing text for a run. Pure — safe to hash for the fingerprint.
 * @param {object} args
 * @param {string} args.roomId
 * @param {string} args.agentName
 * @param {string} args.runLabel
 * @param {string} args.problemsText
 * @param {string} [args.tmpl]  raw briefing template (defaults to file on disk)
 */
export function renderBriefing({ roomId, agentName, runLabel, problemsText, tmpl }) {
  const raw = tmpl ?? fs.readFileSync(BRIEFING_TMPL, "utf8");
  return applyPlaceholders(raw, {
    __ROOM_ID__: roomId,
    __AGENT_NAME__: agentName,
    __RUN_LABEL__: runLabel,
    __PROBLEMS__: problemsText,
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

/**
 * Render the workspace client from the template, injecting the platform base +
 * api key placeholders. Returns the rendered client text (also written to disk
 * by provisionRun).
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
 * Build the settings.json object for a run's agent dir.
 * @param {object} args
 * @param {string} args.model            "provider:modelId"
 * @param {string} args.thinkingLevel
 * @param {string} args.accordionRepo
 */
export function buildSettings({ model, thinkingLevel, accordionRepo }) {
  const { provider, modelId } = splitModel(model);
  return {
    provider,
    model: modelId,
    defaultThinkingLevel: thinkingLevel,
    compaction: { enabled: false },
    extensions: [path.join(accordionRepo, "extension", "accordion.ts").split(path.sep).join("/")],
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
 * @param {string} args.problemsText
 * @param {string} args.apiKey             real platform key (NOT logged)
 * @returns {{ workspaceDir:string, agentDir:string, accordionHome:string,
 *             briefing:string, settings:object }}
 */
export function provisionRun(args) {
  const { runDir, spec, config, roomId, agentName, runLabel, problemsText, apiKey } = args;
  const workspaceDir = path.join(runDir, "workspace");
  const agentDir = path.join(runDir, "agent");
  const accordionHome = path.join(runDir, "accordion-home");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(accordionHome, { recursive: true });

  // 1. Copy the template into workspace, rendering placeholders. The briefing
  //    template (.tmpl) is rendered to AGENT_BRIEFING.md; the client gets its
  //    BASE/KEY injected; everything else is copied verbatim.
  const briefing = renderBriefing({ roomId, agentName, runLabel, problemsText });
  copyWorkspaceTemplate(workspaceDir, { base: config.platformBase, apiKey, briefing });

  // 2. agent dir: settings + copied credentials.
  const settings = buildSettings({
    model: spec.model,
    thinkingLevel: spec.thinkingLevel || "medium",
    accordionRepo: config.accordionRepo,
  });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
  copyCredential(config.piAgentDir, agentDir, "auth.json");
  copyCredential(config.piAgentDir, agentDir, "models.json");

  return { workspaceDir, agentDir, accordionHome, briefing, settings };
}

/** Copy the committed workspace template into dest, rendering placeholders. */
export function copyWorkspaceTemplate(dest, { base, apiKey, briefing }) {
  for (const ent of fs.readdirSync(TEMPLATE_DIR, { withFileTypes: true })) {
    const src = path.join(TEMPLATE_DIR, ent.name);
    if (ent.name === "AGENT_BRIEFING.md.tmpl") {
      fs.writeFileSync(path.join(dest, "AGENT_BRIEFING.md"), briefing);
      continue;
    }
    if (ent.name === "slopcode_client.py") {
      const rendered = renderClient(fs.readFileSync(src, "utf8"), base, apiKey);
      fs.writeFileSync(path.join(dest, ent.name), rendered);
      continue;
    }
    // Verbatim copy for anything else (files or dirs).
    if (ent.isDirectory()) fs.cpSync(src, path.join(dest, ent.name), { recursive: true });
    else fs.copyFileSync(src, path.join(dest, ent.name));
  }
}

/** Copy a credential file programmatically (never read/log its contents). */
function copyCredential(srcDir, destDir, name) {
  const src = path.join(srcDir, name);
  if (!fs.existsSync(src)) {
    throw new Error(`Required credential ${name} not found in piAgentDir: ${src}`);
  }
  fs.copyFileSync(src, path.join(destDir, name));
}
