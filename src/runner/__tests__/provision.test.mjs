import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyPlaceholders,
  renderClient,
  renderBriefing,
  buildSettings,
  writeJoinMeta,
  copyWorkspaceTemplate,
  patchDeepSeekCompat,
  applyDeepSeekCompat,
  provisionRun,
  DEEPSEEK_COMPAT_KILL_SWITCH_ENV,
  META_FILE,
} from "../provision.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");
const CLIENT_TMPL = path.join(REPO, "templates", "workspace", "platform_client.py");
const BRIEFING_TMPL = path.join(REPO, "templates", "workspace", "AGENT_BRIEFING.md.tmpl");

describe("applyPlaceholders", () => {
  it("substitutes every occurrence", () => {
    expect(applyPlaceholders("a __X__ b __X__ __Y__", { __X__: "1", __Y__: "2" })).toBe("a 1 b 1 2");
  });
});

describe("renderClient", () => {
  it("injects base + key into the committed template", () => {
    const tmpl = fs.readFileSync(CLIENT_TMPL, "utf8");
    const out = renderClient(tmpl, "https://example.test", "SECRETKEY");
    expect(out).toContain('BASE = "https://example.test"');
    expect(out).toContain('KEY  = "SECRETKEY"');
    expect(out).not.toContain("__PLATFORM_BASE__");
    expect(out).not.toContain("__API_KEY__");
  });

  it("the committed template contains NO real key (placeholders only)", () => {
    const tmpl = fs.readFileSync(CLIENT_TMPL, "utf8");
    expect(tmpl).toContain("__PLATFORM_BASE__");
    expect(tmpl).toContain("__API_KEY__");
    // guard against a real agent-trials key ever being committed
    expect(tmpl).not.toMatch(/\bat_[A-Za-z0-9_-]{10,}/);
    expect(tmpl).not.toMatch(/\bsk-[A-Za-z0-9]{20,}/);
  });

  it("the vanilla client carries NO meta placeholder (meta travels via .slopcode_meta.json)", () => {
    const tmpl = fs.readFileSync(CLIENT_TMPL, "utf8");
    // The old bellows fork had __SLOPCODE_META_B64__; the vanilla client must not.
    expect(tmpl).not.toContain("__SLOPCODE_META_B64__");
  });
});

describe("writeJoinMeta / copyWorkspaceTemplate — join metadata as a file", () => {
  const dirs = [];
  const mkdir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-prov-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  const META = {
    display_name: "keel · deepseek-v4-flash · s1",
    model: "token-router:deepseek/deepseek-v4-flash",
    conductor: "external:thermocline",
    trial: "t1",
    seed: 1,
  };

  it("writeJoinMeta writes exactly buildJoinMeta's whitelisted shape as JSON", () => {
    const dir = mkdir();
    writeJoinMeta(dir, META);
    const written = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), "utf8"));
    expect(written).toEqual(META);
    // The platform whitelist is display_name/model/conductor/trial (strings) + seed (int).
    expect(Object.keys(written).sort()).toEqual(["conductor", "display_name", "model", "seed", "trial"]);
    expect(Number.isInteger(written.seed)).toBe(true);
  });

  it("writeJoinMeta is a no-op when meta is undefined (client joins with today's body)", () => {
    const dir = mkdir();
    writeJoinMeta(dir, undefined);
    expect(fs.existsSync(path.join(dir, META_FILE))).toBe(false);
  });

  it("copyWorkspaceTemplate writes the meta file alongside the rendered client", () => {
    const dir = mkdir();
    copyWorkspaceTemplate(dir, {
      base: "https://example.test",
      apiKey: "SECRETKEY",
      briefing: "briefing body",
      meta: META,
    });
    // client rendered with real base/key, no leftover placeholders
    const client = fs.readFileSync(path.join(dir, "platform_client.py"), "utf8");
    expect(client).toContain('BASE = "https://example.test"');
    expect(client).not.toContain("__API_KEY__");
    // briefing landed
    expect(fs.readFileSync(path.join(dir, "AGENT_BRIEFING.md"), "utf8")).toBe("briefing body");
    // meta file landed with the right content
    const written = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), "utf8"));
    expect(written).toEqual(META);
  });

  it("copyWorkspaceTemplate writes no meta file when meta is omitted", () => {
    const dir = mkdir();
    copyWorkspaceTemplate(dir, {
      base: "https://example.test",
      apiKey: "SECRETKEY",
      briefing: "briefing body",
      meta: undefined,
    });
    expect(fs.existsSync(path.join(dir, META_FILE))).toBe(false);
  });
});

