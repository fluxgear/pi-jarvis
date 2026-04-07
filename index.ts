import { existsSync } from "node:fs";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildMainSessionContext, type MainSessionContextPayload } from "./main-context.js";
import { MainSessionTracker } from "./main-session-state.js";
import { attachOverlayBridge, BtwOverlayBridge, BtwOverlayComponent, type BtwDisplayEntry, type BtwOverlayView } from "./overlay.js";
import { createBtwSessionRef, readBtwSessionRef, BTW_SESSION_REF_CUSTOM_TYPE, type BtwSessionRef } from "./session-ref.js";
import { BtwSideSessionRuntime, createSideSessionFile } from "./side-session.js";

type MainState = {
	bridge: BtwOverlayBridge;
	mainSession: MainSessionTracker;
	mainContext: MainSessionContextPayload;
	sessionRef?: BtwSessionRef;
	runtime?: BtwSideSessionRuntime;
	bootPromise?: Promise<BtwSideSessionRuntime>;
	flushPromise?: Promise<void>;
	queuedMessages: string[];
	model?: Model<any>;
	thinkingLevel?: string;
	systemPrompt: string;
	themeProvider: () => ExtensionContext["ui"]["theme"];
	allowFollowUpToMain: boolean;
	allowSteerToMain: boolean;
};
export default function btwExtension(pi: ExtensionAPI): void {
	const mainSession = new MainSessionTracker();
	const state: MainState = {
		bridge: new BtwOverlayBridge(),
		mainSession,
		mainContext: buildMainSessionContext(mainSession.snapshot()),
		queuedMessages: [],
		systemPrompt: "",
		themeProvider: () => {
			throw new Error("/btw theme requested before UI was available.");
		},
		allowFollowUpToMain: false,
		allowSteerToMain: false,
	};

	pi.registerCommand("btw", {
		description: "Open the /btw side conversation overlay",
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
						new BtwOverlayComponent(tui, theme, state.bridge, overlayView, () => done(undefined)),
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

	pi.on("session_start", async (_event, ctx) => {
		state.runtime?.dispose();
		state.runtime = undefined;
		state.bootPromise = undefined;
		state.flushPromise = undefined;
		state.queuedMessages = [];
		state.allowFollowUpToMain = false;
		state.allowSteerToMain = false;
		state.mainSession.reset(formatModelLabel(ctx.model));
		updateContextState(pi, state, ctx);
		state.sessionRef = readBtwSessionRef(ctx.sessionManager.getBranch());
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
		if (!state.runtime) {
			return;
		}
		try {
			await state.runtime.syncModel(event.model, state.thinkingLevel);
		} catch (error) {
			state.bridge.notify(`Failed to sync /btw model: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		state.runtime?.dispose();
		state.runtime = undefined;
		state.bootPromise = undefined;
		state.flushPromise = undefined;
		state.queuedMessages = [];
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

function normalizeInitialMessage(args: string): string | undefined {
	const message = args.trim();
	return message.length > 0 ? message : undefined;
}

function queueMessage(state: MainState, message: string): void {
	state.queuedMessages.push(message);
}

function createOverlayView(pi: ExtensionAPI, state: MainState, ctx: ExtensionCommandContext): BtwOverlayView {
	return {
		isReady: () => state.runtime?.isReady() ?? false,
		isStreaming: () => state.runtime?.isStreaming() ?? false,
		getModelLabel: () => state.runtime?.getModelLabel() ?? formatModelLabel(state.model),
		getMainStatusLabel: () => state.mainContext.summary.mainStatus,
		getMainModelLabel: () => state.mainContext.summary.mainModelLabel,
		isFollowUpToMainEnabled: () => state.allowFollowUpToMain,
		isSteerToMainEnabled: () => state.allowSteerToMain,
		toggleFollowUpToMain: () => {
			state.allowFollowUpToMain = !state.allowFollowUpToMain;
		},
		toggleSteerToMain: () => {
			state.allowSteerToMain = !state.allowSteerToMain;
		},
		getDisplayEntries: () => getOverlayEntries(state),
		sendMessage: async (text: string) => {
			queueMessage(state, text);
			await flushQueuedMessages(pi, state, ctx);
		},
	};
}

function getOverlayEntries(state: MainState): BtwDisplayEntry[] {
	if (state.runtime) {
		return state.runtime.getDisplayEntries();
	}

	const entries: BtwDisplayEntry[] = [{ kind: "system", text: "Starting /btw side conversation…" }];
	if (state.queuedMessages.length > 0) {
		entries.push({ kind: "status", text: `Queued ${state.queuedMessages.length} message${state.queuedMessages.length === 1 ? "" : "s"}…` });
	}
	return entries;
}

async function flushQueuedMessages(pi: ExtensionAPI, state: MainState, ctx: ExtensionCommandContext): Promise<void> {
	updateContextState(pi, state, ctx);

	if (state.flushPromise) {
		return state.flushPromise;
	}

	// flushQueuedMessages is awaited in fire-and-forget paths (the /btw command
	// handler's initial message flush and the overlay input submit). Any error
	// that propagates out of here becomes an unhandled promise rejection, so the
	// IIFE must catch and surface every failure via bridge.notify rather than
	// rethrowing.
	state.flushPromise = (async () => {
		try {
			const runtime = await ensureRuntime(pi, state, ctx);
			await runtime.syncModel(state.model, state.thinkingLevel);

			while (state.queuedMessages.length > 0) {
				const message = state.queuedMessages.shift()!;
				try {
					await runtime.sendMessage(message);
				} catch (error) {
					state.bridge.notify(`Failed to send /btw message: ${error instanceof Error ? error.message : String(error)}`, "error");
					break;
				}
			}
		} catch (error) {
			state.bridge.notify(`/btw startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	})().finally(() => {
		state.flushPromise = undefined;
	});

	return state.flushPromise;
}

async function ensureRuntime(pi: ExtensionAPI, state: MainState, ctx: ExtensionCommandContext): Promise<BtwSideSessionRuntime> {
	if (state.runtime) {
		return state.runtime;
	}
	if (state.bootPromise) {
		return state.bootPromise;
	}

	state.bridge.setWorkingMessage("Starting /btw…");
	state.bootPromise = (async () => {
		let sessionFile = state.sessionRef?.file;
		if (!sessionFile || !existsSync(sessionFile)) {
			sessionFile = await createSideSessionFile(ctx.cwd);
			state.sessionRef = createBtwSessionRef(sessionFile);
			pi.appendEntry(BTW_SESSION_REF_CUSTOM_TYPE, state.sessionRef);
		}

		const runtime = await BtwSideSessionRuntime.create({
			bridge: state.bridge,
			cwd: ctx.cwd,
			modelRegistry: ctx.modelRegistry,
			model: state.model,
			thinkingLevel: state.thinkingLevel,
			sessionFile,
			systemPromptProvider: () => state.systemPrompt,
			mainContextProvider: () => state.mainContext,
			communicationPermissionsProvider: () => ({
				allowFollowUpToMain: state.allowFollowUpToMain,
				allowSteerToMain: state.allowSteerToMain,
			}),
			sendFollowUpToMain: (message: string) => {
				pi.sendUserMessage(message, { deliverAs: "followUp" });
			},
			// Route the confirmation through the /btw overlay itself via the
			// bridge. The main session's UI confirm would otherwise render inside
			// the base layer (the pi editor container) and sit hidden behind the
			// /btw overlay, leaving the side-session tool execute hung on a
			// promise the user could never answer.
			confirmSteerToMain: (message: string) =>
				state.bridge.requestConfirmation(
					"Send /btw steer to main?",
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
