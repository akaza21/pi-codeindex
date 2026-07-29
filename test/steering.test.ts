import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerSteering } from "../src/pi/steering.ts";
import { WorkspaceManager } from "../src/pi/workspace.ts";

type BeforeAgentStart = (
	event: { systemPrompt: string },
	ctx: { cwd: string },
) => { systemPrompt?: string } | undefined;

/** Register steering against a fake pi (captures handlers) and a workspace with a fixed gate. */
function captureHandlers(indexed: boolean): Map<string, BeforeAgentStart> {
	const handlers = new Map<string, BeforeAgentStart>();
	const pi = { on: (name: string, cb: BeforeAgentStart) => handlers.set(name, cb) };
	const resolveWorkspace = () => ({ hasIndexedSymbols: () => indexed });
	registerSteering(
		pi as unknown as Parameters<typeof registerSteering>[0],
		resolveWorkspace as unknown as Parameters<typeof registerSteering>[1],
	);
	return handlers;
}

describe("proactive navigation guidance (before_agent_start)", () => {
	it("appends the codeindex guidance to the system prompt when the index has symbols", () => {
		const handler = captureHandlers(true).get("before_agent_start");
		const result = handler?.({ systemPrompt: "BASE PROMPT" }, { cwd: "/r" });
		expect(result?.systemPrompt).toContain("BASE PROMPT"); // chained onto the existing prompt
		expect(result?.systemPrompt).toContain("Use codeindex_* for indexed symbol navigation");
		expect(result?.systemPrompt).toContain("codeindex_def");
		expect(result?.systemPrompt).toContain("not probabilities");
		expect(result?.systemPrompt).toContain("Go structural interface satisfaction is not computed");
	});

	it("leaves the system prompt untouched when nothing is indexed", () => {
		const handler = captureHandlers(false).get("before_agent_start");
		expect(handler?.({ systemPrompt: "BASE PROMPT" }, { cwd: "/empty" })).toBeUndefined();
	});

	// Guards the gate against being vacuously true: repos() always resolves to a marker, so
	// the predicate must look at actual indexed symbols, which an empty dir has none of.
	it("hasIndexedSymbols() is false for a directory with nothing indexed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-ws-"));
		const ws = new WorkspaceManager(dir);
		try {
			expect(ws.hasIndexedSymbols()).toBe(false);
		} finally {
			await ws.shutdown();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("hasIndexedSymbols() flips true once a repo with symbols is synced", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-ws-"));
		writeFileSync(join(dir, "a.ts"), "export function hello() { return 1; }\n");
		const ws = new WorkspaceManager(dir);
		try {
			for (const repo of ws.repos()) await ws.managerFor(repo.path).sync();
			expect(ws.hasIndexedSymbols()).toBe(true);
		} finally {
			await ws.shutdown();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not intercept or block grep/find calls", () => {
		const handlers = captureHandlers(true);
		expect(handlers.has("tool_call")).toBe(false);
	});
});