describe("renderBriefing", () => {
  it("wires room/name/label/base and leaves no unrendered placeholders", () => {
    const tmpl = fs.readFileSync(BRIEFING_TMPL, "utf8");
    const out = renderBriefing({
      roomId: "ROOM123",
      agentName: "agent_x",
      runLabel: "t/keel/1",
      platformBase: "https://example.test",
      tmpl,
    });
    expect(out).toContain("ROOM123");
    expect(out).toContain("agent_x");
    expect(out).toContain('label "t/keel/1"');
    expect(out).toContain("https://example.test");
    // the agent self-serves the game client from the platform
    expect(out).toContain("get-client slopcode");
    // no placeholder should survive rendering — including the removed __PROBLEMS__
    expect(out).not.toContain("__ROOM_ID__");
    expect(out).not.toContain("__AGENT_NAME__");
    expect(out).not.toContain("__RUN_LABEL__");
    expect(out).not.toContain("__PLATFORM_BASE__");
    expect(out).not.toContain("__PROBLEMS__");
  });
});

describe("buildSettings", () => {
  it("splits provider:model, disables compaction, and wires both runtime extensions", () => {
    const s = buildSettings({
      model: "token-router:deepseek/deepseek-v4-flash",
      thinkingLevel: "medium",
      accordionRepo: "C:/acc",
    });
    // pi reads defaultProvider/defaultModel (settings-manager.d.ts); a top-level
    // provider/model key is silently ignored and pi falls back to any keyed model.
    expect(s.defaultProvider).toBe("token-router");
    expect(s.defaultModel).toBe("deepseek/deepseek-v4-flash");
    expect(s.provider).toBeUndefined();
    expect(s.model).toBeUndefined();
    expect(s.defaultThinkingLevel).toBe("medium");
    expect(s.compaction).toEqual({ enabled: false });
    expect(s.extensions[0]).toContain("extension/accordion.ts");
    expect(s.extensions[1]).toContain("src/runner/extensions/deepseekReplayCompat.mjs");
  });

  it("points the accordion extension at the EFFECTIVE repo (a pinned accordionRef worktree)", () => {
    // When a run pins an accordionRef, executeRun hands buildSettings the pinned
    // worktree path as accordionRepo — the extension must resolve out of that tree.
    const worktree = "C:/runs/_accordion/deadbeef1234";
    const s = buildSettings({
      model: "token-router:deepseek/deepseek-v4-flash",
      thinkingLevel: "medium",
      accordionRepo: worktree,
    });
    expect(s.extensions[0]).toBe("C:/runs/_accordion/deadbeef1234/extension/accordion.ts");
  });
});

