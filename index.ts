import { existsSync } from "node:fs";
import type { Model } from "@mariozechner/pi-ai";
import {
	ModelSelectorComponent,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { buildMainSessionContext, type MainSessionContextPayload } from "./main-context.js";
import { MainSessionTracker } from "./main-session-state.js";
import { attachOverlayBridge, JarvisOverlayBridge, JarvisOverlayComponent, type JarvisDisplayEntry, type JarvisOverlayView } from "./overlay.js";
import { createJarvisSessionRef, readJarvisSessionRef, JARVIS_SESSION_REF_CUSTOM_TYPE, type JarvisSessionRef } from "./session-ref.js";
import { clearJarvisModelSelectionSetting, loadJarvisModelSelectionSetting, saveJarvisModelSelectionSetting, type JarvisModelSelectionScope, type StoredJarvisModelSelection } from "./jarvis-config.js";
import { JarvisSideSessionRuntime, createSideSessionFile } from "./side-session.js";

type JarvisModelSelection =
	| { mode: "follow-main" }
	| { mode: "pinned"; model: Model<any> };

type JarvisModelSelectionSource = JarvisModelSelectionScope | "default";

type ParsedJarvisModelCommand = {
	request: string;
	scope: JarvisModelSelectionScope;
	clearScope: boolean;
};

type ResolvedJarvisModelSelection = {
	selection: JarvisModelSelection;
	source: JarvisModelSelectionSource;
	unavailable?: {
		scope: JarvisModelSelectionScope;
		modelReference: string;
	};
};

type MainState = {
	bridge: JarvisOverlayBridge;
	mainSession: MainSessionTracker;
	mainContext: MainSessionContextPayload;
	lastJarvisSeenMainContext?: MainSessionContextPayload;
	sessionRef?: JarvisSessionRef;
	runtime?: JarvisSideSessionRuntime;
	bootPromise?: Promise<JarvisSideSessionRuntime>;
	bootGeneration: number;
	flushPromise?: Promise<void>;
	queuedMessages: string[];
	model?: Model<any>;
	jarvisModelSelection: JarvisModelSelection;
	jarvisModelSelectionSource: JarvisModelSelectionSource;
	thinkingLevel?: string;
	systemPrompt: string;
	themeProvider: () => ExtensionContext["ui"]["theme"];
	allowSideTools: boolean;
	allowFollowUpToMain: boolean;
	allowSteerToMain: boolean;
};

class StaleJarvisBootError extends Error {
	constructor() {
		super("/jarvis startup was superseded by a newer session lifecycle event.");
		this.name = "StaleJarvisBootError";
	}
}

function isStaleJarvisBootError(error: unknown): error is StaleJarvisBootError {
	return error instanceof StaleJarvisBootError;
}

export default function jarvisExtension(pi: ExtensionAPI): void {
	const mainSession = new MainSessionTracker();
	const state: MainState = {
		bridge: new JarvisOverlayBridge(),
		mainSession,
		mainContext: buildMainSessionContext(mainSession.snapshot()),
		lastJarvisSeenMainContext: undefined,
		queuedMessages: [],
		jarvisModelSelection: { mode: "follow-main" },
		jarvisModelSelectionSource: "default",
		systemPrompt: "",
		themeProvider: () => {
			throw new Error("/jarvis theme requested before UI was available.");
		},
		allowSideTools: false,
		allowFollowUpToMain: false,
		allowSteerToMain: false,
		bootGeneration: 0,
	};

	pi.registerCommand("jarvis", {
		description: "Open the /jarvis side conversation overlay",
		handler: async (args, ctx) => {
			updateContextState(pi, state, ctx);

			void ensureRuntime(pi, state, ctx).catch((error) => {
				if (isStaleJarvisBootError(error)) {
					return;
				}
				state.bridge.notify(error instanceof Error ? error.message : String(error), "error");
			});

			const initialMessage = normalizeInitialMessage(args);
			if (initialMessage) {
				queueMessage(state, initialMessage);
				void flushQueuedMessages(pi, state, ctx);
			}

			const overlayView = createOverlayView(pi, state, ctx);
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					state.themeProvider = () => theme;
					const closeOverlay = () => {
						done(undefined);
						queueMicrotask(() => tui.requestRender());
					};
					return attachOverlayBridge(
						new JarvisOverlayComponent(tui, theme, state.bridge, overlayView, closeOverlay),
						state.bridge,
						tui,
					);
				},
				{
					overlay: true,
					overlayOptions: {
						width: "68%",
						minWidth: 68,
						maxHeight: "82%",
						anchor: "center",
					},
				},
			);
		},
	});

	pi.registerCommand("jarvis-model", {
		description: "Set the model used by /jarvis without changing the main agent model",
		handler: async (args, ctx) => {
			updateContextState(pi, state, ctx);

			let parsedCommand: ParsedJarvisModelCommand;
			try {
				parsedCommand = parseJarvisModelCommand(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const { request, scope, clearScope } = parsedCommand;
			const scopeLabel = formatJarvisModelSelectionScope(scope);

			const selectModelFromMenu = async (initialSearchInput?: string): Promise<Model<any> | undefined> => {
				const selectorSettingsManager = SettingsManager.inMemory();
				return ctx.ui.custom<Model<any> | undefined>(
					(tui, _theme, _keybindings, done) =>
						new ModelSelectorComponent(
							tui,
							getDesiredJarvisModel(state),
							selectorSettingsManager,
							ctx.modelRegistry,
							[],
							(model) => done(model),
							() => done(undefined),
							initialSearchInput,
						),
				);
			};

			const rollbackSelection = async (
				previousSelection: JarvisModelSelection,
				previousSource: JarvisModelSelectionSource,
			): Promise<void> => {
				await applyJarvisModelSelection(state, previousSelection);
				state.jarvisModelSelectionSource = previousSource;
			};

			const persistSelection = async (selection: JarvisModelSelection): Promise<void> => {
				const previousSelection = state.jarvisModelSelection;
				const previousSource = state.jarvisModelSelectionSource;
				await applyJarvisModelSelection(state, selection);
				try {
					saveJarvisModelSelectionSetting(ctx.cwd, scope, toStoredJarvisModelSelection(selection));
					state.jarvisModelSelectionSource = scope;
				} catch (error) {
					await rollbackSelection(previousSelection, previousSource);
					throw error;
				}
			};

			const clearScopedSelection = async (): Promise<ResolvedJarvisModelSelection> => {
				const previousSelection = state.jarvisModelSelection;
				const previousSource = state.jarvisModelSelectionSource;
				const projectSelection = scope === "project" ? undefined : loadJarvisModelSelectionSetting(ctx.cwd, "project");
				const globalSelection = scope === "global" ? undefined : loadJarvisModelSelectionSetting(ctx.cwd, "global");
				const resolvedSelection = resolveJarvisModelSelectionFromSettings(projectSelection, globalSelection, ctx.modelRegistry);
				await applyJarvisModelSelection(state, resolvedSelection.selection);
				try {
					clearJarvisModelSelectionSetting(ctx.cwd, scope);
					state.jarvisModelSelectionSource = resolvedSelection.source;
					return resolvedSelection;
				} catch (error) {
					await rollbackSelection(previousSelection, previousSource);
					throw error;
				}
			};

			const pinSelectedModel = async (model: Model<any>): Promise<void> => {
				try {
					await persistSelection({ mode: "pinned", model });
				} catch (error) {
					ctx.ui.notify(
						`Failed to pin /jarvis to ${formatModelLabel(model)} ${scopeLabel}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}

				ctx.ui.notify(
					`Pinned /jarvis to ${formatModelLabel(model)} ${scopeLabel}. The main model is still ${formatModelLabel(state.model)}.`,
					"info",
				);
			};

			if (clearScope) {
				let resolvedSelection: ResolvedJarvisModelSelection;
				try {
					resolvedSelection = await clearScopedSelection();
				} catch (error) {
					ctx.ui.notify(
						`Failed to clear the /jarvis model setting ${scopeLabel}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}

				if (resolvedSelection.unavailable) {
					ctx.ui.notify(
						`Configured /jarvis model ${resolvedSelection.unavailable.modelReference} from the ${resolvedSelection.unavailable.scope} setting is unavailable. Falling back to follow-main.`,
						"warning",
					);
				}

				ctx.ui.notify(`Cleared the /jarvis model setting ${scopeLabel}. /jarvis is now ${describeJarvisModelSelection(state)}.`, "info");
				return;
			}

			if (request.toLowerCase() === "follow-main") {
				try {
					await persistSelection({ mode: "follow-main" });
				} catch (error) {
					ctx.ui.notify(
						`Failed to switch /jarvis back to follow-main ${scopeLabel}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
				ctx.ui.notify(`Set /jarvis to follow the main model (${formatModelLabel(state.model)}) ${scopeLabel}.`, "info");
				return;
			}

			if (!request) {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`/jarvis is ${describeJarvisModelSelection(state)}. Use /jarvis-model [--project|--global] clear, /jarvis-model [--project|--global] follow-main, or /jarvis-model [--project|--global] <provider/model>.`,
						"info",
					);
					return;
				}

				const selectedModel = await selectModelFromMenu();
				if (!selectedModel) {
					return;
				}
				await pinSelectedModel(selectedModel);
				return;
			}

			const availableModels = getAvailableJarvisModels(ctx.modelRegistry);
			const exactModel = findExactAvailableModelMatch(request, availableModels);
			if (exactModel) {
				await pinSelectedModel(exactModel);
				return;
			}

			if (!ctx.hasUI) {
				const errorMessage =
					availableModels.length === 0
						? "No /jarvis models are currently available from the main model registry."
						: `Unknown /jarvis model "${request}". Use /jarvis-model [--project|--global] clear, /jarvis-model [--project|--global] follow-main, or an exact provider/model from the current model registry.`;
				ctx.ui.notify(errorMessage, "error");
				return;
			}

			const selectedModel = await selectModelFromMenu(request);
			if (!selectedModel) {
				return;
			}
			await pinSelectedModel(selectedModel);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		state.bootGeneration += 1;
		state.runtime?.dispose();
		state.runtime = undefined;
		state.bootPromise = undefined;
		state.flushPromise = undefined;
		state.queuedMessages = [];
		state.lastJarvisSeenMainContext = undefined;
		state.allowSideTools = false;
		state.allowFollowUpToMain = false;
		state.allowSteerToMain = false;
		state.mainSession.reset(formatModelLabel(ctx.model));
		const branchEntries = ctx.sessionManager.getBranch();
		state.sessionRef = readJarvisSessionRef(branchEntries);

		let resolvedSelection: ResolvedJarvisModelSelection = {
			selection: { mode: "follow-main" },
			source: "default",
		};
		resolvedSelection = resolveConfiguredJarvisModelSelection(ctx.cwd, ctx.modelRegistry, (scope, error) => {
			ctx.ui.notify(`Failed to load the ${scope} /jarvis model setting: ${error instanceof Error ? error.message : String(error)}`, "error");
		});

		state.jarvisModelSelection = resolvedSelection.selection;
		state.jarvisModelSelectionSource = resolvedSelection.source;
		updateContextState(pi, state, ctx);
		enforceCompatibilityGuard(state);
		if (resolvedSelection.unavailable) {
			ctx.ui.notify(
				`Configured /jarvis model ${resolvedSelection.unavailable.modelReference} from the ${resolvedSelection.unavailable.scope} setting is unavailable. /jarvis is now ${describeJarvisModelSelection(state)}.`,
				"warning",
			);
		}
		state.bridge.reset();
	});

	pi.on("agent_start", async (_event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleAgentStart();
		refreshMainContext(state);
	});

	pi.on("agent_end", async (_event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleAgentEnd();
		refreshMainContext(state);
	});

	pi.on("message_start", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleMessageStart(event);
		refreshMainContext(state);
	});

	pi.on("message_update", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleMessageUpdate(event);
		refreshMainContext(state);
	});

	pi.on("message_end", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleMessageEnd(event);
		refreshMainContext(state);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleToolExecutionStart(event);
		refreshMainContext(state);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleToolExecutionEnd(event);
		refreshMainContext(state);
	});

	pi.on("model_select", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.model = event.model;
		state.mainSession.handleModelSelect(formatModelLabel(event.model));
		refreshMainContext(state);
		enforceCompatibilityGuard(state);
		if (!state.runtime || state.jarvisModelSelection.mode !== "follow-main") {
			return;
		}
		try {
			await syncRuntimeModelSelection(state);
		} catch (error) {
			state.bridge.notify(`Failed to sync /jarvis model: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		state.bootGeneration += 1;
		state.runtime?.dispose();
		state.runtime = undefined;
		state.bootPromise = undefined;
		state.flushPromise = undefined;
		state.queuedMessages = [];
		state.lastJarvisSeenMainContext = undefined;
		state.jarvisModelSelection = { mode: "follow-main" };
		state.jarvisModelSelectionSource = "default";
		state.allowSideTools = false;
		state.allowFollowUpToMain = false;
		state.allowSteerToMain = false;
		state.mainSession.reset(formatModelLabel(state.model));
		refreshMainContext(state);
		// Cancel any pending confirmation and clear transient overlay state so a
		// side-session tool execute still waiting on confirmSteerToMain does not
		// hang while the session is torn down.
		state.bridge.reset();
	});
}

function updateContextState(pi: ExtensionAPI, state: MainState, ctx: ExtensionContext): void {
	state.model = ctx.model;
	state.thinkingLevel = pi.getThinkingLevel();
	state.systemPrompt = ctx.getSystemPrompt();
	state.themeProvider = () => ctx.ui.theme;
	state.mainSession.refreshFromContext(ctx, formatModelLabel(state.model));
	refreshMainContext(state);
}

function refreshMainContext(state: MainState): void {
	state.mainContext = buildMainSessionContext(state.mainSession.snapshot());
}

function getDesiredJarvisModel(state: MainState): Model<any> | undefined {
	return state.jarvisModelSelection.mode === "pinned" ? state.jarvisModelSelection.model : state.model;
}

function getDesiredJarvisThinkingLevel(state: MainState): string | undefined {
	const desiredModel = getDesiredJarvisModel(state);
	if (desiredModel?.provider === "xai") {
		return "off";
	}
	return state.jarvisModelSelection.mode === "follow-main" ? state.thinkingLevel : "off";
}

function toStoredJarvisModelSelection(selection: JarvisModelSelection): StoredJarvisModelSelection {
	return selection.mode === "follow-main"
		? { mode: "follow-main" }
		: { mode: "pinned", provider: selection.model.provider, modelId: selection.model.id };
}

function formatJarvisModelSelectionSource(source: JarvisModelSelectionSource): string {
	if (source === "project") {
		return "project setting";
	}
	if (source === "global") {
		return "global setting";
	}
	return "default";
}

function formatJarvisModelSelectionScope(scope: JarvisModelSelectionScope): string {
	return scope === "project" ? "for this project" : "globally";
}

function parseJarvisModelCommand(args: string): ParsedJarvisModelCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let scope: JarvisModelSelectionScope = "project";
	let scopeExplicitlySet = false;
	const requestTokens: string[] = [];

	for (const token of tokens) {
		if (token === "--project" || token === "--global") {
			if (scopeExplicitlySet) {
				throw new Error("Choose only one scope flag: --project or --global.");
			}
			scope = token === "--global" ? "global" : "project";
			scopeExplicitlySet = true;
			continue;
		}
		requestTokens.push(token);
	}

	const request = requestTokens.join(" " );
	return {
		request,
		scope,
		clearScope: request.toLowerCase() === "clear",
	};
}

function resolveStoredJarvisModelSelection(
	storedSelection: StoredJarvisModelSelection,
	source: JarvisModelSelectionSource,
	modelRegistry: ExtensionContext["modelRegistry"],
): ResolvedJarvisModelSelection {
	if (storedSelection.mode === "follow-main") {
		return {
			selection: { mode: "follow-main" },
			source,
		};
	}

	const restoredModel = modelRegistry.find(storedSelection.provider, storedSelection.modelId);
	if (!restoredModel) {
		return {
			selection: { mode: "follow-main" },
			source: "default",
			unavailable: {
				scope: source === "default" ? "project" : source,
				modelReference: `${storedSelection.provider}/${storedSelection.modelId}`,
			},
		};
	}

	return {
		selection: { mode: "pinned", model: restoredModel },
		source,
	};
}

function resolveJarvisModelSelectionFromSettings(
	projectSelection: StoredJarvisModelSelection | undefined,
	globalSelection: StoredJarvisModelSelection | undefined,
	modelRegistry: ExtensionContext["modelRegistry"],
): ResolvedJarvisModelSelection {
	if (projectSelection) {
		const resolvedProjectSelection = resolveStoredJarvisModelSelection(projectSelection, "project", modelRegistry);
		if (!resolvedProjectSelection.unavailable) {
			return resolvedProjectSelection;
		}
		if (globalSelection) {
			const resolvedGlobalSelection = resolveStoredJarvisModelSelection(globalSelection, "global", modelRegistry);
			if (!resolvedGlobalSelection.unavailable) {
				return {
					...resolvedGlobalSelection,
					unavailable: resolvedProjectSelection.unavailable,
				};
			}
		}
		return resolvedProjectSelection;
	}
	if (globalSelection) {
		return resolveStoredJarvisModelSelection(globalSelection, "global", modelRegistry);
	}
	return {
		selection: { mode: "follow-main" },
		source: "default",
	};
}

function resolveConfiguredJarvisModelSelection(
	cwd: string,
	modelRegistry: ExtensionContext["modelRegistry"],
	onScopeError?: (scope: JarvisModelSelectionScope, error: unknown) => void,
): ResolvedJarvisModelSelection {
	let projectSelection: StoredJarvisModelSelection | undefined;
	let globalSelection: StoredJarvisModelSelection | undefined;

	try {
		projectSelection = loadJarvisModelSelectionSetting(cwd, "project");
	} catch (error) {
		onScopeError?.("project", error);
	}

	try {
		globalSelection = loadJarvisModelSelectionSetting(cwd, "global");
	} catch (error) {
		onScopeError?.("global", error);
	}

	return resolveJarvisModelSelectionFromSettings(projectSelection, globalSelection, modelRegistry);
}


function isModelBridgeCompatible(model: Model<any> | undefined): boolean {
	if (!model) {
		return true;
	}
	if (model.provider === "xai" && model.id.includes("multi-agent")) {
		return false;
	}
	return true;
}

function enforceCompatibilityGuard(state: MainState): void {
	const desired = getDesiredJarvisModel(state);
	if (!isModelBridgeCompatible(desired)) {
		state.allowFollowUpToMain = false;
		state.allowSteerToMain = false;
		state.bridge.notify(`Disabled Follow-up/Steer: ${formatModelLabel(desired)} does not support bridge tools.`, "warning");
	}
	state.runtime?.setToolAccessEnabled(state.allowSideTools);
}

function getJarvisModelModeLabel(selection: JarvisModelSelection): string {
	return selection.mode === "follow-main" ? "follow main" : "pinned";
}

function describeJarvisModelSelection(state: MainState): string {
	const activeModelLabel = formatModelLabel(getDesiredJarvisModel(state));
	const sourceLabel = formatJarvisModelSelectionSource(state.jarvisModelSelectionSource);
	return state.jarvisModelSelection.mode === "follow-main"
		? `following the main model (${activeModelLabel}; ${sourceLabel})`
		: `pinned to ${activeModelLabel} (${sourceLabel})`;
}

function getAvailableJarvisModels(modelRegistry: ExtensionContext["modelRegistry"]): readonly Model<any>[] {
	modelRegistry.refresh();
	try {
		return modelRegistry.getAvailable();
	} catch {
		return [];
	}
}

function findExactAvailableModelMatch(
	modelReference: string,
	availableModels: readonly Model<any>[],
): Model<any> | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}

	const normalizedReference = trimmedReference.toLowerCase();

	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) {
		return canonicalMatches[0];
	}
	if (canonicalMatches.length > 1) {
		return undefined;
	}

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) {
				return providerMatches[0];
			}
			if (providerMatches.length > 1) {
				return undefined;
			}
		}
	}

	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

