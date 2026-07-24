/**
 * The SCIP protobuf message schema, declared programmatically (field numbers from scip.proto)
 * rather than vendoring the full `.proto`. `protobufjs` is an optional dependency — present only
 * when SCIP export or ingest is used — so this module loads it lazily and fails with a clear
 * error if it is absent. The single source of truth for the message shape: the exporter encodes
 * with it, the ingester decodes with it. Decoding tolerates a richer real-world `.scip` (unknown
 * protobuf fields are skipped), so we only declare the subset we read or write.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Whether SCIP support is usable (the optional `protobufjs` dependency is installed). */
export function scipAvailable(): boolean {
	try {
		require.resolve("protobufjs");
		return true;
	} catch {
		return false;
	}
}

interface MessageType {
	add(field: object): MessageType;
}

/** A resolved protobuf message type: encode for export, decode for ingest. */
interface ScipMessageType {
	create(properties: object): object;
	encode(message: object): { finish(): Uint8Array };
	decode(buffer: Uint8Array): object;
}

interface Protobuf {
	Type: new (name: string) => MessageType;
	Field: new (name: string, id: number, type: string, rule?: string) => object;
	Root: new () => {
		add(type: MessageType): unknown;
		resolveAll(): unknown;
		lookupType(path: string): ScipMessageType;
	};
}

let cachedIndexType: ScipMessageType | undefined;

/** Build the SCIP message subset we read/write and return the resolved `Index` type (memoized). */
export function scipIndexType(): ScipMessageType {
	if (cachedIndexType) return cachedIndexType;
	let pb: Protobuf;
	try {
		pb = require("protobufjs") as Protobuf;
	} catch {
		throw new Error("SCIP support needs the optional 'protobufjs' dependency — install it with `npm i protobufjs`.");
	}
	const { Type, Field } = pb;
	const singleLineRange = new Type("SingleLineRange")
		.add(new Field("line", 1, "int32"))
		.add(new Field("startCharacter", 2, "int32"))
		.add(new Field("endCharacter", 3, "int32"));
	const multiLineRange = new Type("MultiLineRange")
		.add(new Field("startLine", 1, "int32"))
		.add(new Field("startCharacter", 2, "int32"))
		.add(new Field("endLine", 3, "int32"))
		.add(new Field("endCharacter", 4, "int32"));
	const occurrenceType = new Type("Occurrence")
		.add(new Field("range", 1, "int32", "repeated"))
		.add(new Field("symbol", 2, "string"))
		.add(new Field("symbolRoles", 3, "int32"))
		.add(new Field("singleLineRange", 8, "SingleLineRange"))
		.add(new Field("multiLineRange", 9, "MultiLineRange"));
	const symbolInformation = new Type("SymbolInformation")
		.add(new Field("symbol", 1, "string"))
		.add(new Field("displayName", 6, "string"));
	const document = new Type("Document")
		.add(new Field("relativePath", 1, "string"))
		.add(new Field("occurrences", 2, "Occurrence", "repeated"))
		.add(new Field("symbols", 3, "SymbolInformation", "repeated"))
		.add(new Field("language", 4, "string"))
		.add(new Field("text", 5, "string"))
		.add(new Field("positionEncoding", 6, "int32"));
	const toolInfo = new Type("ToolInfo").add(new Field("name", 1, "string")).add(new Field("version", 2, "string"));
	const metadata = new Type("Metadata")
		.add(new Field("toolInfo", 2, "ToolInfo"))
		.add(new Field("projectRoot", 3, "string"))
		.add(new Field("textDocumentEncoding", 4, "int32"));
	const index = new Type("Index")
		.add(new Field("metadata", 1, "Metadata"))
		.add(new Field("documents", 2, "Document", "repeated"));
	const root = new pb.Root();
	for (const type of [
		singleLineRange,
		multiLineRange,
		occurrenceType,
		symbolInformation,
		document,
		toolInfo,
		metadata,
		index,
	]) {
		root.add(type);
	}
	root.resolveAll();
	cachedIndexType = root.lookupType("Index");
	return cachedIndexType;
}
