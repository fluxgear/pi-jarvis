import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import { Type } from "@mariozechner/pi-ai";
import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { BtwOverlayBridge, type BtwDisplayEntry } from "./overlay.js";

const SIDE_SYSTEM_PROMPT = `
Authoritative /btw addendum:
- You are running inside /btw.
- The main Pi agent continues independently while you assist from the side.
- You have no repo, system, or MCP tools in /btw.
- Before each /btw turn you will be given a deterministic summary and bounded recent view of the main session.
- Communication permissions to the main agent via followUp / steer are controlled separately and may be enabled or disabled.
- Use the injected main-session context to answer what is happening right now.
`.trim();

type SideSessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

type SideRuntimeCreateOptions = {
	bridge: BtwOverlayBridge;
	cwd: string;
	modelRegistry: ExtensionContext["modelRegistry"];
	model: Model<any> | undefined;
	thinkingLevel: string | undefined;
	sessionFile: string;
	systemPromptProvider: () => string;
	mainContextProvider: () => {
		summaryText: string;
		recentText: string;
	};
	communicationPermissionsProvider: () => {
		allowFollowUpToMain: boolean;
		allowSteerToMain: boolean;
	};
	sendFollowUpToMain: (message: string) => void;
	confirmSteerToMain: (message: string) => Promise<boolean>;
	sendSteerToMain: (message: string) => void;
	themeProvider: () => ExtensionContext["ui"]["theme"];
};

export function getBtwSessionDirectory(cwd: string, agentDir: string = getAgentDir()): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(agentDir, "btw-sessions", safePath);
	mkdirSync(sessionDir, { recursive: true });
	return sessionDir;
}

export async function createSideSessionFile(cwd: string): Promise<string> {
	const sessionManager = SessionManager.create(cwd, getBtwSessionDirectory(cwd));
	const file = sessionManager.getSessionFile();
	if (!file) {
		throw new Error("Failed to create /btw session file.");
	}
	return file;
}

export class BtwSideSessionRuntime {
	readonly bridge: BtwOverlayBridge;

	private session?: SideSessionHandle;
	private unsubscribe?: () => void;
	private historyEntries: BtwDisplayEntry[] = [];
	private streamingAssistant?: AssistantMessage;
	private pendingToolCalls = new Map<string, string>();
	private bootError?: string;
	private ready = false;
	private modelLabel = "model unavailable";

	private constructor(
		bridge: BtwOverlayBridge,
		private readonly themeProvider: SideRuntimeCreateOptions["themeProvider"],
	) {
		this.bridge = bridge;
	}

	static async create(options: SideRuntimeCreateOptions): Promise<BtwSideSessionRuntime> {
		const runtime = new BtwSideSessionRuntime(options.bridge, options.themeProvider);
		await runtime.initialize(options);
		return runtime;
	}

	isReady(): boolean {
		return this.ready;
	}

	isStreaming(): boolean {
		return this.session?.isStreaming ?? false;
	}

	getModelLabel(): string {
		return this.modelLabel;
	}

	getModeLabel(): string {
		return "advisory only";
	}

	getDisplayEntries(): BtwDisplayEntry[] {
		const entries = [...this.historyEntries];

		for (const text of this.pendingToolCalls.values()) {
			entries.push({ kind: "tool", text });
		}

		if (this.streamingAssistant) {
			const assistantText = extractAssistantText(this.streamingAssistant);
			if (assistantText) {
				entries.push({ kind: "assistant", text: assistantText });
			}
		}

		if (this.bootError) {
			entries.push({ kind: "system", text: this.bootError });
		}

		if (entries.length === 0) {
			entries.push({ kind: "system", text: "Ask a quick side question here. The main session continues independently." });
		}

		return entries;
	}

	async sendMessage(text: string): Promise<void> {
		if (!this.session) {
			throw new Error("/btw session is not ready.");
		}
		if (this.session.isStreaming) {
			await this.session.prompt(text, { streamingBehavior: "steer" });
			return;
		}
		await this.session.prompt(text);
	}

