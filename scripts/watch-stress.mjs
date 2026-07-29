import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexManager } from "../src/pi/manager.ts";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openFileDescriptors() {
	if (process.platform !== "linux") return undefined;
	try {
		return readdirSync("/proc/self/fd").length;
	} catch {
		return undefined;
	}
}

const root = mkdtempSync(join(tmpdir(), "codeindex-watch-stress-"));
const uncaughtListeners = process.listenerCount("uncaughtException");
let manager;

try {
	for (let i = 0; i < 12_000; i++) mkdirSync(join(root, `directory-${i}`));
	manager = new IndexManager(root);
	await manager.sync();
	const before = openFileDescriptors();
	const watchStartedAt = Date.now();
	manager.startWatching();
	const readyDeadline = Date.now() + 60_000;
	while (Date.now() < readyDeadline && manager.diagnostics().watcher === "starting") await delay(200);

	const diagnostics = manager.diagnostics();
	assert.equal(diagnostics.watcher, "active");
	assert.equal(process.listenerCount("uncaughtException"), uncaughtListeners);
	const after = openFileDescriptors();
	if (before !== undefined && after !== undefined) assert.ok(after - before <= 4);
	writeFileSync(join(root, "observed.ts"), "export function observedByStressTest() { return 1; }\n");
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline && manager.getStore().definitions("observedByStressTest", 1).length === 0) {
		await delay(200);
	}
	assert.equal(manager.getStore().definitions("observedByStressTest", 1).length, 1);
	console.log(
		JSON.stringify({
			paths: 12_000,
			watcherStartupMs: Date.now() - watchStartedAt,
			openFileDescriptors: after,
			descriptorDelta: before === undefined || after === undefined ? undefined : after - before,
			diagnostics,
		}),
	);
} finally {
	await manager?.shutdown();
	rmSync(root, { recursive: true, force: true });
}
