import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		// Several integration tests open SQLite databases and worker threads. A small fixed
		// pool keeps the suite reliable on CI runners and high-core developer machines.
		maxWorkers: 4,
		testTimeout: 30_000,
	},
});
