/**
 * pi extension entry. Thin adapter: wires the pure engine to the pi
 * runtime via tools + steering + lifecycle, one WorkspaceManager per session cwd
 * (which itself owns one index per discovered repo).
 *
 * This extension adds code-navigation tools and steers eligible grep calls toward
 * indexed symbols.
 *
 * Loaded by jiti — ships `.ts`, no build step. This module (and only `src/pi/**`) may
 * import pi; `src/engine/**` stays pure.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSteering } from "./steering.ts";
import { registerTools } from "./tools.ts";
import { WorkspaceManager } from "./workspace.ts";

export default function (pi: ExtensionAPI): void {
	const workspaces = new Map<string, WorkspaceManager>();
	const resolveWorkspace = (cwd: string): WorkspaceManager => {
		let workspace = workspaces.get(cwd);
		if (!workspace) {
			workspace = new WorkspaceManager(cwd);
			workspaces.set(cwd, workspace);
		}
		return workspace;
	};

	registerTools(pi, resolveWorkspace);
	registerSteering(pi, resolveWorkspace);

	pi.on("session_start", (_event, ctx) => {
		const workspace = resolveWorkspace(ctx.cwd);
		workspace.warmUp();
		workspace.startWatching();
		return undefined;
	});

	pi.on("session_shutdown", () => {
		for (const workspace of workspaces.values()) workspace.shutdown();
		workspaces.clear();
		return undefined;
	});
}
