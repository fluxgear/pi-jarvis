export type McpToolSafety = "read-only" | "mutation" | "unknown";

export interface McpToolMetadataView {
	name: string;
	description?: string;
}

export interface McpProxyRequest {
	tool?: string;
	connect?: string;
	describe?: string;
	search?: string;
	server?: string;
	action?: string;
}

const READ_ONLY_NAME_PATTERNS = [
	/^get_/i,
	/^read_/i,
	/^list_/i,
	/^search_/i,
	/^find_/i,
	/^describe_/i,
	/^show_/i,
	/^inspect_/i,
	/^query_/i,
	/^fetch_/i,
	/^status/i,
	/^grep_/i,
	/^diff_/i,
	/^check_/i,
	/^preview_/i,
	/^view_/i,
	/^tail_/i,
];

const MUTATING_NAME_PATTERNS = [
	/^write_/i,
	/^edit_/i,
	/^create_/i,
	/^update_/i,
	/^delete_/i,
	/^remove_/i,
	/^rename_/i,
	/^move_/i,
	/^apply_/i,
	/^patch_/i,
	/^set_/i,
	/^commit_/i,
	/^push_/i,
	/^merge_/i,
	/^open_/i,
	/^close_/i,
	/^run_/i,
	/^execute_/i,
	/^trigger_/i,
	/^install_/i,
	/^uninstall_/i,
	/^deploy_/i,
];

const READ_ONLY_DESCRIPTION_PATTERNS = [
	/\bread[- ]?only\b/i,
	/\blist\b/i,
	/\bsearch\b/i,
	/\bfind\b/i,
	/\bdescribe\b/i,
	/\binspect\b/i,
	/\bshow\b/i,
	/\bquery\b/i,
	/\bfetch\b/i,
	/\bstatus\b/i,
	/\bpreview\b/i,
	/\bview\b/i,
	/\bget\b/i,
	/\breturn(?:s|ing)?\b/i,
	/\bwithout modifying\b/i,
	/\bno changes\b/i,
];

const MUTATING_DESCRIPTION_PATTERNS = [
	/\bwrite\b/i,
	/\bedit\b/i,
	/\bcreate\b/i,
	/\bupdate\b/i,
	/\bdelete\b/i,
	/\bremove\b/i,
	/\brename\b/i,
	/\bmove\b/i,
	/\bapply\b/i,
	/\bpatch\b/i,
	/\bmodify\b/i,
	/\bmutat(?:e|ing|ion)\b/i,
	/\bcommit\b/i,
	/\bpush\b/i,
	/\bdeploy\b/i,
	/\binstall\b/i,
	/\buninstall\b/i,
	/\bopen(?:s)? a browser\b/i,
	/\blaunch\b/i,
	/\bexecute\b/i,
	/\brun\b/i,
	/\btrigger\b/i,
];

export function classifyMcpTool(metadata: McpToolMetadataView | undefined): McpToolSafety {
	if (!metadata) {
		return "unknown";
	}

	const name = metadata.name.trim();
	const description = metadata.description?.trim() ?? "";

	if (MUTATING_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
		return "mutation";
	}
	if (READ_ONLY_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
		return "read-only";
	}

	if (description.length > 0) {
		if (MUTATING_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(description))) {
			return "mutation";
		}
		if (READ_ONLY_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(description))) {
			return "read-only";
		}
	}

	return "unknown";
}

export function requiresMcpMutationApproval(
	request: McpProxyRequest,
	metadata: McpToolMetadataView | undefined,
): boolean {
	if (request.action === "ui-messages") {
		return false;
	}
	if (request.connect || request.describe || request.search || request.server) {
		return false;
	}
	if (!request.tool) {
		return false;
	}
	return classifyMcpTool(metadata) !== "read-only";
}
