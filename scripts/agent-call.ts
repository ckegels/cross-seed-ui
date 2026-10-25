/**
 * Debug helper: send a signed request to an agent.
 *   node --import tsx scripts/agent-call.ts <agent.json> GET /v1/info
 *   node --import tsx scripts/agent-call.ts <agent.json> POST /v1/jobs/rss '{}'
 */
import { readFileSync } from "node:fs";
import { signRequest } from "../packages/shared/src/node/hmac.ts";

const [settingsPath, method = "GET", path = "/v1/info", body = ""] = process.argv.slice(2);
const s = JSON.parse(readFileSync(settingsPath, "utf8"));
const host = s.listen === "0.0.0.0" ? "127.0.0.1" : s.listen;
const res = await fetch(`http://${host}:${s.port}${path}`, {
	method,
	headers: { ...signRequest(s.secret, method, path, body), ...(body ? { "content-type": "application/json" } : {}) },
	body: body || undefined,
});
const text = await res.text();
console.log(res.status);
try {
	console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
	console.log(text);
}
