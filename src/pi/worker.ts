/**
 * Worker entry for index syncs. The walk/parse/SQLite pipeline runs here
 * so indexing never blocks the session event loop. Protocol: post { ready }, receive
 * one request, post { result } or { error }; the caller terminates the worker.
 *
 * This file is the thin worker shell only; all logic lives in the pure engine.
 */

import { parentPort } from "node:worker_threads";
import { openIndex, type SyncResult } from "../engine/index.ts";
import { configuredMaxFiles, typedEnabled } from "./manager.ts";

export interface IndexWorkerRequest {
	root: string;
	dbPath: string;
	/** When present, re-index only these repo-relative paths (incremental warm re-sync). */
	only?: string[];
}

export interface IndexWorkerResponse {
	ready?: true;
	result?: SyncResult;
	error?: string;
}

if (!parentPort) throw new Error("index worker must run in a worker thread");
const port = parentPort;

port.once("message", async (message: IndexWorkerRequest) => {
	let close: (() => void) | undefined;
	try {
		const maxFiles = configuredMaxFiles();
		const { store, indexer } = openIndex({
			root: message.root,
			dbPath: message.dbPath,
			typed: typedEnabled(),
			...(maxFiles === undefined ? {} : { maxFiles }),
		});
		close = () => store.close();
		const result = await indexer.sync(message.only ? { only: message.only } : {});
		port.postMessage({ result } satisfies IndexWorkerResponse);
	} catch (error) {
		port.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies IndexWorkerResponse);
	} finally {
		close?.();
	}
});

port.postMessage({ ready: true } satisfies IndexWorkerResponse);
