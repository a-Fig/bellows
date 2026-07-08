import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSslCertEnv, ensurePythonShim, agentSpawnEnv } from "../agentEnv.mjs";

const tmpDirs = [];
function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agentenv-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe("resolveSslCertEnv", () => {
  it("wires certifi into SSL_CERT_FILE + REQUESTS_CA_BUNDLE when unset", () => {
    const out = resolveSslCertEnv({
      env: {},
      where: () => "/ca/cacert.pem",
      existsSync: () => true,
    });
    expect(out).toEqual({
      SSL_CERT_FILE: "/ca/cacert.pem",
      REQUESTS_CA_BUNDLE: "/ca/cacert.pem",
    });
  });

  it("never overrides an operator-provided SSL_CERT_FILE", () => {
    const out = resolveSslCertEnv({
      env: { SSL_CERT_FILE: "/custom/ca.pem" },
      where: () => "/ca/cacert.pem",
      existsSync: () => true,
    });
    expect(out).toEqual({});
  });

  it("no-op when certifi can't be located", () => {
    expect(resolveSslCertEnv({ env: {}, where: () => null, existsSync: () => true })).toEqual({});
  });

  it("no-op when the resolved bundle doesn't exist on disk", () => {
    const out = resolveSslCertEnv({
      env: {},
      where: () => "/ca/missing.pem",
      existsSync: () => false,
    });
    expect(out).toEqual({});
  });
});

describe("ensurePythonShim", () => {
  it("writes an executable python->python3 shim and returns its dir", () => {
    const binDir = path.join(mkTmp(), "bin");
    const dir = ensurePythonShim({
      binDir,
      env: { PATH: "/usr/local/bin" },
      platform: "darwin",
      resolve: (cmd) => (cmd === "python3" ? "/usr/local/bin/python3" : null),
    });
    expect(dir).toBe(binDir);
    const shim = path.join(binDir, "python");
    expect(fs.readFileSync(shim, "utf8")).toContain("exec python3");
    // Executable bit set (POSIX only; skip the assertion on Windows).
    if (process.platform !== "win32") {
      expect(fs.statSync(shim).mode & 0o111).not.toBe(0);
    }
  });

  it("is a no-op on Windows (ships python)", () => {
    let wrote = false;
    const dir = ensurePythonShim({
      binDir: "/unused",
      platform: "win32",
      resolve: () => null,
      writeShim: () => { wrote = true; },
    });
    expect(dir).toBe("");
    expect(wrote).toBe(false);
  });

  it("is a no-op when python already resolves", () => {
    let wrote = false;
    const dir = ensurePythonShim({
      binDir: "/unused",
      platform: "darwin",
      resolve: (cmd) => (cmd === "python" ? "/usr/bin/python" : null),
      writeShim: () => { wrote = true; },
    });
    expect(dir).toBe("");
    expect(wrote).toBe(false);
  });

  it("is a no-op when there is no python3 to shim to", () => {
    let wrote = false;
    const dir = ensurePythonShim({
      binDir: "/unused",
      platform: "darwin",
      resolve: () => null,
      writeShim: () => { wrote = true; },
    });
    expect(dir).toBe("");
    expect(wrote).toBe(false);
  });
});

describe("agentSpawnEnv", () => {
  it("prepends the shim dir onto the existing PATH", () => {
    // A macOS-like base env: python3 present, python absent.
    const binDir = path.join(mkTmp(), "bin");
    const python3Dir = mkTmp();
    fs.writeFileSync(path.join(python3Dir, "python3"), "");
    fs.chmodSync(path.join(python3Dir, "python3"), 0o755);

    const baseEnv = { PATH: python3Dir, SSL_CERT_FILE: "/already/set" };
    const add = agentSpawnEnv({ baseEnv, binDir, platform: "darwin" });

    // SSL untouched (already set); PATH gains the shim dir out front.
    expect(add.SSL_CERT_FILE).toBeUndefined();
    expect(add.PATH).toBe(binDir + path.delimiter + python3Dir);
    expect(fs.existsSync(path.join(binDir, "python"))).toBe(true);
  });

  it("merges SSL vars on macOS when the resolver returns them", () => {
    const add = agentSpawnEnv({
      baseEnv: { PATH: "/usr/bin" },
      binDir: path.join(mkTmp(), "bin"),
      platform: "darwin",
      // python present -> no shim; isolate the SSL branch.
      resolveSsl: () => ({ SSL_CERT_FILE: "/ca/cacert.pem", REQUESTS_CA_BUNDLE: "/ca/cacert.pem" }),
    });
    expect(add.SSL_CERT_FILE).toBe("/ca/cacert.pem");
    expect(add.REQUESTS_CA_BUNDLE).toBe("/ca/cacert.pem");
  });

  it("never touches SSL off macOS — resolver is not even called", () => {
    let called = false;
    const add = agentSpawnEnv({
      baseEnv: { PATH: "/usr/bin" },
      binDir: path.join(mkTmp(), "bin"),
      platform: "win32",
      resolveSsl: () => {
        called = true;
        return { SSL_CERT_FILE: "/ca/cacert.pem" };
      },
    });
    expect(called).toBe(false);
    expect(add.SSL_CERT_FILE).toBeUndefined();
  });

  it("returns no additions on a fully healthy env", () => {
    // python present on PATH, SSL already configured -> nothing to do.
    const pathDir = mkTmp();
    for (const bin of ["python", "python3"]) {
      fs.writeFileSync(path.join(pathDir, bin), "");
      fs.chmodSync(path.join(pathDir, bin), 0o755);
    }
    const add = agentSpawnEnv({
      baseEnv: { PATH: pathDir, SSL_CERT_FILE: "/set" },
      binDir: path.join(mkTmp(), "bin"),
      platform: "darwin",
    });
    expect(add).toEqual({});
  });
});