describe("patchDeepSeekCompat — pure transform", () => {
  // A realistic-looking canary key, shaped like the live token-router entry's
  // apiKey. Never asserted to appear anywhere in output — only ever asserted ABSENT.
  const CANARY_KEY = "sk-canaryDoNotLeakThisFakeKey00000000000";

  it("patches a bare token-router deepseek entry (reasoning:true + compat)", () => {
    const json = {
      providers: {
        "token-router": {
          baseUrl: "https://api.tokenrouter.com/v1",
          api: "openai-completions",
          apiKey: CANARY_KEY,
          models: [{ id: "deepseek/deepseek-v4-flash" }],
        },
      },
    };
    const patched = patchDeepSeekCompat(json);
    expect(patched).toEqual(["token-router:deepseek/deepseek-v4-flash"]);
    const entry = json.providers["token-router"].models[0];
    expect(entry.reasoning).toBe(true);
    expect(entry.compat).toEqual({
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    });
    // apiKey sits untouched alongside — the transform never reads/copies it.
    expect(json.providers["token-router"].apiKey).toBe(CANARY_KEY);
  });

  it("does NOT patch entries under a provider whose baseUrl is a deepseek.com host (pi's own auto-detect already fires)", () => {
    const json = {
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.com/v1",
          models: [{ id: "deepseek-chat" }],
        },
      },
    };
    const patched = patchDeepSeekCompat(json);
    expect(patched).toEqual([]);
    expect(json.providers.deepseek.models[0]).toEqual({ id: "deepseek-chat" });
  });

  it("does NOT patch non-deepseek model ids sharing a provider block with a deepseek entry", () => {
    const json = {
      providers: {
        "token-router": {
          baseUrl: "https://api.tokenrouter.com/v1",
          models: [
            { id: "deepseek/deepseek-v4-flash" },
            { id: "openai/gpt-5.4-nano" },
            { id: "qwen/qwen3.6-plus" },
          ],
        },
      },
    };
    const patched = patchDeepSeekCompat(json);
    expect(patched).toEqual(["token-router:deepseek/deepseek-v4-flash"]);
    const models = json.providers["token-router"].models;
    expect(models[1]).toEqual({ id: "openai/gpt-5.4-nano" });
    expect(models[2]).toEqual({ id: "qwen/qwen3.6-plus" });
  });

  it("preserves an entry's existing explicit compat fields — never overwrites a different value", () => {
    const json = {
      providers: {
        "token-router": {
          baseUrl: "https://api.tokenrouter.com/v1",
          models: [
            {
              id: "deepseek/deepseek-v4-flash",
              reasoning: true,
              compat: {
                requiresReasoningContentOnAssistantMessages: false,
                thinkingFormat: "qwen",
                someOtherCompatField: "keep-me",
              },
            },
          ],
        },
      },
    };
    const before = JSON.parse(JSON.stringify(json));
    const patched = patchDeepSeekCompat(json);
    expect(patched).toEqual([]); // nothing changed — every touched field was already explicit
    expect(json).toEqual(before);
  });

  it("fills only the missing compat block when reasoning:true is already explicit", () => {
    const json = {
      providers: {
        "token-router": {
          baseUrl: "https://api.tokenrouter.com/v1",
          models: [{ id: "deepseek/deepseek-v4-flash", reasoning: true }],
        },
      },
    };
    const patched = patchDeepSeekCompat(json);
    expect(patched).toEqual(["token-router:deepseek/deepseek-v4-flash"]);
    const entry = json.providers["token-router"].models[0];
    expect(entry.reasoning).toBe(true);
    expect(entry.compat).toEqual({
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    });
  });

  it("fills only the missing thinkingFormat when requiresReasoningContentOnAssistantMessages is already explicit", () => {
    const json = {
      providers: {
        "token-router": {
          baseUrl: "https://api.tokenrouter.com/v1",
          models: [
            {
              id: "deepseek/deepseek-v4-flash",
              compat: { requiresReasoningContentOnAssistantMessages: true },
            },
          ],
        },
      },
    };
    const patched = patchDeepSeekCompat(json);
    expect(patched).toEqual(["token-router:deepseek/deepseek-v4-flash"]);
    const entry = json.providers["token-router"].models[0];
    expect(entry.reasoning).toBe(true);
    expect(entry.compat).toEqual({
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    });
  });

  it("never throws on missing/malformed shapes — degrades to no patches", () => {
    expect(patchDeepSeekCompat(null)).toEqual([]);
    expect(patchDeepSeekCompat({})).toEqual([]);
    expect(patchDeepSeekCompat({ providers: {} })).toEqual([]);
    // openrouter-shaped block from the real models.json: modelOverrides, no `models` array.
    expect(
      patchDeepSeekCompat({ providers: { openrouter: { modelOverrides: { "some/model": { maxTokens: 1 } } } } }),
    ).toEqual([]);
  });
});

describe("applyDeepSeekCompat — provisioned-copy file I/O", () => {
  const dirs = [];
  const origEnv = process.env[DEEPSEEK_COMPAT_KILL_SWITCH_ENV];
  afterEach(() => {
    if (origEnv === undefined) delete process.env[DEEPSEEK_COMPAT_KILL_SWITCH_ENV];
    else process.env[DEEPSEEK_COMPAT_KILL_SWITCH_ENV] = origEnv;
    for (const d of dirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
  const CANARY_KEY = "sk-canaryDoNotLeakThisFakeKey00000000000";
  const mkAgentDir = (modelsJson) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-deepseek-compat-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify(modelsJson));
    return dir;
  };
  const bareTokenRouterModelsJson = {
    providers: {
      "token-router": {
        baseUrl: "https://api.tokenrouter.com/v1",
        apiKey: CANARY_KEY,
        models: [{ id: "deepseek/deepseek-v4-flash" }],
      },
    },
  };

  it("patches the on-disk copy and logs exactly one summary line naming the patched ids", () => {
    const dir = mkAgentDir(bareTokenRouterModelsJson);
    const logs = [];
    const changed = applyDeepSeekCompat({ agentDir: dir, log: (m) => logs.push(m) });
    expect(changed).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8"));
    expect(onDisk.providers["token-router"].models[0].reasoning).toBe(true);
    expect(onDisk.providers["token-router"].models[0].compat).toEqual({
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("token-router:deepseek/deepseek-v4-flash");
  });

  it("never logs key material — no apiKey value in the summary line or anywhere else", () => {
    const dir = mkAgentDir(bareTokenRouterModelsJson);
    const logs = [];
    applyDeepSeekCompat({ agentDir: dir, log: (m) => logs.push(m) });
    const joined = logs.join("\n");
    expect(joined).not.toContain(CANARY_KEY);
    // guard against ANY sk-... shaped credential leaking into diagnostics, not just this fixture's
    expect(joined).not.toMatch(/\bsk-[A-Za-z0-9]{20,}/);
  });

  it("BELLOWS_NO_DEEPSEEK_COMPAT=1 skips the transform entirely — copy stays byte-for-byte identical, no log", () => {
    process.env[DEEPSEEK_COMPAT_KILL_SWITCH_ENV] = "1";
    const dir = mkAgentDir(bareTokenRouterModelsJson);
    const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");
    const logs = [];
    const changed = applyDeepSeekCompat({ agentDir: dir, log: (m) => logs.push(m) });
    expect(changed).toBe(false);
    expect(fs.readFileSync(path.join(dir, "models.json"), "utf8")).toBe(before);
    expect(logs).toHaveLength(0);
  });

  it("returns false and logs nothing when no entry needs patching", () => {
    const dir = mkAgentDir({
      providers: { deepseek: { baseUrl: "https://api.deepseek.com/v1", models: [{ id: "deepseek-chat" }] } },
    });
    const logs = [];
    const changed = applyDeepSeekCompat({ agentDir: dir, log: (m) => logs.push(m) });
    expect(changed).toBe(false);
    expect(logs).toHaveLength(0);
  });

  it("never throws — malformed models.json on disk is a silent no-op", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-deepseek-compat-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "models.json"), "{not json");
    expect(() => applyDeepSeekCompat({ agentDir: dir })).not.toThrow();
    expect(applyDeepSeekCompat({ agentDir: dir })).toBe(false);
  });

  it("never throws — missing models.json is a silent no-op", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-deepseek-compat-"));
    dirs.push(dir);
    expect(() => applyDeepSeekCompat({ agentDir: dir })).not.toThrow();
    expect(applyDeepSeekCompat({ agentDir: dir })).toBe(false);
  });
});

