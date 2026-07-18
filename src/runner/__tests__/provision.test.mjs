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
  checkThinkingLevelWarning,
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

describe("checkThinkingLevelWarning", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
  const mkAgentDir = (modelsJson) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-thinklevel-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify(modelsJson));
    return dir;
  };

  it("is a no-op when thinkingLevel is off", () => {
    expect(
      checkThinkingLevelWarning({ agentDir: "/does/not/exist", model: "token-router:x", thinkingLevel: "off" }),
    ).toBeNull();
  });

  it("warns loudly when the resolved model entry lacks reasoning:true", () => {
    const dir = mkAgentDir({ providers: { "token-router": { models: [{ id: "deepseek/deepseek-v4-flash" }] } } });
    const logs = [];
    const w = checkThinkingLevelWarning({
      agentDir: dir,
      model: "token-router:deepseek/deepseek-v4-flash",
      thinkingLevel: "medium",
      log: (m) => logs.push(m),
    });
    expect(w).toContain("thinkingLevel 'medium'");
    expect(w).toContain("lacks reasoning:true");
    expect(logs.some((l) => l.startsWith("[provision] WARNING:"))).toBe(true);
  });

  it("is silent when the model entry declares reasoning:true", () => {
    const dir = mkAgentDir({
      providers: { "token-router": { models: [{ id: "deepseek/deepseek-v4-flash", reasoning: true }] } },
    });
    expect(
      checkThinkingLevelWarning({ agentDir: dir, model: "token-router:deepseek/deepseek-v4-flash", thinkingLevel: "medium" }),
    ).toBeNull();
  });

  it("never throws — missing models.json is a silent no-op", () => {
    expect(() =>
      checkThinkingLevelWarning({ agentDir: "/does/not/exist", model: "token-router:x/y", thinkingLevel: "medium" }),
    ).not.toThrow();
    expect(
      checkThinkingLevelWarning({ agentDir: "/does/not/exist", model: "token-router:x/y", thinkingLevel: "medium" }),
    ).toBeNull();
  });

  it("never throws — malformed models.json is a silent no-op", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-thinklevel-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "models.json"), "{not json");
    expect(
      checkThinkingLevelWarning({ agentDir: dir, model: "token-router:x/y", thinkingLevel: "medium" }),
    ).toBeNull();
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
