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
});
