import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		// Avoid nesting IndexManager workers inside process forks on Windows. A small fixed
		// thread pool limits filesystem and SQLite contention on slower Windows runners.
		pool: process.platform === "win32" ? "threads" : "forks",
		maxWorkers: process.platform === "win32" ? 2 : 4,
		testTimeout: process.platform === "win32" ? 60_000 : 30_000,
		hookTimeout: process.platform === "win32" ? 30_000 : 10_000,
	},
});
