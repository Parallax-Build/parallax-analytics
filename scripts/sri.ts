/** Prints the subresource integrity hash of the tracker. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../apps/gateway/src/tracker/parallax.js", import.meta.url));
console.log(`sha384-${createHash("sha384").update(source).digest("base64")}`);
