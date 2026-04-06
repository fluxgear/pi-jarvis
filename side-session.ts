import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { BtwOverlayBridge, type BtwDisplayEntry, type BtwOverlayView } from "./overlay.js";
import { type McpProxyRequest, requiresMcpMutationApproval } from "./mcp-policy.js";

const SIDE_SYSTEM_PROMPT = `
This is the /btw side conversation.
Keep replies concise and focused on the side task.
You are read-only by default.
If you need to make file edits, run shell commands that may mutate state, or call MCP tools that may mutate state, first call btw_request_write_access with a concise reason and wait for the result before proceeding.
Do not assume write access exists unless that tool returned approval in the current response.
`.trim();

const SAFE_TOOL_NAMES = ["read", "grep", "find", "ls", "mcp", "btw_request_write_access"] as const;
const MUTATING_TOOL_NAMES = ["bash", "edit", "write"] as const;

type SideSessionHandle = Awaited<ReturnType<typeof createAgentSession>>["session"];

type ToolMetadata = {
	name: string;
	description: string;
};

type McpExtensionState = {
	toolMetadata: Map<string, ToolMetadata[]>;
	uiServer: { close(reason: string): void } | null;
	lifecycle: { gracefulShutdown(): Promise<void> };
};

type McpModules = {
	loadMcpConfig: (configPath?: string) => unknown;
	buildProxyDescription: (config: unknown, cache: unknown, directSpecs: unknown[]) => string;
	loadMetadataCache: () => unknown;
	initializeMcp: (pi: ExtensionAPI, ctx: ExtensionContext) => Promise<McpExtensionState>;
	updateStatusBar: (state: McpExtensionState) => void;
	flushMetadataCache: (state: McpExtensionState) => void;
	executeCall: (state: McpExtensionState, tool: string, args?: Record<string, unknown>, server?: string) => Promise<any>;
	executeConnect: (state: McpExtensionState, server: string) => Promise<any>;
	executeDescribe: (state: McpExtensionState, tool: string) => Promise<any>;
	executeList: (state: McpExtensionState, server: string) => Promise<any>;
	executeSearch: (
		state: McpExtensionState,
		search: string,
		regex?: boolean,
		server?: string,
		includeSchemas?: boolean,
		getPiTools?: () => unknown[],
	) => Promise<any>;
	executeStatus: (state: McpExtensionState) => Promise<any>;
	executeUiMessages: (state: McpExtensionState) => Promise<any>;
	findToolByName: (metadata: ToolMetadata[] | undefined, toolName: string) => ToolMetadata | undefined;
};

let mcpModulesPromise: Promise<McpModules> | undefined;

async function loadMcpModules(): Promise<McpModules> {
	if (!mcpModulesPromise) {
		const root = "pi-mcp-adapter";
		mcpModulesPromise = Promise.all([
			import(`${root}/config.js`),
			import(`${root}/direct-tools.js`),
			import(`${root}/init.js`),
			import(`${root}/metadata-cache.js`),
			import(`${root}/proxy-modes.js`),
			import(`${root}/tool-metadata.js`),
		]).then(([config, directTools, init, metadata, proxy, toolMetadata]) => ({
			loadMcpConfig: config.loadMcpConfig,
			buildProxyDescription: directTools.buildProxyDescription,
			loadMetadataCache: metadata.loadMetadataCache,
			initializeMcp: init.initializeMcp,
			updateStatusBar: init.updateStatusBar,
			flushMetadataCache: init.flushMetadataCache,
			executeCall: proxy.executeCall,
			executeConnect: proxy.executeConnect,
			executeDescribe: proxy.executeDescribe,
			executeList: proxy.executeList,
			executeSearch: proxy.executeSearch,
			executeStatus: proxy.executeStatus,
			executeUiMessages: proxy.executeUiMessages,
			findToolByName: toolMetadata.findToolByName,
		}));
	}
	return mcpModulesPromise;
}

