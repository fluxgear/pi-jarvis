import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { MainSessionContextPayload } from "./main-context.js";
import { Type } from "@mariozechner/pi-ai";
import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	createCodingTools,
	getAgentDir,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { JarvisOverlayBridge, type JarvisDisplayEntry } from "./overlay.js";

const SIDE_SYSTEM_PROMPT = `
Authoritative /jarvis addendum:
- You are running inside /jarvis.
- The main Pi agent continues independently while you assist from the side.
- Before each /jarvis turn you will be given a deterministic summary and bounded recent view of the main session.
- Communication permissions to the main agent via followUp / steer are controlled separately and may be enabled or disabled.
- Use the injected main-session context to answer what is happening right now.
`.trim();

const FRESH_THREAD_CONTEXT_NOTE = "You are in a fresh /jarvis thread. Keep the opening concise and conversational, then answer directly.";
const OPTIONAL_SIDE_TOOL_NAMES = ["read", "bash", "edit", "write", "mcp"] as const;
const require = createRequire(import.meta.url);

type SideSessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

type SideRuntimeCreateOptions = {
	bridge: JarvisOverlayBridge;
	cwd: string;
	modelRegistry: ExtensionContext["modelRegistry"];
	model: Model<any> | undefined;
	jarvisModelModeProvider?: () => "follow-main" | "pinned";
	thinkingLevel: string | undefined;
	sessionFile: string;
	systemPromptProvider: () => string;
	mainContextProvider: () => MainSessionContextPayload;
	toolAccessProvider: () => boolean;
	communicationPermissionsProvider: () => {
		allowFollowUpToMain: boolean;
		allowSteerToMain: boolean;
	};
	sendFollowUpToMain: (message: string) => void;
	confirmSteerToMain: (message: string) => Promise<boolean>;
	sendSteerToMain: (message: string) => void;
	hasConversationHistory?: () => boolean;
	themeProvider: () => ExtensionContext["ui"]["theme"];
};

export function getJarvisSessionDirectory(cwd: string, agentDir: string = getAgentDir()): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(agentDir, "jarvis-sessions", safePath);
	mkdirSync(sessionDir, { recursive: true });
	return sessionDir;
}

export async function createSideSessionFile(cwd: string): Promise<string> {
	const sessionManager = SessionManager.create(cwd, getJarvisSessionDirectory(cwd));
	const file = sessionManager.getSessionFile();
	if (!file) {
		throw new Error("Failed to create /jarvis session file.");
	}
	return file;
}

export class JarvisSideSessionRuntime {
	readonly bridge: JarvisOverlayBridge;

	private session?: SideSessionHandle;
	private unsubscribe?: () => void;
	private historyEntries: JarvisDisplayEntry[] = [];
	private streamingAssistant?: AssistantMessage;
	private pendingUserMessage?: string;
	private pendingToolCalls = new Map<string, string>();
	private bootError?: string;
	private ready = false;
	private modelLabel = "model unavailable";
	private hasConversationHistory = false;
	private toolAccessEnabled = false;
	private mcpAvailable = false;
	private syncActiveTools?: () => void;

	private constructor(
		bridge: JarvisOverlayBridge,
		private readonly themeProvider: SideRuntimeCreateOptions["themeProvider"],
	) {
		this.bridge = bridge;
	}

	static async create(options: SideRuntimeCreateOptions): Promise<JarvisSideSessionRuntime> {
		const runtime = new JarvisSideSessionRuntime(options.bridge, options.themeProvider);
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

	getRepoToolsDetailLabel(): string {
		if (!this.toolAccessEnabled) {
			return "repo tools off";
		}
		return this.mcpAvailable ? "local tools + MCP available" : "local tools only (MCP unavailable)";
	}

	setToolAccessEnabled(enabled: boolean): void {
		this.toolAccessEnabled = enabled;
		this.syncActiveTools?.();
	}

	getDisplayEntries(): JarvisDisplayEntry[] {
		const entries = [...this.historyEntries];
		const latestUserEntry = [...entries].reverse().find((entry) => entry.kind === "user");

		if (this.pendingUserMessage && latestUserEntry?.text !== this.pendingUserMessage) {
			entries.push({ kind: "user", text: this.pendingUserMessage });
		}

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
			entries.push({
				kind: "system",
				text: this.hasConversationHistory
					? "Ask a quick side question here. The main session continues independently."
					: "Welcome to /jarvis. I’m ready to help directly while the main session keeps running.",
			});
		}

		return entries;
	}

