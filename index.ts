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
import { JarvisSideSessionRuntime, createSideSessionFile } from "./side-session.js";

type JarvisModelSelection =
	| { mode: "follow-main" }
	| { mode: "pinned"; model: Model<any> };

type MainState = {
	bridge: JarvisOverlayBridge;
	mainSession: MainSessionTracker;
	mainContext: MainSessionContextPayload;
	sessionRef?: JarvisSessionRef;
	runtime?: JarvisSideSessionRuntime;
	bootPromise?: Promise<JarvisSideSessionRuntime>;
	flushPromise?: Promise<void>;
	queuedMessages: string[];
	model?: Model<any>;
	jarvisModelSelection: JarvisModelSelection;
	thinkingLevel?: string;
	systemPrompt: string;
	themeProvider: () => ExtensionContext["ui"]["theme"];
	allowSideTools: boolean;
	allowFollowUpToMain: boolean;
	allowSteerToMain: boolean;
};

export default function jarvisExtension(pi: ExtensionAPI): void {
	const mainSession = new MainSessionTracker();
	const state: MainState = {
		bridge: new JarvisOverlayBridge(),
		mainSession,
		mainContext: buildMainSessionContext(mainSession.snapshot()),
		queuedMessages: [],
		jarvisModelSelection: { mode: "follow-main" },
		systemPrompt: "",
		themeProvider: () => {
			throw new Error("/jarvis theme requested before UI was available.");
		},
		allowSideTools: false,
		allowFollowUpToMain: false,
		allowSteerToMain: false,
	};

	pi.registerCommand("jarvis", {
		description: "Open the /jarvis side conversation overlay",
		handler: async (args, ctx) => {
			updateContextState(pi, state, ctx);

			void ensureRuntime(pi, state, ctx).catch((error) => {
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
					return attachOverlayBridge(
						new JarvisOverlayComponent(tui, theme, state.bridge, overlayView, () => done(undefined)),
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
			const request = args.trim();

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

			const pinSelectedModel = async (model: Model<any>): Promise<void> => {
				try {
					await applyJarvisModelSelection(state, { mode: "pinned", model });
				} catch (error) {
					ctx.ui.notify(
						`Failed to pin /jarvis to ${formatModelLabel(model)}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}

				ctx.ui.notify(
					`Pinned /jarvis to ${formatModelLabel(model)}. The main model is still ${formatModelLabel(state.model)}.`,
					"info",
				);
			};

			if (request.toLowerCase() === "follow-main") {
				try {
					await applyJarvisModelSelection(state, { mode: "follow-main" });
				} catch (error) {
					ctx.ui.notify(
						`Failed to switch /jarvis back to follow-main: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
				ctx.ui.notify(`Set /jarvis to follow the main model (${formatModelLabel(state.model)}).`, "info");
				return;
			}

			if (!request) {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`/jarvis is ${describeJarvisModelSelection(state)}. Use /jarvis-model follow-main or /jarvis-model <provider/model>.`,
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
						: `Unknown /jarvis model "${request}". Use /jarvis-model follow-main or an exact provider/model from the current model registry.`;
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
		state.runtime?.dispose();
		state.runtime = undefined;
		state.bootPromise = undefined;
		state.flushPromise = undefined;
		state.queuedMessages = [];
		state.jarvisModelSelection = { mode: "follow-main" };
		state.allowSideTools = false;
		state.allowFollowUpToMain = false;
		state.allowSteerToMain = false;
		state.mainSession.reset(formatModelLabel(ctx.model));
		updateContextState(pi, state, ctx);
		enforceCompatibilityGuard(state);
		state.sessionRef = readJarvisSessionRef(ctx.sessionManager.getBranch());
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
		state.runtime?.dispose();
		state.runtime = undefined;
		state.bootPromise = undefined;
		state.flushPromise = undefined;
		state.queuedMessages = [];
		state.jarvisModelSelection = { mode: "follow-main" };
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
}

function getJarvisModelModeLabel(selection: JarvisModelSelection): string {
	return selection.mode === "follow-main" ? "follow main" : "pinned";
}

function describeJarvisModelSelection(state: MainState): string {
	const activeModelLabel = formatModelLabel(getDesiredJarvisModel(state));
	return state.jarvisModelSelection.mode === "follow-main"
		? `following the main model (${activeModelLabel})`
		: `pinned to ${activeModelLabel}`;
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
		const hadSessionRef = Boolean(state.sessionRef?.file);
		entries = [
			{
				kind: "system",
				text: hadSessionRef
					? "Connecting to your prior /jarvis conversation…"
					: "Starting /jarvis side conversation…",
			},
		];
		if (state.queuedMessages.length > 0) {
			entries.push({ kind: "status", text: `Queued ${state.queuedMessages.length} message${state.queuedMessages.length === 1 ? "" : "s"}…` });
		}
	}

	if (!isModelBridgeCompatible(getDesiredJarvisModel(state))) {
		entries.push({ kind: "status", text: "Relay disabled: current /jarvis model is incompatible with bridge tools" });
	}

	return entries;
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
			await runtime.syncModel(getDesiredJarvisModel(state), state.thinkingLevel);

			while (state.queuedMessages.length > 0) {
				const message = state.queuedMessages.shift()!;
				try {
					await runtime.sendMessage(message);
				} catch (error) {
					state.bridge.notify(`Failed to send /jarvis message: ${error instanceof Error ? error.message : String(error)}`, "error");
					break;
				}
			}
		} catch (error) {
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

	state.bridge.setWorkingMessage("Starting /jarvis…");
	state.bootPromise = (async () => {
		let sessionFile = state.sessionRef?.file;
		if (!sessionFile || !existsSync(sessionFile)) {
			sessionFile = await createSideSessionFile(ctx.cwd);
			state.sessionRef = createJarvisSessionRef(sessionFile);
			pi.appendEntry(JARVIS_SESSION_REF_CUSTOM_TYPE, state.sessionRef);
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

		state.runtime = runtime;
		state.bridge.setWorkingMessage(undefined);
		return runtime;
	})().catch((error) => {
		state.bridge.setWorkingMessage(undefined);
		throw error;
	}).finally(() => {
		state.bootPromise = undefined;
	});

	return state.bootPromise;
}

function formatModelLabel(model: Model<any> | undefined): string {
	if (!model) {
		return "model unavailable";
	}
	return `${model.provider}/${model.id}`;
}
