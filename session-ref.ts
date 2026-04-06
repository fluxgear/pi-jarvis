export const BTW_SESSION_REF_CUSTOM_TYPE = "btw.session-ref";

export interface BtwSessionRef {
	version: 1;
	file: string;
}

type BranchEntryLike = {
	type: string;
	customType?: string;
	data?: unknown;
};

export function readBtwSessionRef(entries: readonly BranchEntryLike[]): BtwSessionRef | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== BTW_SESSION_REF_CUSTOM_TYPE) {
			continue;
		}
		const ref = parseBtwSessionRef(entry.data);
		if (ref) {
			return ref;
		}
	}
	return undefined;
}

export function createBtwSessionRef(file: string): BtwSessionRef {
	return {
		version: 1,
		file,
	};
}

function parseBtwSessionRef(data: unknown): BtwSessionRef | undefined {
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
