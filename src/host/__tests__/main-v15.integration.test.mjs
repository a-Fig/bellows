import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const BELLOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function writeModule(file, source) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, source);
}

function makeAccordionFixture(root) {
	writeModule(path.join(root, "core", "protocol.ts"), `
export const PROTOCOL_VERSION = 15;
export const isServerMessage = (value) => !!value && typeof value.type === "string";
`);
	writeModule(path.join(root, "core", "replica.ts"), `
export function hydrateSnapshot(_meta, state) {
  return {
    rev: state.rev || 0,
    blocks: state.blocks || [],
    groups: state.groups || [],
    foldedCount: () => 0,
    stats() { return { rev: this.rev, liveTokens: 0, fullTokens: 0, budget: 0, protectTokens: 0, blockCount: this.blocks.length }; },
  };
}
export function applyWireEvent(truth, event) { truth.rev = event.rev; }
`);
	writeModule(path.join(root, "core", "conductor", "registry.ts"), `
export const ENTRIES = [{ id: "compaction-naive", label: "Naive compaction", kind: "in-process" }];
`);
	fs.mkdirSync(path.join(root, "conductors"), { recursive: true });
}

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
}

function waitForExit(child, timeoutMs = 8_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("v15 host integration process timed out"));
		}, timeoutMs);
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

async function runController(mode) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-v15-host-"));
	const accordionRepo = path.join(tmp, "accordion");
	const accordionHome = path.join(tmp, "home");
	const telemetryOut = path.join(tmp, "host.jsonl");
	const commands = [];
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	let stderr = "";
	try {
		makeAccordionFixture(accordionRepo);
		await listen(server);
		const port = server.address().port;
		const sessionDir = path.join(accordionHome, ".accordion", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(path.join(sessionDir, "test-session.json"), JSON.stringify({
			sessionId: "test-session",
			port,
			heartbeatAt: Date.now(),
			protocolVersion: 15,
		}));

		server.on("connection", (socket) => {
			socket.send(JSON.stringify({
				type: "hello",
				protocolVersion: 15,
				sessionId: "test-session",
				role: "gui",
				meta: { format: "pi", title: "test", cwd: tmp, model: "fake", contextWindow: 100_000 },
				conductors: [{ id: "compaction-naive", label: "Naive compaction", kind: "in-process" }],
			}));
			socket.send(JSON.stringify({
				type: "snapshot",
				state: { rev: 0, blocks: [], groups: [], overlay: [] },
			}));
			socket.on("message", (data) => {
				const message = JSON.parse(data.toString());
				if (message.type !== "command") return;
				commands.push(message.cmd);
				if (mode === "unexpected-close" && commands.length === 4) {
					socket.send(JSON.stringify({ type: "conductorState", active: { id: "compaction-naive" } }));
					setTimeout(() => socket.close(1011, "simulated server failure"), 25);
				}
			});
		});

		const child = spawn(process.execPath, [
			path.join(BELLOWS_ROOT, "node_modules", "vite-node", "vite-node.mjs"),
			"--config", "vite-node.config.ts",
			"src/host/main-v15.ts", "--",
			"--accordion-home", accordionHome,
			"--conductor", "compaction-naive",
			"--budget", "100000",
			"--protect", "20000",
			"--telemetry-out", telemetryOut,
			"--timeout-min", "1",
			"--attach-timeout-ms", "100",
		], {
			cwd: BELLOWS_ROOT,
			env: { ...process.env, BELLOWS_ACCORDION_REPO: accordionRepo },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		const exit = await waitForExit(child);
		return { commands, exit, stderr, telemetry: fs.readFileSync(telemetryOut, "utf8") };
	} finally {
		await new Promise((resolve) => server.close(resolve));
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

describe("Accordion v15 host controller lifecycle", () => {
	it("configures and attaches, then fails closed on unexpected socket loss", async () => {
		const result = await runController("unexpected-close");
		expect(result.commands.slice(0, 4)).toEqual([
			{ kind: "setBudget", value: 100000 },
			{ kind: "setProtect", value: 20000 },
			{ kind: "selectConductor", id: "compaction-naive" },
			{ kind: "setFolding", value: true },
		]);
		expect(result.exit.code).toBe(1);
		expect(result.telemetry).toContain('"t":"attach"');
		expect(result.stderr).toContain("session socket closed unexpectedly");
	});

	it("disarms folding and detaches before exiting on attach timeout", async () => {
		const result = await runController("attach-timeout");
		expect(result.commands).toEqual([
			{ kind: "setBudget", value: 100000 },
			{ kind: "setProtect", value: 20000 },
			{ kind: "selectConductor", id: "compaction-naive" },
			{ kind: "setFolding", value: true },
			{ kind: "setFolding", value: false },
			{ kind: "selectConductor", id: null },
		]);
		expect(result.exit.code).toBe(1);
		expect(result.stderr).toContain("did not become active within 100ms");
	});
});