	async sendMessage(text: string): Promise<void> {
		if (!this.session) {
			throw new Error("/jarvis session is not ready.");
		}
		this.pendingUserMessage = text;
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
		this.hasConversationHistory = hadExistingEntries;
		this.toolAccessEnabled = options.toolAccessProvider();
		const hasConversationHistory = () => this.hasConversationHistory || (options.hasConversationHistory?.() ?? false);
		const mcpExtensionPath = resolveOptionalMcpExtensionPath();
		this.mcpAvailable = Boolean(mcpExtensionPath);

		const resourceLoader = new DefaultResourceLoader({
			cwd: options.cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			additionalExtensionPaths: mcpExtensionPath ? [mcpExtensionPath] : [],
			extensionFactories: [
				createSideExtensionFactory(
					options.systemPromptProvider,
					options.mainContextProvider,
					() => ({
						activeModelLabel: formatModelLabel(this.session?.model),
						mode: options.jarvisModelModeProvider?.() ?? "follow-main",
					}),
					() => this.toolAccessEnabled,
					(refreshActiveTools) => {
						this.syncActiveTools = refreshActiveTools;
					},
					options.communicationPermissionsProvider,
					options.sendFollowUpToMain,
					options.confirmSteerToMain,
					options.sendSteerToMain,
					hasConversationHistory,
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
			tools: createCodingTools(options.cwd),
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
		this.syncActiveTools?.();

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
		this.unsubscribe = session.subscribe((event) => {
			this.handleEvent(event);
		});
	}

	private handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.bridge.setWorkingMessage("Thinking…");
				break;
			case "agent_end":
				this.bridge.setWorkingMessage(undefined);
				this.streamingAssistant = undefined;
				this.pendingToolCalls.clear();
				break;
			case "message_start":
				if (event.message.role === "assistant") {
					this.streamingAssistant = event.message;
				}
				break;
			case "message_update":
				if (event.message.role === "assistant") {
					this.streamingAssistant = event.message;
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.streamingAssistant = undefined;
				}
				break;
			case "tool_execution_start":
				if (typeof event.toolCallId === "string" && event.toolCallId.length > 0) {
					this.pendingToolCalls.set(event.toolCallId, formatToolCall(event.toolName, event.args));
				}
				break;
			case "tool_execution_end":
				if (typeof event.toolCallId === "string" && event.toolCallId.length > 0) {
					this.pendingToolCalls.delete(event.toolCallId);
				}
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
		if (context.messages.length > 0) {
			this.hasConversationHistory = true;
		}
		const latestUserEntry = [...this.historyEntries].reverse().find((entry) => entry.kind === "user");
		if (this.pendingUserMessage && latestUserEntry?.text === this.pendingUserMessage) {
			this.pendingUserMessage = undefined;
		}
		this.modelLabel = formatModelLabel(this.session.model);
	}
}

function createSideExtensionFactory(
	getMainSystemPrompt: SideRuntimeCreateOptions["systemPromptProvider"],
	getMainContext: SideRuntimeCreateOptions["mainContextProvider"],
	getJarvisModelState: () => { activeModelLabel: string; mode: "follow-main" | "pinned" },
	hasToolAccess: SideRuntimeCreateOptions["toolAccessProvider"],
	bindActiveToolsSync: (refreshActiveTools: () => void) => void,
	getCommunicationPermissions: SideRuntimeCreateOptions["communicationPermissionsProvider"],
	sendFollowUpToMain: SideRuntimeCreateOptions["sendFollowUpToMain"],
	confirmSteerToMain: SideRuntimeCreateOptions["confirmSteerToMain"],
	sendSteerToMain: SideRuntimeCreateOptions["sendSteerToMain"],
	hasConversationHistory?: SideRuntimeCreateOptions["hasConversationHistory"],
) {
	let previousMainContext: MainSessionContextPayload | undefined;
	const followUpToolName = "jarvis_send_follow_up_to_main";
	const steerToolName = "jarvis_send_steer_to_main";
	const stripInheritedSections = (text: string, headingsToStrip: ReadonlySet<string>): string => {
		const lines = text.split(/\r?\n/);
		let skipSection = false;
		return lines
			.filter((line) => {
				const headingMatch = /^##\s+(.*)$/.exec(line.trim());
				if (headingMatch) {
					const heading = headingMatch[1]?.trim() ?? "";
					skipSection = headingsToStrip.has(heading);
					return !skipSection;
				}
				return !skipSection;
			})
			.join("\n");
	};
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
	const inheritedSectionsToStrip = new Set(["Execution Rules", "Larra Rules", "Session Rules", "Git Rules", "Commands", "Packaging", "Git"]);
	const inheritedLineBlocklist = [
		/^\s*(You are|Your name is)\s+[A-Z][\w-]*/i,
		/\bIf the user asks who you are\b/i,
		/\bLarra\b/i,
		/\bexplicit approval\b/i,
	];
	const getMainAgentName = () => extractPrimaryAssistantName(getMainSystemPrompt());
	const getInheritedMainSystemPrompt = () =>
		stripInheritedSections(getMainSystemPrompt().trim(), inheritedSectionsToStrip)
			.split(/\r?\n/)
			.filter((line) => !inheritedLineBlocklist.some((pattern) => pattern.test(line)))
			.map((line) =>
				line
					.replace(/\bYou are\s+[A-Z][\w-]*/g, "You are Jarvis")
					.replace(/\bYour name is\s+[A-Z][\w-]*/g, "Your name is Jarvis"),
			)
			.filter((line) => line.trim().length > 0)
			.join("\n");
	const getIdentityPrompt = () => {
		const mainAgentName = getMainAgentName();
		return [
			"Authoritative identity for this side session:",
			"- Your name is Jarvis.",
			mainAgentName && !/^Jarvis$/i.test(mainAgentName)
				? `- The main session assistant is currently named ${mainAgentName}. If the user refers to ${mainAgentName}, they mean the main agent, not you.`
				: "",
			"- Do not use any different assistant name inherited from the main session prompt.",
			"- If the inherited main system prompt gives a different assistant name, that inherited name does not apply here.",
			"- Do not announce or enforce the main agent's Larra, Git, or approval workflow rules.",
			"- When the user is simply talking to you, answer directly instead of reciting coding-agent workflow policy.",
		]
			.filter((line) => line.length > 0)
			.join("\n");
	};
	const getPersonalityPrompt = () =>
		[
			"Jarvis personality and tone for this side session:",
			"- Adopt the high-level demeanor of Tony Stark's JARVIS from the three Iron Man films: calm, precise, capable, discreet, and unflappable under pressure.",
			"- Use dry, understated humor sparingly. Mild wit is welcome, but never let jokes obscure the answer or derail the task.",
			"- Be politely formal, tactful, and gently reassuring. A little deadpan charm is fine; melodrama is not.",
			"- Anticipate obvious next steps and offer practical help proactively when it is useful.",
			"- In technical, risky, or safety-sensitive situations, prioritize clarity, correctness, and directness over personality.",
			"- Do not roleplay movie scenes or imitate copyrighted dialogue. Capture the tone, not specific lines.",
		].join("\n");
	const getFreshThreadPrompt = () => (hasConversationHistory?.() ? "" : FRESH_THREAD_CONTEXT_NOTE);
	const getActiveToolNames = (pi: ExtensionAPI) => {
		const permissions = getCommunicationPermissions();
		const activeToolNames: string[] = [];
		if (hasToolAccess()) {
			activeToolNames.push(...OPTIONAL_SIDE_TOOL_NAMES);
		}
		if (permissions.allowFollowUpToMain) {
			activeToolNames.push(followUpToolName);
		}
		if (permissions.allowSteerToMain) {
			activeToolNames.push(steerToolName);
		}
		const availableToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
		return activeToolNames.filter((toolName) => availableToolNames.has(toolName));
	};
	const getToolAccessPrompt = () =>
		hasToolAccess()
			? "Local /jarvis tool access for this turn:\n- Repo and system tools are enabled right now. You may use read, bash, edit, write, and mcp if those tools are active."
			: "Local /jarvis tool access for this turn:\n- Repo and system tools are disabled right now. Use the injected context and bridge tools only.";
	const getCommunicationPrompt = () => {
		const permissions = getCommunicationPermissions();
		return [
			"Main-agent communication bridge for this /jarvis turn:",
			permissions.allowFollowUpToMain
				? "- `" + followUpToolName + "` sends a note to the main session without interruption. It is enabled right now."
				: "- `" + followUpToolName + "` sends a note to the main session without interruption. It is disabled right now; attempts are blocked.",
			permissions.allowSteerToMain
				? "- `" + steerToolName + "` can redirect the main session. It is enabled right now, but every actual send still requires explicit user confirmation."
				: "- `" + steerToolName + "` can redirect the main session. It is disabled right now; attempts are blocked. Every send still requires explicit confirmation when enabled.",
		].join("\n");
	};
	const formatChangesSinceLastTurn = (currentMainContext: MainSessionContextPayload): string => {
		if (!previousMainContext) {
			return [
				"Changes since the last /jarvis turn:",
				"- none yet in this side session",
			].join("\n");
		}

		const changes: string[] = [];
		if (currentMainContext.summary.mainModelLabel !== previousMainContext.summary.mainModelLabel) {
			changes.push(`- Main model changed: ${previousMainContext.summary.mainModelLabel} -> ${currentMainContext.summary.mainModelLabel}`);
		}
		if (currentMainContext.summary.mainStatus !== previousMainContext.summary.mainStatus) {
			changes.push(`- Main status changed: ${previousMainContext.summary.mainStatus} -> ${currentMainContext.summary.mainStatus}`);
		}
		if (currentMainContext.summary.workState.currentAction !== previousMainContext.summary.workState.currentAction) {
			changes.push(`- Focus changed: ${previousMainContext.summary.workState.currentAction} -> ${currentMainContext.summary.workState.currentAction}`);
		}
		if (currentMainContext.summary.validation.summary !== previousMainContext.summary.validation.summary) {
			changes.push(`- Validation changed: ${currentMainContext.summary.validation.summary}`);
		}
		const previousFiles = new Set(previousMainContext.summary.workState.recentFiles);
		const newFiles = currentMainContext.summary.workState.recentFiles.filter((file) => !previousFiles.has(file));
		if (newFiles.length > 0) {
			changes.push(`- New files in focus: ${newFiles.join(", ")}`);
		}
		if (currentMainContext.summary.latestUserRequest && currentMainContext.summary.latestUserRequest !== previousMainContext.summary.latestUserRequest) {
			changes.push(`- New main request: ${currentMainContext.summary.latestUserRequest}`);
		}

		return [
			"Changes since the last /jarvis turn:",
			...(changes.length > 0 ? changes : ["- no significant change since the last /jarvis turn"]),
		].join("\n");
	};

	return (pi: ExtensionAPI): void => {
		const refreshActiveTools = () => {
			pi.setActiveTools(getActiveToolNames(pi));
		};
		bindActiveToolsSync(refreshActiveTools);

		pi.registerTool({
			name: followUpToolName,
			label: "Share a note with main",
			description: "Send a short note into the main session without interrupting it. Use only when the user explicitly requests that /jarvis forward something to the main session.",
			promptSnippet: followUpToolName + "(message) - queue a non-interrupting main-session note when permissions allow it.",
			promptGuidelines: [
				"Use this only when the user explicitly asks /jarvis to pass a note to the main session.",
				"This channel is non-interrupting and should not alter the current main turn.",
			],
			parameters: toolParameters,
			async execute(_toolCallId, params) {
				const message = params.message.trim();
				if (!message) {
					return createToolResult("blocked", "Cannot send an empty follow-up note to the main session.");
				}
				if (!getCommunicationPermissions().allowFollowUpToMain) {
					return createToolResult("blocked", "Follow-up notes to the main session are disabled for /jarvis.");
				}
				sendFollowUpToMain(message);
				return createToolResult("sent", "Sent follow-up note to the main session: " + message);
			},
		});

		pi.registerTool({
			name: steerToolName,
			label: "Redirect the main session",
			description: "Send a direct instruction to the main session. This can interrupt or redirect a running main turn, so use it only on explicit request. Confirmation is always required.",
			promptSnippet: steerToolName + "(message) - send a main-session redirect when permissions allow it.",
			promptGuidelines: [
				"Use this only when the user explicitly wants to redirect or reprioritize the main session.",
				"Every redirect send needs explicit user confirmation before it is forwarded.",
			],
			parameters: toolParameters,
			async execute(_toolCallId, params) {
				const message = params.message.trim();
				if (!message) {
					return createToolResult("blocked", "Cannot send an empty steer message to the main session.");
				}
				if (!getCommunicationPermissions().allowSteerToMain) {
					return createToolResult("blocked", "Session redirection is disabled for /jarvis.");
				}
				const confirmed = await confirmSteerToMain(message);
				if (!confirmed) {
					return createToolResult("cancelled", "Cancelled steer request to the main session.");
				}
				sendSteerToMain(message);
				return createToolResult("sent", "Sent steer message to the main session: " + message);
			},
		});

		pi.on("session_start", async () => {
			refreshActiveTools();
		});
		pi.on("before_agent_start", async () => {
			refreshActiveTools();
			const mainContext = getMainContext();
			const changesSinceLastTurnText = formatChangesSinceLastTurn(mainContext);
			const jarvisModelState = getJarvisModelState();
			const jarvisModelPrompt =
				jarvisModelState.mode === "follow-main"
					? `/jarvis model for this turn: ${jarvisModelState.activeModelLabel} (following main model)`
					: `/jarvis model for this turn: ${jarvisModelState.activeModelLabel} (pinned override)`;
			const freshThreadPrompt = getFreshThreadPrompt();
			const systemPrompt = [
				getInheritedMainSystemPrompt(),
				getIdentityPrompt(),
				getPersonalityPrompt(),
				freshThreadPrompt,
				SIDE_SYSTEM_PROMPT,
				getToolAccessPrompt(),
				jarvisModelPrompt,
				getCommunicationPrompt(),
				"Injected main-session context for this /jarvis turn:",
				mainContext.workStateText.trim(),
				changesSinceLastTurnText,
				mainContext.summaryText.trim(),
				mainContext.recentText.trim(),
			]
				.filter((section) => section.length > 0)
				.join("\n\n");
			previousMainContext = mainContext;
			return { systemPrompt };
		});
	};
}

function createSideUiContext(
	bridge: JarvisOverlayBridge,
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
			throw new Error("/jarvis side session does not support custom extension UI.");
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
		setTheme: () => ({ success: false, error: "Theme switching is unavailable inside /jarvis." }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	} as ExtensionContext["ui"];
}

function resolveOptionalMcpExtensionPath(): string | undefined {
	for (const candidate of ["pi-mcp-adapter/index.ts", "pi-mcp-adapter/index.js"]) {
		try {
			const resolved = require.resolve(candidate);
			if (existsSync(resolved)) {
				return resolved;
			}
		} catch {
			// Ignore optional dependency resolution failures.
		}
	}
	return undefined;
}

function extractPrimaryAssistantName(systemPrompt: string): string | undefined {
	for (const pattern of [/^\s*You are\s+([A-Z][\w-]*)\b/m, /^\s*Your name is\s+([A-Z][\w-]*)\b/m]) {
		const match = pattern.exec(systemPrompt);
		const name = match?.[1]?.trim();
		if (name) {
			return name;
		}
	}
	return undefined;
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

function formatMessageForOverlay(message: any): JarvisDisplayEntry[] {
	switch (message.role) {
		case "user": {
			const text = extractTextContent(message.content);
			return text ? [{ kind: "user", text }] : [];
		}
		case "assistant": {
			const text = extractAssistantText(message);
			const entries: JarvisDisplayEntry[] = [];
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