	async syncModel(model: Model<any> | undefined, thinkingLevel: string | undefined): Promise<void> {
		if (!this.session) {
			return;
		}

		if (model) {
			const current = this.session.model;
			const differs = !current || current.provider !== model.provider || current.id !== model.id;
			if (differs) {
				await this.session.setModel(model);
			}
		}

		if (thinkingLevel) {
			this.session.setThinkingLevel(thinkingLevel as any);
		}

		this.modelLabel = formatModelLabel(this.session.model);
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.session?.dispose();
		this.session = undefined;
		this.bridge.detach();
	}

private async initialize(options: SideRuntimeCreateOptions): Promise<void> {
	const sideSessionManager = SessionManager.open(options.sessionFile, dirname(options.sessionFile));
	const persistedContext = sideSessionManager.buildSessionContext();
	const hadExistingEntries = sideSessionManager.getEntries().length > 0;

	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		extensionFactories: [
			createSideExtensionFactory(
				options.systemPromptProvider,
				options.mainContextProvider,
				options.communicationPermissionsProvider,
				options.sendFollowUpToMain,
				options.confirmSteerToMain,
				options.sendSteerToMain,
			),
		],
	});
	await resourceLoader.reload();

	const { session, modelFallbackMessage } = await createAgentSession({
		cwd: options.cwd,
		agentDir: getAgentDir(),
		modelRegistry: options.modelRegistry as any,
		model: options.model,
		thinkingLevel: options.thinkingLevel as any,
		tools: [],
		resourceLoader,
		sessionManager: sideSessionManager,
	});
	this.session = session;

	await session.bindExtensions({
		uiContext: createSideUiContext(this.bridge, options.themeProvider),
		onError: (error) => {
			this.bridge.notify(`Side extension error: ${error.error}`, "error");
		},
	});

	if (options.model && hadExistingEntries) {
		const previousModel = persistedContext.model;
		if (!previousModel || previousModel.provider !== options.model.provider || previousModel.modelId !== options.model.id) {
			await session.setModel(options.model);
		}
	}
	if (options.thinkingLevel && persistedContext.thinkingLevel !== options.thinkingLevel) {
		session.setThinkingLevel(options.thinkingLevel as any);
	}

	this.modelLabel = formatModelLabel(session.model);
	this.ready = true;
	this.bootError = modelFallbackMessage;
	if (modelFallbackMessage) {
		this.bridge.notify(modelFallbackMessage, "warning");
	}

	this.refreshHistory();
	this.unsubscribe = session.subscribe((event: any) => {
		this.handleEvent(event);
	});
}

	private handleEvent(event: any): void {
		switch (event.type) {
			case "agent_start":
				this.bridge.setWorkingMessage("Thinking…");
				break;
			case "agent_end":
				this.bridge.setWorkingMessage(undefined);
				this.streamingAssistant = undefined;
				this.pendingToolCalls.clear();
				break;
			case "message_update":
				if (event.message?.role === "assistant") {
					this.streamingAssistant = event.message;
				}
				break;
			case "message_end":
				if (event.message?.role === "assistant") {
					this.streamingAssistant = undefined;
				}
				this.refreshHistory();
				break;
			case "message_start":
				if (event.message?.role === "user" || event.message?.role === "toolResult" || event.message?.role === "custom") {
					this.refreshHistory();
				}
				break;
			case "tool_execution_start":
				this.pendingToolCalls.set(event.toolCallId, formatToolCall(event.toolName, event.args));
				break;
			case "tool_execution_end":
				this.pendingToolCalls.delete(event.toolCallId);
				break;
			case "model_select":
				this.modelLabel = formatModelLabel(event.model);
				break;
		}
		this.refreshHistory();
	}

	private refreshHistory(): void {
		if (!this.session) {
			return;
		}
		const context = this.session.sessionManager.buildSessionContext();
		this.historyEntries = context.messages.flatMap((message) => formatMessageForOverlay(message));
		this.modelLabel = formatModelLabel(this.session.model);
	}
}

