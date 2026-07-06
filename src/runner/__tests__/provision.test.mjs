import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyPlaceholders,
  renderClient,
  renderBriefing,
  buildSettings,
} from "../provision.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");
const CLIENT_TMPL = path.join(REPO, "templates", "workspace", "slopcode_client.py");
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

  it("with no meta arg, injects a base64 encoding of JSON null (client degrades to no-meta join)", () => {
    const tmpl = fs.readFileSync(CLIENT_TMPL, "utf8");
    const out = renderClient(tmpl, "https://example.test", "SECRETKEY");
    expect(out).not.toContain("__SLOPCODE_META_B64__");
    const b64Line = out.split("\n").find((l) => l.startsWith("META_JSON_B64"));
    expect(b64Line).toBeTruthy();
    const literal = b64Line.match(/"([^"]*)"/)[1];
    expect(Buffer.from(literal, "base64").toString("utf8")).toBe("null");
  });

  it("with a meta object, injects a base64 encoding that round-trips to the same JSON", () => {
    const tmpl = fs.readFileSync(CLIENT_TMPL, "utf8");
    const meta = {
      display_name: "keel · deepseek-v4-flash · s1",
      model: "token-router:deepseek/deepseek-v4-flash",
      conductor: "external:thermocline",
      trial: "t1",
      seed: 1,
    };
    const out = renderClient(tmpl, "https://example.test", "SECRETKEY", meta);
    const b64Line = out.split("\n").find((l) => l.startsWith("META_JSON_B64"));
    const literal = b64Line.match(/"([^"]*)"/)[1];
    expect(JSON.parse(Buffer.from(literal, "base64").toString("utf8"))).toEqual(meta);
  });
});

describe("renderBriefing", () => {
  it("wires room/label/name/problems and puts the label step first", () => {
    const tmpl = fs.readFileSync(BRIEFING_TMPL, "utf8");
    const out = renderBriefing({
      roomId: "ROOM123",
      agentName: "agent_x",
      runLabel: "t/keel/1",
      problemsText: "easy-1, easy-2",
      tmpl,
    });
    expect(out).toContain("ROOM123");
    expect(out).toContain("agent_x");
    expect(out).toContain('label "t/keel/1"');
    expect(out).toContain("easy-1, easy-2");
    expect(out).not.toContain("__ROOM_ID__");
    // LABEL step must appear before the main loop
    const labelIdx = out.indexOf("LABEL FIRST");
    const loopIdx = out.indexOf("The loop");
    expect(labelIdx).toBeGreaterThan(-1);
    expect(labelIdx).toBeLessThan(loopIdx);
  });
});

describe("buildSettings", () => {
  it("splits provider:model, disables compaction, wires the accordion extension", () => {
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
  });
});