describe("provisionRun — DeepSeek compat integration (real copy path)", () => {
  const dirs = [];
  const CANARY_KEY = "sk-canaryDoNotLeakThisFakeKey00000000000";
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
  const mkPiAgentDir = (modelsJson) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-piagent-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "auth.json"), "{}");
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify(modelsJson));
    return dir;
  };
  const mkRunDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-run-"));
    dirs.push(dir);
    return dir;
  };

  it("surfaces deepseekCompat:true and writes the patched copy for a bare token-router deepseek source", () => {
    const piAgentDir = mkPiAgentDir({
      providers: {
        "token-router": {
          baseUrl: "https://api.tokenrouter.com/v1",
          apiKey: CANARY_KEY,
          models: [{ id: "deepseek/deepseek-v4-flash" }],
        },
      },
    });
    const logs = [];
    const result = provisionRun({
      runDir: mkRunDir(),
      spec: { model: "token-router:deepseek/deepseek-v4-flash", thinkingLevel: "medium" },
      config: { platformBase: "https://example.test", accordionRepo: "C:/acc", piAgentDir },
      roomId: "ROOM1",
      agentName: "agent_x",
      runLabel: "t/keel/1",
      apiKey: "PLATFORM_KEY",
      log: (m) => logs.push(m),
    });
    expect(result.deepseekCompat).toBe(true);
    const copied = JSON.parse(fs.readFileSync(path.join(result.agentDir, "models.json"), "utf8"));
    expect(copied.providers["token-router"].models[0].reasoning).toBe(true);
    expect(copied.providers["token-router"].models[0].compat).toEqual({
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    });
    expect(logs.join("\n")).not.toContain(CANARY_KEY);
  });

  it("never modifies the SOURCE models.json at piAgentDir — only the run's copy", () => {
    const piAgentDir = mkPiAgentDir({
      providers: {
        "token-router": {
          baseUrl: "https://api.tokenrouter.com/v1",
          models: [{ id: "deepseek/deepseek-v4-flash" }],
        },
      },
    });
    const before = fs.readFileSync(path.join(piAgentDir, "models.json"), "utf8");
    provisionRun({
      runDir: mkRunDir(),
      spec: { model: "token-router:deepseek/deepseek-v4-flash", thinkingLevel: "medium" },
      config: { platformBase: "https://example.test", accordionRepo: "C:/acc", piAgentDir },
      roomId: "ROOM1",
      agentName: "agent_x",
      runLabel: "t/keel/1",
      apiKey: "PLATFORM_KEY",
    });
    expect(fs.readFileSync(path.join(piAgentDir, "models.json"), "utf8")).toBe(before);
  });

  it("surfaces deepseekCompat:false when the source needs no patching (deepseek.com host)", () => {
    const piAgentDir = mkPiAgentDir({
      providers: { deepseek: { baseUrl: "https://api.deepseek.com/v1", models: [{ id: "deepseek-chat" }] } },
    });
    const result = provisionRun({
      runDir: mkRunDir(),
      spec: { model: "deepseek:deepseek-chat", thinkingLevel: "medium" },
      config: { platformBase: "https://example.test", accordionRepo: "C:/acc", piAgentDir },
      roomId: "ROOM1",
      agentName: "agent_x",
      runLabel: "t/keel/1",
      apiKey: "PLATFORM_KEY",
    });
    expect(result.deepseekCompat).toBe(false);
  });
});
