/**
 * Demo-only: create the library on disk as sparse files (no real disk usage)
 * so cross-seed can link matched files like it would on a real system.
 *   node --import tsx scripts/demo/make-files.ts <dataRoot>
 */
import { closeSync, ftruncateSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { LIBRARY } from "./catalog.ts";

const root = process.argv[2];
if (!root) throw new Error("usage: make-files.ts <dataRoot>");
let n = 0;
for (const r of LIBRARY) {
	for (const f of r.files) {
		const p = join(root, r.instance, "data", r.category, f.path);
		mkdirSync(dirname(p), { recursive: true });
		const fd = openSync(p, "w");
		ftruncateSync(fd, f.size);
		closeSync(fd);
		n++;
	}
}
for (const i of ["a", "b"]) mkdirSync(join(root, i, "links"), { recursive: true });
console.log(`[demo] ${n} sparse files for ${LIBRARY.length} torrents`);
