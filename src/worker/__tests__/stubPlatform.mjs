/**
 * A tiny in-test HTTP stub of the agent-trials worker control-plane wire, used
 * by loop.test.mjs and platformClient.test.mjs. Not a fixture directory (per
 * echo-conductor's pattern) because each test needs to script different
 * claim/heartbeat/complete sequences — a shared class with hooks is simpler
 * than N static fixture servers.
 */
import http from "node:http";

export class StubPlatform {
  constructor() {
    /** @type {{method:string, url:string, headers:object, body:any}[]} */
    this.requests = [];
    this.server = http.createServer((req, res) => this._handle(req, res));
    // Handler hooks — tests override these per-scenario.
    this.onClaim = () => ({ status: 204 });
    this.onHeartbeat = () => ({ status: 200, body: { cancel: false } });
    this.onEvents = () => ({ status: 200, body: { ok: true } });
    this.onComplete = () => ({ status: 200, body: { ok: true } });
  }

  async listen() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address();
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  async close() {
    await new Promise((resolve) => this.server.close(resolve));
  }

  _handle(req, res) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = { __nonJson: true, __raw: raw };
      }
      this.requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });

      let result;
      try {
        if (req.method === "POST" && req.url === "/api/bench/workers/claim") {
          result = this.onClaim(body, req);
        } else if (req.method === "POST" && /^\/api\/bench\/runs\/[^/]+\/heartbeat$/.test(req.url)) {
          result = this.onHeartbeat(body, req);
        } else if (req.method === "POST" && /^\/api\/bench\/runs\/[^/]+\/events$/.test(req.url)) {
          result = this.onEvents(body, req);
        } else if (req.method === "POST" && /^\/api\/bench\/runs\/[^/]+\/complete$/.test(req.url)) {
          result = this.onComplete(body, req);
        } else {
          result = { status: 404, body: { error: "not found" } };
        }
      } catch (e) {
        result = { status: 500, body: { error: e.message } };
      }

      const status = result?.status ?? 200;
      const payload = result?.body !== undefined ? JSON.stringify(result.body) : "";
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(payload);
    });
  }
}