async function syncRuntimeModelSelection(state: MainState): Promise<void> {
	if (!state.runtime) {
		return;
	}
	await state.runtime.syncModel(getDesiredJarvisModel(state), getDesiredJarvisThinkingLevel(state));
}

async function applyJarvisModelSelection(state: MainState, selection: JarvisModelSelection): Promise<void> {
	const previousSelection = state.jarvisModelSelection;
	state.jarvisModelSelection = selection;
	try {
		await syncRuntimeModelSelection(state);
		enforceCompatibilityGuard(state);
	} catch (error) {
		state.jarvisModelSelection = previousSelection;
		try {
			await syncRuntimeModelSelection(state);
			enforceCompatibilityGuard(state);
		} catch {
			// Keep the original sync failure; rollback is best-effort only.
		}
		throw error;
	}
}

function normalizeInitialMessage(args: string): string | undefined {
	const message = args.trim();
	return message.length > 0 ? message : undefined;
}

function queueMessage(state: MainState, message: string): void {
	state.queuedMessages.push(message);
}

function createOverlayView(pi: ExtensionAPI, state: MainState, ctx: ExtensionCommandContext): JarvisOverlayView {
	const syncToolAccess = () => {
		state.runtime?.setToolAccessEnabled(state.allowSideTools);
	};

	return {
		isReady: () => state.runtime?.isReady() ?? false,
		isStreaming: () => state.runtime?.isStreaming() ?? false,
		getModelLabel: () => state.runtime?.getModelLabel() ?? formatModelLabel(getDesiredJarvisModel(state)),
		getModelModeLabel: () => getJarvisModelModeLabel(state.jarvisModelSelection),
		getMainStatusLabel: () => state.mainContext.summary.mainStatus,
		getMainModelLabel: () => state.mainContext.summary.mainModelLabel,
		getMainFocusLabel: () => state.mainContext.summary.workState.currentAction,
		getMainDeltaLabel: () => formatMainContextDeltaLabel(state.lastJarvisSeenMainContext, state.mainContext),
		getRepoToolsDetailLabel: () => state.runtime?.getRepoToolsDetailLabel() ?? (state.allowSideTools ? "local tools only" : "repo tools off"),
		isToolAccessEnabled: () => state.allowSideTools,
		isFollowUpToMainEnabled: () => state.allowFollowUpToMain,
		isSteerToMainEnabled: () => state.allowSteerToMain,
		toggleToolAccess: () => {
			state.allowSideTools = !state.allowSideTools;
			syncToolAccess();
		},
		toggleFollowUpToMain: () => {
			if (!isModelBridgeCompatible(getDesiredJarvisModel(state))) {
				state.bridge.notify("Follow-up is not supported by the current /jarvis model.", "warning");
				return;
			}
			state.allowFollowUpToMain = !state.allowFollowUpToMain;
			syncToolAccess();
		},
		toggleSteerToMain: () => {
			if (!isModelBridgeCompatible(getDesiredJarvisModel(state))) {
				state.bridge.notify("Steer is not supported by the current /jarvis model.", "warning");
				return;
			}
			state.allowSteerToMain = !state.allowSteerToMain;
			syncToolAccess();
		},
		getDisplayEntries: () => getOverlayEntries(state),
		sendMessage: async (text: string) => {
			queueMessage(state, text);
			await flushQueuedMessages(pi, state, ctx);
		},
	};
}

