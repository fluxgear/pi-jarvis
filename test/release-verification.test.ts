import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type PackageManifest = {
	files?: string[];
};

type NpmPackFileEntry = {
	path: string;
};

type NpmPackEntry = {
	files?: NpmPackFileEntry[];
};

function parsePackJson(rawOutput: string): NpmPackEntry[] {
	const start = rawOutput.indexOf("[");
	const end = rawOutput.lastIndexOf("]");
	assert.ok(start >= 0 && end > start, "npm pack --dry-run --json did not emit JSON payload");
	return JSON.parse(rawOutput.slice(start, end + 1)) as NpmPackEntry[];
}

function normalizeManifestEntry(path: string): string {
	return path.replace(/^\.\//, "").replace(/\/+$/, "");
}

function main(): void {
	for (const requiredDistPath of ["dist/index.js", "dist/index.d.ts"]) {
		assert.ok(existsSync(join(process.cwd(), requiredDistPath)), `missing built artifact: ${requiredDistPath}`);
	}

	const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as PackageManifest;
	const packResult = spawnSync("npm", ["pack", "--dry-run", "--json"], {
		encoding: "utf8",
	});
	assert.equal(packResult.status, 0, `npm pack --dry-run --json failed:\n${packResult.stdout}${packResult.stderr}`);

	const packEntries = parsePackJson(`${packResult.stdout}\n${packResult.stderr}`);
	assert.ok(packEntries.length > 0, "npm pack --dry-run --json returned no package metadata");
	const packedPaths = new Set((packEntries[0]?.files ?? []).map((entry) => normalizeManifestEntry(entry.path)));
	assert.ok(packedPaths.size > 0, "npm pack payload did not list packaged files");

	for (const requiredPackedPath of ["package.json", "README.md", "AGENTS.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]) {
		assert.ok(packedPaths.has(requiredPackedPath), `missing expected packaged path: ${requiredPackedPath}`);
	}

	for (const manifestEntry of manifest.files ?? []) {
		const normalizedEntry = normalizeManifestEntry(manifestEntry);
		if (normalizedEntry === "dist") {
			assert.ok([...packedPaths].some((packedPath) => packedPath.startsWith("dist/")), "pack payload should include dist/ artifacts");
			continue;
		}
		assert.ok(packedPaths.has(normalizedEntry), `pack payload should include package.json files entry: ${normalizedEntry}`);
	}

	for (const forbiddenPath of [
		"index.ts",
		"jarvis-config.ts",
		"main-context.ts",
		"main-session-state.ts",
		"overlay.ts",
		"session-ref.ts",
		"side-session.ts",
		"test/jarvis.test.ts",
		"test/release-verification.test.ts",
		"tsconfig.json",
		"tsconfig.build.json",
		"plan.md",
	]) {
		assert.ok(!packedPaths.has(forbiddenPath), `unexpected source artifact in package payload: ${forbiddenPath}`);
	}

	for (const forbiddenPrefix of ["test/", "tmp/", "prompts/"]) {
		assert.ok(
			![...packedPaths].some((path) => path.startsWith(forbiddenPrefix)),
			`unexpected package payload entry under ${forbiddenPrefix}`,
		);
	}

	console.log("release verification passed");
}

main();
