import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		// Windows runs these SQLite and worker-thread integration tests serially to avoid
		// native teardown contention; other platforms use a small bounded pool.
		maxWorkers: process.platform === "win32" ? 1 : 4,
		testTimeout: 30_000,
	},
});
