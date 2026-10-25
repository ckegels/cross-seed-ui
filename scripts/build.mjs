#!/usr/bin/env node
/**
 * Build everything into dist/:
 *   dist/agent.mjs   bundled agent (no node_modules needed)
 *   dist/hub.mjs     bundled hub
 *   dist/web/        built web UI
 *   dist/bin/cross-seed-ui, dist/deploy/*   CLI + install files
 *   dist/VERSION
 * With --release also writes release/cross-seed-ui-<version>.tar.gz (+ .sha256).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = process.env.CSUI_VERSION ?? pkg.version;
const release = process.argv.includes("--release");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const name of ["agent", "hub"]) {
	await build({
		entryPoints: [join(root, `packages/${name}/src/main.ts`)],
		outfile: join(dist, `${name}.mjs`),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		minify: false,
		sourcemap: false,
		legalComments: "none",
		define: { __CSUI_VERSION__: JSON.stringify(version) },
		banner: { js: `// cross-seed-ui ${name} ${version} - https://github.com/ckegels/cross-seed-ui` },
		logLevel: "warning",
	});
	console.log(`built dist/${name}.mjs`);
}

execFileSync("npx", ["vite", "build", "--outDir", join(dist, "web"), "--emptyOutDir"], {
	cwd: join(root, "packages/web"),
	stdio: "inherit",
});

mkdirSync(join(dist, "bin"), { recursive: true });
cpSync(join(root, "deploy/cross-seed-ui"), join(dist, "bin/cross-seed-ui"));
chmodSync(join(dist, "bin/cross-seed-ui"), 0o755);
cpSync(join(root, "deploy"), join(dist, "deploy"), { recursive: true });
writeFileSync(join(dist, "VERSION"), `${version}\n`);
console.log(`dist/ ready (version ${version})`);

if (release) {
	const out = join(root, "release");
	mkdirSync(out, { recursive: true });
	const file = `cross-seed-ui-${version}.tar.gz`;
	execFileSync("tar", ["-czf", join(out, file), "-C", dist, "."], { stdio: "inherit" });
	const sum = execFileSync("sha256sum", [file], { cwd: out }).toString();
	writeFileSync(join(out, `${file}.sha256`), sum);
	console.log(`release/${file}\n${sum.trim()}`);
}