function getOverlayEntries(state: MainState): JarvisDisplayEntry[] {
	let entries: JarvisDisplayEntry[];
	if (state.runtime) {
		entries = state.runtime.getDisplayEntries();
	} else {
		const hasRestorableSessionRef = Boolean(state.sessionRef?.file && existsSync(state.sessionRef.file));
		entries = [
			{
				kind: "system",
				text: hasRestorableSessionRef
					? "Connecting to your prior /jarvis conversation…"
					: "Starting /jarvis side conversation…",
			},
		];
		if (state.queuedMessages.length > 0) {
			entries.push({ kind: "status", text: `Queued ${state.queuedMessages.length} message${state.queuedMessages.length === 1 ? "" : "s"}…` });
		}
	}

	entries.push({ kind: "status", text: `Since last /jarvis turn: ${formatMainContextDeltaLabel(state.lastJarvisSeenMainContext, state.mainContext)}` });
	entries.push({ kind: "status", text: `Repo tools: ${state.runtime?.getRepoToolsDetailLabel() ?? (state.allowSideTools ? "local tools only" : "repo tools off")}` });

	if (!isModelBridgeCompatible(getDesiredJarvisModel(state))) {
		entries.push({ kind: "status", text: "Relay disabled: current /jarvis model is incompatible with bridge tools" });
	}

	return entries;
}

