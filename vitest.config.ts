import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		// Avoid nesting IndexManager workers inside process forks on Windows. A small fixed
		// pool keeps the SQLite integration suite reliable on high-core machines.
		pool: process.platform === "win32" ? "threads" : "forks",
		maxWorkers: 4,
		testTimeout: 30_000,
	},
});