function createSideExtensionFactory(
	getMainSystemPrompt: SideRuntimeCreateOptions["systemPromptProvider"],
	getMainContext: SideRuntimeCreateOptions["mainContextProvider"],
	getCommunicationPermissions: SideRuntimeCreateOptions["communicationPermissionsProvider"],
	sendFollowUpToMain: SideRuntimeCreateOptions["sendFollowUpToMain"],
	confirmSteerToMain: SideRuntimeCreateOptions["confirmSteerToMain"],
	sendSteerToMain: SideRuntimeCreateOptions["sendSteerToMain"],
) {
	const followUpToolName = "btw_send_follow_up_to_main";
	const steerToolName = "btw_send_steer_to_main";
	const toolParameters = Type.Object({
		message: Type.String({
			minLength: 1,
			description: "Message to send to the main agent.",
		}),
	});
	const createToolResult = (status: "sent" | "blocked" | "cancelled", text: string) => ({
		content: [{ type: "text" as const, text }],
		details: { status },
	});
	const getCommunicationPrompt = () => {
		const permissions = getCommunicationPermissions();
		return [
			"Main-agent communication bridge for this /btw turn:",
			permissions.allowFollowUpToMain
				? "- `" + followUpToolName + "` sends a non-interrupting followUp message to the main agent. It is enabled right now."
				: "- `" + followUpToolName + "` sends a non-interrupting followUp message to the main agent. It is disabled right now; attempts are blocked.",
			permissions.allowSteerToMain
				? "- `" + steerToolName + "` sends a steer message to the main agent. It is enabled right now, but every actual send still requires explicit user confirmation."
				: "- `" + steerToolName + "` sends a steer message to the main agent. It is disabled right now; attempts are blocked. Even when enabled, every actual send still requires explicit user confirmation.",
		].join("\n");
	};

	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: followUpToolName,
			label: "Send /btw followUp to main",
			description: "Queue a followUp message for the main agent without interrupting the current turn. Use only when the user explicitly wants /btw to pass something back to the main agent.",
			promptSnippet: followUpToolName + "(message) - queue a non-interrupting followUp message to the main agent when permission is enabled.",
			promptGuidelines: [
				"Use this only when the user explicitly wants /btw to pass a note back to the main agent.",
				"This uses followUp delivery and should not interrupt the current turn.",
			],
			parameters: toolParameters,
			async execute(_toolCallId, params) {
				const message = params.message.trim();
				if (!message) {
					return createToolResult("blocked", "Cannot send an empty followUp message to the main agent.");
				}
				if (!getCommunicationPermissions().allowFollowUpToMain) {
					return createToolResult("blocked", "Follow-up to the main agent is disabled for /btw.");
				}
				sendFollowUpToMain(message);
				return createToolResult("sent", "Sent followUp to the main agent: " + message);
			},
		});

		pi.registerTool({
			name: steerToolName,
			label: "Send /btw steer to main",
			description: "Send a steer message to the main agent. This can interrupt or redirect the main turn, so use it only when the user explicitly wants that. Every actual send requires confirmation.",
			promptSnippet: steerToolName + "(message) - send a confirmation-gated steer message to the main agent when permission is enabled.",
			promptGuidelines: [
				"Use this only when the user explicitly wants the main agent interrupted or redirected.",
				"Every actual steer send requires explicit user confirmation.",
			],
			parameters: toolParameters,
			async execute(_toolCallId, params) {
				const message = params.message.trim();
				if (!message) {
					return createToolResult("blocked", "Cannot send an empty steer message to the main agent.");
				}
				if (!getCommunicationPermissions().allowSteerToMain) {
					return createToolResult("blocked", "Steer to the main agent is disabled for /btw.");
				}
				const confirmed = await confirmSteerToMain(message);
				if (!confirmed) {
					return createToolResult("cancelled", "Cancelled steer to the main agent.");
				}
				sendSteerToMain(message);
				return createToolResult("sent", "Sent steer to the main agent: " + message);
			},
		});

		pi.on("before_agent_start", async () => {
			const mainContext = getMainContext();
			const systemPrompt = [
				getMainSystemPrompt().trim(),
				SIDE_SYSTEM_PROMPT,
				getCommunicationPrompt(),
				"Injected main-session context for this /btw turn:",
				mainContext.summaryText.trim(),
				mainContext.recentText.trim(),
			]
				.filter((section) => section.length > 0)
				.join("\n\n");
			return { systemPrompt };
		});
	};
}