function formatMainContextDeltaLabel(
	previousContext: MainSessionContextPayload | undefined,
	currentContext: MainSessionContextPayload,
): string {
	if (!previousContext) {
		return "first /jarvis turn";
	}
	if (currentContext.summary.workState.currentAction !== previousContext.summary.workState.currentAction) {
		return `focus → ${currentContext.summary.workState.currentAction}`;
	}
	if (currentContext.summary.validation.summary !== previousContext.summary.validation.summary) {
		return `validation → ${currentContext.summary.validation.summary}`;
	}
	if (currentContext.summary.mainStatus !== previousContext.summary.mainStatus) {
		return `main status → ${currentContext.summary.mainStatus}`;
	}
	if (currentContext.summary.mainModelLabel !== previousContext.summary.mainModelLabel) {
		return `model → ${currentContext.summary.mainModelLabel}`;
	}
	const previousFiles = new Set(previousContext.summary.workState.recentFiles);
	const newFiles = currentContext.summary.workState.recentFiles.filter((file) => !previousFiles.has(file));
	if (newFiles.length > 0) {
		return `new files → ${newFiles.join(", ")}`;
	}
	if (currentContext.summary.latestUserRequest && currentContext.summary.latestUserRequest !== previousContext.summary.latestUserRequest) {
		return `request → ${currentContext.summary.latestUserRequest}`;
	}
	return "no significant change";
}

