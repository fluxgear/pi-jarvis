import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export type JarvisModelSelectionScope = "global" | "project";

export type StoredJarvisModelSelection =
	| { mode: "follow-main" }
	| { mode: "pinned"; provider: string; modelId: string };

type JarvisConfigFile = Record<string, unknown> & {
	modelSelection?: StoredJarvisModelSelection;
};

export function getJarvisConfigPath(
	cwd: string,
	scope: JarvisModelSelectionScope,
	agentDir: string = getAgentDir(),
): string {
	return scope === "global" ? join(agentDir, "extensions", "pi-jarvis.json") : join(cwd, ".pi", "jarvis.json");
}

export function loadJarvisModelSelectionSetting(
	cwd: string,
	scope: JarvisModelSelectionScope,
	agentDir: string = getAgentDir(),
): StoredJarvisModelSelection | undefined {
	const path = getJarvisConfigPath(cwd, scope, agentDir);
	if (!existsSync(path)) {
		return undefined;
	}

	const config = readJarvisConfigFile(path);
	if (config.modelSelection === undefined) {
		return undefined;
	}

	const selection = parseStoredJarvisModelSelection(config.modelSelection);
	if (!selection) {
		throw new Error(`Invalid modelSelection in ${path}.`);
	}
	return selection;
}

export function saveJarvisModelSelectionSetting(
	cwd: string,
	scope: JarvisModelSelectionScope,
	selection: StoredJarvisModelSelection,
	agentDir: string = getAgentDir(),
): void {
	const path = getJarvisConfigPath(cwd, scope, agentDir);
	const config = existsSync(path) ? readJarvisConfigFile(path) : {};
	config.modelSelection = selection;
	writeJarvisConfigFile(path, config);
}

export function clearJarvisModelSelectionSetting(
	cwd: string,
	scope: JarvisModelSelectionScope,
	agentDir: string = getAgentDir(),
): void {
	const path = getJarvisConfigPath(cwd, scope, agentDir);
	if (!existsSync(path)) {
		return;
	}

	const config = readJarvisConfigFile(path);
	delete config.modelSelection;
	if (Object.keys(config).length === 0) {
		rmSync(path, { force: true });
		return;
	}

	writeJarvisConfigFile(path, config);
}

function readJarvisConfigFile(path: string): JarvisConfigFile {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		throw new Error(`Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Expected ${path} to contain a JSON object.`);
	}

	return { ...(raw as Record<string, unknown>) };
}

function writeJarvisConfigFile(path: string, config: JarvisConfigFile): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`, "utf-8");
}

function parseStoredJarvisModelSelection(data: unknown): StoredJarvisModelSelection | undefined {
	if (!data || typeof data !== "object") {
		return undefined;
	}

	const candidate = data as { mode?: unknown; provider?: unknown; modelId?: unknown };
	if (candidate.mode === "follow-main") {
		return { mode: "follow-main" };
	}
	if (
		candidate.mode === "pinned" &&
		typeof candidate.provider === "string" &&
		candidate.provider.length > 0 &&
		typeof candidate.modelId === "string" &&
		candidate.modelId.length > 0
	) {
		return {
			mode: "pinned",
			provider: candidate.provider,
			modelId: candidate.modelId,
		};
	}
	return undefined;
}
