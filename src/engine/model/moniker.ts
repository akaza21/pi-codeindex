/**
 * Moniker scheme. A moniker is a stable, repo-unique symbol id that occurrences point at.
 * It mirrors SCIP's descriptor convention so the id is self-describing and emittable as a
 * SCIP symbol: the name carries a kind suffix (`Foo#` type, `bar().` method, `x.` term),
 * prefixed by the file and (for members) the owner type, and suffixed by the start
 * position so same-name declarations on the same construct (e.g. overloads) stay distinct:
 *
 *   <file>#<ownerType#>?<name><kind-suffix>@<startLine>:<startCol>
 *
 * The owner is encoded as a type descriptor (`Owner#`); that is exact for the common
 * class/interface owner and a harmless approximation for a namespace/module owner (which a
 * byte-for-byte SCIP symbol would mark with `/`). Names with reserved characters are escaped
 * by `descriptor()`, so the only structural assumption left is that `file` paths contain no
 * literal `#`. Occurrences only ever compare/join the opaque string, so the scheme can evolve
 * freely — bump INDEX_FORMAT_VERSION to force a clean rebuild.
 */

import { descriptor } from "./descriptor.ts";

interface MonikerParts {
	file: string;
	name: string;
	kind: string;
	startLine: number;
	startCol: number;
	ownerType?: string;
}

export function buildMoniker(parts: MonikerParts): string {
	// The owner is the enclosing type; emit it as a (escaped) type descriptor so the chain
	// reads `Owner#member`, reusing the same descriptor logic the member uses.
	const owner = parts.ownerType ? descriptor(parts.ownerType, "class") : "";
	const descriptors = `${owner}${descriptor(parts.name, parts.kind)}`;
	return `${parts.file}#${descriptors}@${parts.startLine}:${parts.startCol}`;
}