async function flushQueuedMessages(pi: ExtensionAPI, state: MainState, ctx: ExtensionCommandContext): Promise<void> {
	updateContextState(pi, state, ctx);

	if (state.flushPromise) {
		return state.flushPromise;
	}

	// flushQueuedMessages is awaited in fire-and-forget paths (the /jarvis command
	// handler's initial message flush and the overlay input submit). Any error
	// that propagates out of here becomes an unhandled promise rejection, so the
	// IIFE must catch and surface every failure via bridge.notify rather than
	// rethrowing.
	state.flushPromise = (async () => {
		try {
			const runtime = await ensureRuntime(pi, state, ctx);
			await runtime.syncModel(getDesiredJarvisModel(state), getDesiredJarvisThinkingLevel(state));

			while (state.queuedMessages.length > 0) {
				const message = state.queuedMessages[0]!;
				try {
					await runtime.sendMessage(message);
					state.queuedMessages.shift();
					state.lastJarvisSeenMainContext = state.mainContext;
				} catch (error) {
					state.bridge.notify(`Failed to send /jarvis message: ${error instanceof Error ? error.message : String(error)}`, "error");
					break;
				}
			}
		} catch (error) {
			if (isStaleJarvisBootError(error)) {
				return;
			}
			state.bridge.notify(`/jarvis startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	})().finally(() => {
		state.flushPromise = undefined;
	});

	return state.flushPromise;
}

async function ensureRuntime(pi: ExtensionAPI, state: MainState, ctx: ExtensionCommandContext): Promise<JarvisSideSessionRuntime> {
	if (state.runtime) {
		return state.runtime;
	}
	if (state.bootPromise) {
		return state.bootPromise;
	}

	const bootGeneration = state.bootGeneration;
	const isCurrentBoot = () => state.bootGeneration === bootGeneration;
	state.bridge.setWorkingMessage("Starting /jarvis…");
	let bootPromise: Promise<JarvisSideSessionRuntime>;
	bootPromise = (async () => {
		let sessionFile = state.sessionRef?.file;
		if (!sessionFile || !existsSync(sessionFile)) {
			sessionFile = await createSideSessionFile(ctx.cwd);
			if (!isCurrentBoot()) {
				throw new StaleJarvisBootError();
			}
			const sessionRef = createJarvisSessionRef(sessionFile);
			state.sessionRef = sessionRef;
			pi.appendEntry(JARVIS_SESSION_REF_CUSTOM_TYPE, sessionRef);
		}

		const runtime = await JarvisSideSessionRuntime.create({
			bridge: state.bridge,
			cwd: ctx.cwd,
			modelRegistry: ctx.modelRegistry,
			model: getDesiredJarvisModel(state),
			jarvisModelModeProvider: () => state.jarvisModelSelection.mode,
			thinkingLevel: getDesiredJarvisThinkingLevel(state),
			sessionFile,
			systemPromptProvider: () => state.systemPrompt,
			mainContextProvider: () => state.mainContext,
			toolAccessProvider: () => state.allowSideTools,
			communicationPermissionsProvider: () => ({
				allowFollowUpToMain: state.allowFollowUpToMain,
				allowSteerToMain: state.allowSteerToMain,
			}),
			sendFollowUpToMain: (message: string) => {
				pi.sendUserMessage(message, { deliverAs: "followUp" });
			},
			// Route the confirmation through the /jarvis overlay itself via the
			// bridge. The main session's UI confirm would otherwise render inside
			// the base layer (the pi editor container) and sit hidden behind the
			// /jarvis overlay, leaving the side-session tool execute hung on a
			// promise the user could never answer.
			confirmSteerToMain: (message: string) =>
				state.bridge.requestConfirmation(
					"Send /jarvis steer to main?",
					`This will steer the main agent with:\n\n${message}`,
				),
			sendSteerToMain: (message: string) => {
				pi.sendUserMessage(message, { deliverAs: "steer" });
			},
			themeProvider: state.themeProvider,
		});

		if (!isCurrentBoot()) {
			runtime.dispose();
			throw new StaleJarvisBootError();
		}

		state.runtime = runtime;
		state.bridge.setWorkingMessage(undefined);
		return runtime;
	})().catch((error) => {
		state.bridge.setWorkingMessage(undefined);
		throw error;
	}).finally(() => {
		if (state.bootPromise === bootPromise) {
			state.bootPromise = undefined;
		}
	});
	state.bootPromise = bootPromise;

	return bootPromise;
}

function formatModelLabel(model: Model<any> | undefined): string {
	if (!model) {
		return "model unavailable";
	}
	return `${model.provider}/${model.id}`;
}