function createSideUiContext(
	bridge: BtwOverlayBridge,
	themeProvider: () => ExtensionContext["ui"]["theme"],
): ExtensionContext["ui"] {
	let editorText = "";
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message: string, type?: "info" | "warning" | "error") => bridge.notify(message, type ?? "info"),
		onTerminalInput: () => () => {},
		setStatus: (key: string, text: string | undefined) => bridge.setStatus(key, text),
		setWorkingMessage: (message?: string) => bridge.setWorkingMessage(message),
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => {
			throw new Error("/btw side session does not support custom extension UI.");
		},
		pasteToEditor: (text: string) => {
			editorText += text;
		},
		setEditorText: (text: string) => {
			editorText = text;
		},
		getEditorText: () => editorText,
		editor: async () => undefined,
		setEditorComponent: () => {},
		get theme() {
			return themeProvider();
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching is unavailable inside /btw." }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	} as ExtensionContext["ui"];
}


function formatModelLabel(model: Model<any> | undefined): string {
	if (!model) {
		return "model unavailable";
	}
	return `${model.provider}/${model.id}`;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((block) => {
			if (!block || typeof block !== "object") {
				return "";
			}
			const typed = block as { type?: string; text?: string; mimeType?: string };
			if (typed.type === "text") {
				return typed.text ?? "";
			}
			if (typed.type === "image") {
				return `[image${typed.mimeType ? `: ${typed.mimeType}` : ""}]`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.map((part) => {
			if (part.type === "text") {
				return part.text;
			}
			if (part.type === "toolCall") {
				return "";
			}
			if (part.type === "thinking") {
				return "";
			}
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}

function formatToolCall(toolName: string, args: Record<string, unknown> | undefined): string {
	if (toolName === "mcp") {
		const tool = typeof args?.tool === "string" ? args.tool : undefined;
		if (tool) {
			return `mcp ${tool}`;
		}
		if (typeof args?.search === "string") {
			return `mcp search ${args.search}`;
		}
		if (typeof args?.describe === "string") {
			return `mcp describe ${args.describe}`;
		}
		if (typeof args?.connect === "string") {
			return `mcp connect ${args.connect}`;
		}
	}

	const json = args ? JSON.stringify(args) : "{}";
	return json.length > 72 ? `${toolName} ${json.slice(0, 69)}...` : `${toolName} ${json}`;
}

function formatMessageForOverlay(message: any): BtwDisplayEntry[] {
	switch (message.role) {
		case "user": {
			const text = extractTextContent(message.content);
			return text ? [{ kind: "user", text }] : [];
		}
		case "assistant": {
			const text = extractAssistantText(message);
			const entries: BtwDisplayEntry[] = [];
			if (text) {
				entries.push({ kind: "assistant", text });
			}
			for (const part of message.content) {
				if (part.type === "toolCall") {
					entries.push({ kind: "tool", text: formatToolCall(part.name, part.arguments) });
				}
			}
			return entries;
		}
		case "toolResult": {
			const text = extractTextContent(message.content);
			const prefix = message.isError ? `error from ${message.toolName}` : `${message.toolName}`;
			return text ? [{ kind: "tool", text: `${prefix}: ${text}` }] : [{ kind: "tool", text: `${prefix}: (no text output)` }];
		}
		case "custom": {
			const text = extractTextContent(message.content);
			return message.display && text ? [{ kind: "status", text }] : [];
		}
		case "compactionSummary":
			return [{ kind: "status", text: `Compaction: ${message.summary}` }];
		case "branchSummary":
			return [{ kind: "status", text: `Branch summary: ${message.summary}` }];
		case "bashExecution": {
			const status = message.cancelled ? "cancelled" : message.exitCode === 0 ? "ok" : `exit ${message.exitCode ?? "?"}`;
			const output = typeof message.output === "string" && message.output.length > 0 ? ` — ${message.output.trim()}` : "";
			return [{ kind: "tool", text: `$ ${message.command} (${status})${output}` }];
		}
		default:
			return [];
	}
}
