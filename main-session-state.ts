import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

type BranchEntries = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
type ContextUsageSnapshot = ReturnType<ExtensionContext["getContextUsage"]>;

export type MainBusyState = "busy" | "idle";

export interface MainToolCallSnapshot {
	toolCallId?: string;
	toolName: string;
	args?: Record<string, unknown>;
}

export interface MainToolExecutionSnapshot {
	active: boolean;
	running: readonly MainToolCallSnapshot[];
}

export interface MainSessionSnapshot {
	busyState: MainBusyState;
	hasPendingMessages: boolean;
	modelLabel: string;
	toolExecution: MainToolExecutionSnapshot;
	latestUserRequest?: string;
	latestAssistantText?: string;
	systemPrompt: string;
	contextUsage?: ContextUsageSnapshot;
	branchEntries: BranchEntries;
}

type MessageLike = {
	role: string;
	content?: unknown;
};

type MessageEventLike = {
	message?: unknown;
};

type ToolExecutionStartEventLike = {
	toolCallId?: unknown;
	toolName?: unknown;
	args?: unknown;
};

type ToolExecutionEndEventLike = {
	toolCallId?: unknown;
	toolName?: unknown;
};

type ActiveToolCall = MainToolCallSnapshot & { key: string };

export class MainSessionTracker {
	private busyState: MainBusyState = "idle";
	private hasPendingMessages = false;
	private modelLabel = "model unavailable";
	private latestUserRequest?: string;
	private latestAssistantText?: string;
	private systemPrompt = "";
	private contextUsage?: ContextUsageSnapshot;
	private branchEntries: BranchEntries = [];
	private assistantStreaming = false;
	private readonly activeToolCalls = new Map<string, ActiveToolCall>();

	reset(modelLabel: string = "model unavailable"): void {
		this.busyState = "idle";
		this.hasPendingMessages = false;
		this.modelLabel = modelLabel;
		this.latestUserRequest = undefined;
		this.latestAssistantText = undefined;
		this.systemPrompt = "";
		this.contextUsage = undefined;
		this.branchEntries = [];
		this.assistantStreaming = false;
		this.activeToolCalls.clear();
	}

	refreshFromContext(ctx: ExtensionContext, modelLabel: string): void {
		this.modelLabel = modelLabel;
		this.systemPrompt = ctx.getSystemPrompt();
		this.contextUsage = ctx.getContextUsage();
		this.busyState = ctx.isIdle() ? "idle" : "busy";
		this.hasPendingMessages = ctx.hasPendingMessages();
		this.branchEntries = [...ctx.sessionManager.getBranch()];
		this.refreshMessagesFromBranch();
	}

	handleAgentStart(): void {
		this.busyState = "busy";
	}

	handleAgentEnd(): void {
		this.busyState = "idle";
		this.assistantStreaming = false;
		this.activeToolCalls.clear();
	}

	handleMessageStart(event: MessageEventLike): void {
		// Mark assistant streaming on message_start so a refreshFromContext
		// triggered by another event in the gap before message_update cannot
		// overwrite the in-flight latestAssistantText with the persisted prior
		// assistant message.
		this.captureMessage(event.message, true);
	}

	handleMessageUpdate(event: MessageEventLike): void {
		this.captureMessage(event.message, true);
	}

	handleMessageEnd(event: MessageEventLike): void {
		this.captureMessage(event.message, false);
	}

	handleToolExecutionStart(event: ToolExecutionStartEventLike): void {
		const toolName = typeof event.toolName === "string" && event.toolName.length > 0 ? event.toolName : undefined;
		if (!toolName) {
			return;
		}

		const toolCallId = typeof event.toolCallId === "string" && event.toolCallId.length > 0 ? event.toolCallId : undefined;
		const key = toolCallId ?? `tool:${toolName}`;
		this.activeToolCalls.set(key, {
			key,
			toolCallId,
			toolName,
			args: toRecord(event.args),
		});
	}

