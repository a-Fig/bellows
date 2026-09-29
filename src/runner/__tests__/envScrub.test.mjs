import { describe, it, expect } from "vitest";
import { scrubEnv, SECRET_ENV_NAME_RE } from "../envScrub.mjs";

describe("scrubEnv", () => {
  it("drops vars whose name matches the secret regex", () => {
    const { env, scrubbed } = scrubEnv({
      PATH: "/usr/bin",
      AGENT_TRIALS_API_KEY: "secret1",
      MY_TOKEN: "secret2",
      DB_PASSWORD: "secret3",
      SESSION_SECRET: "secret4",
      GH_CREDENTIAL_HELPER: "secret5",
      SSH_PRIVATE_KEY: "secret6",
      AUTH_HEADER: "secret7",
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(scrubbed).toEqual(
      ["AGENT_TRIALS_API_KEY", "AUTH_HEADER", "DB_PASSWORD", "GH_CREDENTIAL_HELPER", "MY_TOKEN", "SESSION_SECRET", "SSH_PRIVATE_KEY"].sort(),
    );
  });

  it("is case-insensitive", () => {
    const { scrubbed } = scrubEnv({ my_api_key: "x" });
    expect(scrubbed).toEqual(["my_api_key"]);
  });

  it("keeps a var exempted via passthrough", () => {
    const { env, scrubbed } = scrubEnv({ PROVIDER_API_KEY: "x", PATH: "/usr/bin" }, ["PROVIDER_API_KEY"]);
    expect(env).toEqual({ PROVIDER_API_KEY: "x", PATH: "/usr/bin" });
    expect(scrubbed).toEqual([]);
  });

  it("does not mutate the input env", () => {
    const input = { API_KEY: "x", PATH: "/usr/bin" };
    scrubEnv(input);
    expect(input).toEqual({ API_KEY: "x", PATH: "/usr/bin" });
  });

  it("leaves an env with no secret-shaped vars untouched", () => {
    const input = { PATH: "/usr/bin", HOME: "/home/x", NODE_ENV: "production" };
    const { env, scrubbed } = scrubEnv(input);
    expect(env).toEqual(input);
    expect(scrubbed).toEqual([]);
  });

  it("SECRET_ENV_NAME_RE matches the documented shapes", () => {
    for (const name of ["API_KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "PRIVATE_KEY", "PRIVATEKEY", "AUTH"]) {
      expect(SECRET_ENV_NAME_RE.test(name)).toBe(true);
    }
    expect(SECRET_ENV_NAME_RE.test("PATH")).toBe(false);
    expect(SECRET_ENV_NAME_RE.test("HOME")).toBe(false);
  });

  // 2026-09-29 Fable review, bellows #37 blocking follow-up: the regex missed
  // a bare "*_KEY" (no "API" in the name), *_DSN connection strings, cookies,
  // and session values.
  it("SECRET_ENV_NAME_RE now also matches bare *_KEY, DSN, COOKIE, and SESSION shapes", () => {
    for (const name of ["OPENROUTER_KEY", "DEEPSEEK_KEY", "SSH_KEY", "KEY", "SENTRY_DSN", "DATABASE_DSN", "SESSION_COOKIE", "MY_SESSION", "COOKIE"]) {
      expect(SECRET_ENV_NAME_RE.test(name)).toBe(true);
    }
  });

  it("the bare-KEY pattern does not false-positive on KEY appearing mid-word", () => {
    expect(SECRET_ENV_NAME_RE.test("KEYBOARD_LAYOUT")).toBe(false);
    expect(SECRET_ENV_NAME_RE.test("MONKEY")).toBe(false);
  });

  it("scrubEnv drops the newly-covered shapes end to end", () => {
    const { env, scrubbed } = scrubEnv({
      PATH: "/usr/bin",
      OPENROUTER_KEY: "sk-1",
      SENTRY_DSN: "https://x:y@sentry.example/1",
      SESSION_ID: "abc123",
      AUTH_COOKIE: "abc123",
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(scrubbed).toEqual(["AUTH_COOKIE", "OPENROUTER_KEY", "SENTRY_DSN", "SESSION_ID"].sort());
  });
});
