import { existsSync } from "node:fs";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { MainSessionTracker } from "./main-session-state.js";
import { attachOverlayBridge, BtwOverlayBridge, BtwOverlayComponent, type BtwDisplayEntry, type BtwOverlayView } from "./overlay.js";
import { createBtwSessionRef, readBtwSessionRef, BTW_SESSION_REF_CUSTOM_TYPE, type BtwSessionRef } from "./session-ref.js";
import { BtwSideSessionRuntime, createSideSessionFile } from "./side-session.js";

type MainState = {
	bridge: BtwOverlayBridge;
	mainSession: MainSessionTracker;
	sessionRef?: BtwSessionRef;
	runtime?: BtwSideSessionRuntime;
	bootPromise?: Promise<BtwSideSessionRuntime>;
	flushPromise?: Promise<void>;
	queuedMessages: string[];
	model?: Model<any>;
	thinkingLevel?: string;
	systemPrompt: string;
	themeProvider: () => ExtensionContext["ui"]["theme"];
};
export default function btwExtension(pi: ExtensionAPI): void {
	const state: MainState = {
		bridge: new BtwOverlayBridge(),
		mainSession: new MainSessionTracker(),
		queuedMessages: [],
		systemPrompt: "",
		themeProvider: () => {
			throw new Error("/btw theme requested before UI was available.");
		},
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
		state.mainSession.reset(formatModelLabel(ctx.model));
		updateContextState(pi, state, ctx);
		state.sessionRef = readBtwSessionRef(ctx.sessionManager.getBranch());
		state.bridge.reset();
	});

	pi.on("agent_start", async (_event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleAgentStart();
	});

	pi.on("agent_end", async (_event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleAgentEnd();
	});

	pi.on("message_start", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleMessageStart(event);
	});

	pi.on("message_update", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleMessageUpdate(event);
	});

	pi.on("message_end", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleMessageEnd(event);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleToolExecutionStart(event);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleToolExecutionEnd(event);
	});

	pi.on("model_select", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.model = event.model;
		state.mainSession.handleModelSelect(formatModelLabel(event.model));
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
		state.mainSession.reset(formatModelLabel(state.model));
		state.bridge.cancelPending();
	});
}

function updateContextState(pi: ExtensionAPI, state: MainState, ctx: ExtensionContext): void {
	state.model = ctx.model;
	state.thinkingLevel = pi.getThinkingLevel();
	state.systemPrompt = ctx.getSystemPrompt();
	state.themeProvider = () => ctx.ui.theme;
	state.mainSession.refreshFromContext(ctx, formatModelLabel(state.model));
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
		getModeLabel: () => state.runtime?.getModeLabel() ?? "read-only",
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

	state.flushPromise = (async () => {
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
