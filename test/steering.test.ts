import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerSteering, routableQuery } from "../src/pi/steering.ts";
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

type ToolCall = (
	event: { toolName: string; input: Record<string, unknown> },
	ctx: { cwd: string },
) => { block: boolean; reason: string } | undefined;

function captureToolCall(resolveWorkspace: () => unknown): ToolCall {
	const handlers = new Map<string, unknown>();
	const pi = { on: (name: string, cb: unknown) => handlers.set(name, cb) };
	registerSteering(
		pi as unknown as Parameters<typeof registerSteering>[0],
		resolveWorkspace as unknown as Parameters<typeof registerSteering>[1],
	);
	return handlers.get("tool_call") as ToolCall;
}

describe("proactive navigation guidance (before_agent_start)", () => {
	it("appends the codeindex guidance to the system prompt when the index has symbols", () => {
		const handler = captureHandlers(true).get("before_agent_start");
		const result = handler?.({ systemPrompt: "BASE PROMPT" }, { cwd: "/r" });
		expect(result?.systemPrompt).toContain("BASE PROMPT"); // chained onto the existing prompt
		expect(result?.systemPrompt).toContain("prefer the codeindex_* tools");
		expect(result?.systemPrompt).toContain("codeindex_def");
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
});

describe("reactive steering", () => {
	it("nudges the same grep once per cwd", () => {
		const handler = captureToolCall(() => ({
			repos: () => [{ path: "/repo" }],
			managerFor: () => ({
				readyStore: () => ({
					search: () => [{ kind: "class", name: "Calculator", file: "calc.ts", range: [1, 0, 1, 10] }],
				}),
			}),
		}));
		const event = { toolName: "grep", input: { pattern: "Calculator" } };
		expect(handler(event, { cwd: "/one" })?.block).toBe(true);
		expect(handler(event, { cwd: "/one" })).toBeUndefined();
		expect(handler(event, { cwd: "/two" })?.block).toBe(true);
	});

	it("fails open when index search throws", () => {
		const handler = captureToolCall(() => ({
			repos: () => [{ path: "/repo" }],
			managerFor: () => ({
				readyStore: () => ({
					search: () => {
						throw new Error("unavailable");
					},
				}),
			}),
		}));
		expect(() => handler({ toolName: "grep", input: { pattern: "Calculator" } }, { cwd: "/repo" })).not.toThrow();
		expect(handler({ toolName: "grep", input: { pattern: "Calculator" } }, { cwd: "/repo" })).toBeUndefined();
	});
});

describe("routableQuery", () => {
	it("routes symbol-shaped grep patterns", () => {
		expect(routableQuery("grep", { pattern: "resolveOccurrences" })).toBe("resolveOccurrences");
	});

	it("passes through literal multi-word and path-like searches", () => {
		expect(routableQuery("grep", { pattern: "TODO fix this" })).toBeUndefined();
		expect(routableQuery("grep", { pattern: "src/foo" })).toBeUndefined();
	});

	it("passes through short and regex-heavy patterns", () => {
		expect(routableQuery("grep", { pattern: "ab" })).toBeUndefined();
		expect(routableQuery("grep", { pattern: "^(foo|bar)+.*$" })).toBeUndefined();
	});

	it("never routes find filename globs", () => {
		expect(routableQuery("find", { glob: "Calculator" })).toBeUndefined();
		expect(routableQuery("find", { pattern: "*.ts" })).toBeUndefined();
	});

	it("passes through literal and path-scoped grep calls", () => {
		expect(routableQuery("find", { pattern: "src/foo" })).toBeUndefined();
		expect(routableQuery("find", { pattern: "foo.ts" })).toBeUndefined();
		expect(routableQuery("find", { glob: "**/util" })).toBeUndefined();
		expect(routableQuery("find", { pattern: "foo bar" })).toBeUndefined();
		expect(routableQuery("grep", { pattern: "Calculator", literal: true })).toBeUndefined();
		expect(routableQuery("grep", { pattern: "Calculator", path: "src" })).toBeUndefined();
		expect(routableQuery("grep", { pattern: "config.ts" })).toBeUndefined();
	});
});