	handleToolExecutionEnd(event: ToolExecutionEndEventLike): void {
		const toolCallId = typeof event.toolCallId === "string" && event.toolCallId.length > 0 ? event.toolCallId : undefined;
		const toolName = typeof event.toolName === "string" && event.toolName.length > 0 ? event.toolName : undefined;
		if (toolCallId && this.activeToolCalls.delete(toolCallId)) {
			return;
		}
		if (!toolName) {
			return;
		}
		// Fallback: handleToolExecutionStart may have keyed the entry by a
		// synthetic `tool:${toolName}` when the start event carried no
		// toolCallId. Drop any matching entry so the currentToolActivity summary
		// does not leak a stale "currently running" tool.
		if (this.activeToolCalls.delete(`tool:${toolName}`)) {
			return;
		}
		for (const [key, value] of this.activeToolCalls.entries()) {
			if (value.toolName === toolName) {
				this.activeToolCalls.delete(key);
				break;
			}
		}
	}

	handleModelSelect(modelLabel: string): void {
		this.modelLabel = modelLabel;
	}

	snapshot(): MainSessionSnapshot {
		return {
			busyState: this.busyState,
			hasPendingMessages: this.hasPendingMessages,
			modelLabel: this.modelLabel,
			toolExecution: {
				active: this.activeToolCalls.size > 0,
				running: [...this.activeToolCalls.values()].map(({ key: _key, ...toolCall }) => toolCall),
			},
			latestUserRequest: this.latestUserRequest,
			latestAssistantText: this.latestAssistantText,
			systemPrompt: this.systemPrompt,
			contextUsage: this.contextUsage,
			branchEntries: [...this.branchEntries],
		};
	}

	private captureMessage(messageValue: unknown, assistantStreaming?: boolean): void {
		const message = unwrapMessage(messageValue);
		if (!message) {
			return;
		}

		if (message.role === "user") {
			const text = extractTextContent(message.content);
			if (text) {
				this.latestUserRequest = text;
			}
			return;
		}

		if (message.role !== "assistant") {
			return;
		}

		if (typeof assistantStreaming === "boolean") {
			this.assistantStreaming = assistantStreaming;
		}
		const text = extractAssistantText(message.content);
		if (text) {
			this.latestAssistantText = text;
		}
	}

	private refreshMessagesFromBranch(): void {
		let latestUserRequest: string | undefined;
		let latestAssistantText: string | undefined;

		for (let i = this.branchEntries.length - 1; i >= 0; i--) {
			const message = unwrapMessage(this.branchEntries[i]);
			if (!message) {
				continue;
			}

			if (!latestUserRequest && message.role === "user") {
				const text = extractTextContent(message.content);
				if (text) {
					latestUserRequest = text;
				}
			}

			if (!latestAssistantText && message.role === "assistant") {
				const text = extractAssistantText(message.content);
				if (text) {
					latestAssistantText = text;
				}
			}

			if (latestUserRequest && latestAssistantText) {
				break;
			}
		}

		this.latestUserRequest = latestUserRequest;
		if (!this.assistantStreaming) {
			this.latestAssistantText = latestAssistantText;
		}
	}
}

function unwrapMessage(value: unknown): MessageLike | undefined {
	const direct = readMessageLike(value);
	if (direct) {
		return direct;
	}

	if (!isRecord(value)) {
		return undefined;
	}

	// SessionEntry of type "message" wraps the actual AgentMessage under .message;
	// extension event payloads sometimes wrap it under .data instead.
	return readMessageLike(value.message) ?? readMessageLike(value.data);
}

function readMessageLike(value: unknown): MessageLike | undefined {
	if (!isRecord(value) || typeof value.role !== "string") {
		return undefined;
	}

	return {
		role: value.role,
		content: value.content,
	};
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) {
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
			continue;
		}
		if (block.type === "image") {
			parts.push(`[image${typeof block.mimeType === "string" && block.mimeType ? `: ${block.mimeType}` : ""}]`);
		}
	}

	return parts.join("\n\n");
}

function extractAssistantText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) {
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}

	return parts.join("\n\n");
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value) || Array.isArray(value)) {
		return undefined;
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
