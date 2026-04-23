export const JARVIS_SESSION_REF_CUSTOM_TYPE = "jarvis.session-ref";

export interface JarvisSessionRef {
	version: 1;
	file: string;
}

type BranchEntryLike = {
	type: string;
	customType?: string;
	data?: unknown;
};

export function readJarvisSessionRef(entries: readonly BranchEntryLike[]): JarvisSessionRef | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== JARVIS_SESSION_REF_CUSTOM_TYPE) {
			continue;
		}
		return parseJarvisSessionRef(entry.data);
	}
	return undefined;
}


export function createJarvisSessionRef(file: string): JarvisSessionRef {
	return {
		version: 1,
		file,
	};
}


function parseJarvisSessionRef(data: unknown): JarvisSessionRef | undefined {
	if (!data || typeof data !== "object") {
		return undefined;
	}

	const candidate = data as { version?: unknown; file?: unknown };
	if (candidate.version !== 1 || typeof candidate.file !== "string" || candidate.file.length === 0) {
		return undefined;
	}

	return {
		version: 1,
		file: candidate.file,
	};
}