type SideRuntimeCreateOptions = {
	bridge: BtwOverlayBridge;
	cwd: string;
	modelRegistry: ExtensionContext["modelRegistry"];
	model: Model<any> | undefined;
	thinkingLevel: string | undefined;
	sessionFile: string;
	systemPromptProvider: () => string;
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

export class BtwSideSessionRuntime implements BtwOverlayView {
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
		return this.bridge.snapshot().mutationAccessGranted ? "mutation approved" : "read-only";
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
		this.bridge.cancelPending();
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
			extensionFactories: [createSideExtensionFactory(this.bridge, options.systemPromptProvider)],
			appendSystemPrompt: SIDE_SYSTEM_PROMPT,
		});
		await resourceLoader.reload();

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: options.cwd,
			agentDir: getAgentDir(),
			modelRegistry: options.modelRegistry as any,
			model: options.model,
			thinkingLevel: options.thinkingLevel as any,
			tools: [
				createReadTool(options.cwd),
				createBashTool(options.cwd),
				createEditTool(options.cwd),
				createWriteTool(options.cwd),
				createGrepTool(options.cwd),
				createFindTool(options.cwd),
				createLsTool(options.cwd),
			],
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
	bridge: BtwOverlayBridge,
	getMainSystemPrompt: SideRuntimeCreateOptions["systemPromptProvider"],
) {
	return (pi: ExtensionAPI): void => {
		let mcpState: McpExtensionState | null = null;
		let initPromise: Promise<McpExtensionState> | null = null;
		let mutationGranted = false;

		const applyToolMode = () => {
			const allowed = new Set<string>(SAFE_TOOL_NAMES);
			if (mutationGranted) {
				for (const name of MUTATING_TOOL_NAMES) {
					allowed.add(name);
				}
			}
			const available = new Set(pi.getAllTools().map((tool) => tool.name));
			pi.setActiveTools(Array.from(allowed).filter((name) => available.has(name)));
			bridge.setMutationAccessGranted(mutationGranted);
		};

		const ensureMcpReady = async (ctx?: ExtensionContext): Promise<McpExtensionState | null> => {
			if (mcpState) {
				return mcpState;
			}
			if (!initPromise) {
				if (!ctx) {
					return null;
				}
				initPromise = loadMcpModules()
					.then((mcp) => mcp.initializeMcp(pi, ctx).then((state) => ({ mcp, state })))
					.then(({ mcp, state }) => {
						mcpState = state;
						initPromise = null;
						mcp.updateStatusBar(state);
						return state;
					})
					.catch((error) => {
						initPromise = null;
						throw error;
					});
			}
			return initPromise;
		};

		pi.on("before_agent_start", async () => {
			const systemPrompt = getMainSystemPrompt().trim();
			if (systemPrompt.length === 0) {
				return;
			}
			return { systemPrompt };
		});

		pi.on("session_start", async (_event, ctx) => {
			mutationGranted = false;
			applyToolMode();
			try {
				await ensureMcpReady(ctx);
			} catch (error) {
				bridge.notify(`MCP initialization failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		});

		pi.on("agent_end", async () => {
			if (mutationGranted) {
				mutationGranted = false;
				applyToolMode();
			}
		});

		pi.on("tool_call", async (event) => {
			if (mutationGranted) {
				return;
			}
			if (event.toolName === "bash" || event.toolName === "edit" || event.toolName === "write") {
				return {
					block: true,
					reason: "Mutation access not granted. Call btw_request_write_access first.",
				};
			}
		});

		pi.on("session_shutdown", async () => {
			if (initPromise) {
				try {
					mcpState = await initPromise;
				} catch {
					// Ignore failed MCP startup.
				}
			}
			if (mcpState) {
				if (mcpState.uiServer) {
					mcpState.uiServer.close("session_shutdown");
					mcpState.uiServer = null;
				}
				const mcp = await loadMcpModules();
				mcp.flushMetadataCache(mcpState);
				await mcpState.lifecycle.gracefulShutdown();
				mcpState = null;
			}
		});

		pi.registerTool({
			name: "btw_request_write_access",
			label: "Request Write Access",
			description: "Request temporary mutation access for the current /btw response.",
			promptSnippet: "Request temporary write/system mutation permission for the current /btw response.",
			promptGuidelines: [
				"Call this before using bash, edit, write, or MCP tools that might mutate state.",
			],
			parameters: Type.Object({
				reason: Type.String({ description: "Concise explanation of the proposed mutation." }),
			}),
			async execute(_toolCallId, params: { reason: string }) {
				const approved = await bridge.requestMutationApproval({
					title: "Allow /btw mutation access?",
					message: params.reason,
				});
				mutationGranted = approved;
				applyToolMode();
				return {
					content: [
						{
							type: "text",
							text: approved
								? "Mutation access granted for the current /btw response. You may now use bash, edit, write, and approved MCP mutations until this response completes."
								: "Mutation access denied. The /btw agent remains read-only.",
						},
					],
					details: { approved, reason: params.reason },
				};
			},
		});

		pi.registerTool({
			name: "mcp",
			label: "MCP",
			description: "MCP gateway - connect to MCP servers and call their tools.",
			promptSnippet: "MCP gateway - connect to MCP servers and call their tools.",
			parameters: Type.Object({
				tool: Type.Optional(Type.String({ description: "Tool name to call" })),
				args: Type.Optional(Type.String({ description: "Arguments as a JSON object string" })),
				connect: Type.Optional(Type.String({ description: "Server name to connect or reconnect" })),
				describe: Type.Optional(Type.String({ description: "Tool name to describe" })),
				search: Type.Optional(Type.String({ description: "Search query" })),
				regex: Type.Optional(Type.Boolean({ description: "Treat search as regex" })),
				includeSchemas: Type.Optional(Type.Boolean({ description: "Include schemas in search results" })),
				server: Type.Optional(Type.String({ description: "Restrict to a specific server" })),
				action: Type.Optional(Type.String({ description: "Action such as 'ui-messages'" })),
			}),
			async execute(
				_toolCallId,
				params: {
					tool?: string;
					args?: string;
					connect?: string;
					describe?: string;
					search?: string;
					regex?: boolean;
					includeSchemas?: boolean;
					server?: string;
					action?: string;
				},
				_signal,
				_onUpdate,
				ctx,
			) {
				let parsedArgs: Record<string, unknown> | undefined;
				if (params.args) {
					try {
						const parsed = JSON.parse(params.args);
						if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
							const gotType = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
							return {
								content: [{ type: "text" as const, text: `Invalid args: expected a JSON object, got ${gotType}` }],
								details: { error: "invalid_args_type" },
							};
						}
						parsedArgs = parsed as Record<string, unknown>;
					} catch (error) {
						return {
							content: [{ type: "text" as const, text: `Invalid args JSON: ${error instanceof Error ? error.message : String(error)}` }],
							details: { error: "invalid_args" },
						};
					}
				}

				const mcp = await loadMcpModules();
				const state = await ensureMcpReady(ctx);
				if (!state) {
					return {
						content: [{ type: "text" as const, text: "MCP not initialized" }],
						details: { error: "not_initialized" },
					};
				}

				if (params.tool) {
					const metadata = findRequestedMcpTool(state, params.tool, params.server);
					if (!mutationGranted && requiresMcpMutationApproval(params as McpProxyRequest, metadata)) {
						return {
							content: [
								{
									type: "text" as const,
									text: `MCP tool "${params.tool}" may mutate state. Call btw_request_write_access first.`,
								},
							],
							details: { error: "mutation_access_required", tool: params.tool, server: params.server },
						};
					}
				}

				if (params.action === "ui-messages") {
					return mcp.executeUiMessages(state);
				}
				if (params.tool) {
					return mcp.executeCall(state, params.tool, parsedArgs, params.server);
				}
				if (params.connect) {
					return mcp.executeConnect(state, params.connect);
				}
				if (params.describe) {
					return mcp.executeDescribe(state, params.describe);
				}
				if (params.search) {
					return mcp.executeSearch(state, params.search, params.regex, params.server, params.includeSchemas, () => pi.getAllTools());
				}
				if (params.server) {
					return mcp.executeList(state, params.server);
				}
				return mcp.executeStatus(state);
			},
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

function findRequestedMcpTool(
	state: McpExtensionState,
	toolName: string,
	serverName?: string,
): ToolMetadata | undefined {
	if (serverName) {
		return findToolByNameLocal(state.toolMetadata.get(serverName), toolName);
	}
	for (const metadata of state.toolMetadata.values()) {
		const match = findToolByNameLocal(metadata, toolName);
		if (match) {
			return match;
		}
	}
	return undefined;
}

function findToolByNameLocal(metadata: ToolMetadata[] | undefined, toolName: string): ToolMetadata | undefined {
	if (!metadata) {
		return undefined;
	}
	const exact = metadata.find((item) => item.name === toolName);
	if (exact) {
		return exact;
	}
	const normalized = toolName.replace(/-/g, "_");
	return metadata.find((item) => item.name.replace(/-/g, "_") === normalized);
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
