import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuthStorage, ModelRegistry, SessionManager, type SessionEntry } from "@mariozechner/pi-coding-agent";
import { TUI, type Component } from "@mariozechner/pi-tui";

type Terminal = {
	start(onInput: (data: string) => void, onResize: () => void): void;
	stop(): void;
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;
	write(data: string): void;
	readonly columns: number;
	readonly rows: number;
	readonly kittyProtocolActive: boolean;
	moveBy(lines: number): void;
	hideCursor(): void;
	showCursor(): void;
	clearLine(): void;
	clearFromCursor(): void;
	clearScreen(): void;
	setTitle(title: string): void;
};
import { JarvisOverlayBridge, JarvisOverlayComponent, attachOverlayBridge, cursorMarkerPresent, type JarvisOverlayView } from "../overlay.js";
import { buildMainSessionContext, DEFAULT_MAIN_SESSION_RECENT_LIMIT } from "../main-context.js";
import { MainSessionTracker } from "../main-session-state.js";
import { createJarvisSessionRef, readJarvisSessionRef, JARVIS_SESSION_REF_CUSTOM_TYPE } from "../session-ref.js";
import { JarvisSideSessionRuntime, createSideSessionFile } from "../side-session.js";
import jarvisExtension from "../index.js";

class FakeTerminal implements Terminal {
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _columns = 120;
	private _rows = 40;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	get columns(): number {
		return this._columns;
	}
	get rows(): number {
		return this._rows;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}

	emit(data: string): void {
		this.inputHandler?.(data);
	}

	resize(columns: number, rows: number): void {
		this._columns = columns;
		this._rows = rows;
		this.resizeHandler?.();
	}
}

class BaseComponent implements Component {
	public inputs: string[] = [];
	render(): string[] {
		return ["base"];
	}
	handleInput(data: string): void {
		this.inputs.push(data);
	}
	invalidate(): void {}
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

type TestOverlayViewState = {
	ready: boolean;
	streaming: boolean;
	mainStatus: string;
	mainModelLabel: string;
	mainFocusLabel: string;
	modelLabel: string;
	modelModeLabel: string;
	displayEntries: ReturnType<JarvisOverlayView["getDisplayEntries"]>;
	sentMessages: string[];
	toolsEnabled: boolean;
	followUpEnabled: boolean;
	steerEnabled: boolean;
};

function createTestOverlayView(overrides: Partial<Omit<TestOverlayViewState, "sentMessages">> = {}): {
	state: TestOverlayViewState;
	view: JarvisOverlayView;
} {
	const state: TestOverlayViewState = {
		ready: true,
		streaming: false,
		mainStatus: "idle",
		mainModelLabel: "openai/gpt-5.2",
		mainFocusLabel: "waiting for user input",
		modelLabel: "faux/test-model",
		modelModeLabel: "follow main",
		displayEntries: [{ kind: "assistant", text: "hello from /jarvis" }],
		sentMessages: [],
		toolsEnabled: false,
		followUpEnabled: false,
		steerEnabled: false,
		...overrides,
	};

	const view: JarvisOverlayView = {
		isReady: () => state.ready,
		isStreaming: () => state.streaming,
		getModelLabel: () => state.modelLabel,
		getModelModeLabel: () => state.modelModeLabel,
		getMainStatusLabel: () => state.mainStatus,
		getMainModelLabel: () => state.mainModelLabel,
		getMainFocusLabel: () => state.mainFocusLabel,
		isToolAccessEnabled: () => state.toolsEnabled,
		isFollowUpToMainEnabled: () => state.followUpEnabled,
		isSteerToMainEnabled: () => state.steerEnabled,
		toggleToolAccess: () => {
			state.toolsEnabled = !state.toolsEnabled;
		},
		toggleFollowUpToMain: () => {
			state.followUpEnabled = !state.followUpEnabled;
		},
		toggleSteerToMain: () => {
			state.steerEnabled = !state.steerEnabled;
		},
		getDisplayEntries: () => state.displayEntries,
		sendMessage: async (text: string) => {
			state.sentMessages.push(text);
		},
	};

	return { state, view };
}

function flushTicks(): Promise<void> {
	return new Promise((resolve) => process.nextTick(resolve));
}

async function testSessionRef(): Promise<void> {
	const ref = createJarvisSessionRef("/tmp/jarvis.jsonl");
	const loaded = readJarvisSessionRef([
		{ type: "custom", customType: "other", data: {} },
		{ type: "custom", customType: JARVIS_SESSION_REF_CUSTOM_TYPE, data: ref },
	]);
	assert.deepEqual(loaded, ref);
	assert.equal(readJarvisSessionRef([]), undefined);
}

async function testOverlayFocusAndEscRouting(): Promise<void> {
	const terminal = new FakeTerminal();
	const tui = new TUI(terminal);
	const base = new BaseComponent();
	const bridge = new JarvisOverlayBridge();
	const { view } = createTestOverlayView();
	let closed = false;

	const overlay = attachOverlayBridge(new JarvisOverlayComponent(tui, theme, bridge, view, () => {
		closed = true;
	}), bridge, tui);

	tui.addChild(base);
	tui.setFocus(base);
	tui.start();
	tui.showOverlay(overlay, { width: 80 });

	await flushTicks();
	const lines = overlay.render(80);
	assert.equal(cursorMarkerPresent(lines), true, "overlay input should be focused when opened");

	terminal.emit("\x1b");
	await flushTicks();

	assert.equal(closed, true, "ESC should close the overlay");
	assert.deepEqual(base.inputs, [], "ESC must not propagate into the underlying focused component");

	tui.stop();
}

async function testOverlayRenderDistinctness(): Promise<void> {
	const terminal = new FakeTerminal();
	const tui = new TUI(terminal);
	const bridge = new JarvisOverlayBridge();
	const { view } = createTestOverlayView({
		displayEntries: [
			{ kind: "user", text: "How are you Jarvis?" },
			{ kind: "assistant", text: "Operational." },
		],
	});
	const overlay = new JarvisOverlayComponent(tui, theme, bridge, view, () => {});
	const lines = overlay.render(80);
	assert.ok(lines.some((line) => line.includes("\x1b[48;2;24;28;36m")), "overlay should render its own shaded background");
	assert.ok(lines[0]?.includes("╭") && lines.at(-1)?.includes("╰"), "overlay should render a bordered floating window");
	assert.ok(lines.some((line) => line.includes("User:")), "user transcript entries should label the speaker as User:");
	assert.ok(lines.some((line) => line.includes("Jarvis:")), "assistant transcript entries should label the speaker as Jarvis:");
}

async function testOverlayAnimatedThinkingFallback(): Promise<void> {
	const terminal = new FakeTerminal();
	const tui = new TUI(terminal);
	const bridge = new JarvisOverlayBridge();
	bridge.setWorkingMessage("Thinking...");
	const { view } = createTestOverlayView({ streaming: true, displayEntries: [] });
	const overlay = new JarvisOverlayComponent(tui, theme, bridge, view, () => {});
	const lines = overlay.render(80);
	const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
	assert.ok(lines.some((line) => stripAnsi(line).includes("Thinking...")), "animated fallback should keep the Thinking... label visible");
	assert.ok(lines.some((line) => line.includes("◈")), "animated fallback should include the metallic thinking icon");
	overlay.dispose();
}

async function testOverlayForwardingToggleControls(): Promise<void> {
	const terminal = new FakeTerminal();
	const tui = new TUI(terminal);
	const bridge = new JarvisOverlayBridge();
	const { state, view } = createTestOverlayView({ mainStatus: "busy", mainFocusLabel: "editing side-session.ts" });
	const overlay = new JarvisOverlayComponent(tui, theme, bridge, view, () => {});
	overlay.focused = true;

	let lines = overlay.render(80);
	assert.ok(lines.some((line) => line.includes("Jarvis  Main busy")), "overlay header should show the Jarvis title and current main status");
	assert.ok(lines.some((line) => line.includes("Models: openai/gpt-5.2")), "overlay header should show the current main model label");
	assert.ok(lines.some((line) => line.includes("Focus: editing side-session.ts")), "overlay header should show the current main-session focus");
	assert.ok(lines.some((line) => line.includes("faux/test-model (follow main)")), "overlay header should show the active Jarvis model and mode");
	assert.ok(lines.some((line) => line.includes("Tools: off")), "overlay header should show the Tools toggle state");
	assert.ok(lines.some((line) => line.includes("Share: off")), "overlay header should show the Share toggle state");
	assert.ok(lines.some((line) => line.includes("Steer: off")), "overlay header should show the Steer toggle state");
	assert.equal(cursorMarkerPresent(lines), true, "message input should be focused by default");

	overlay.handleInput("\t");
	lines = overlay.render(80);
	assert.equal(cursorMarkerPresent(lines), false, "tab should move focus from the message input to the first toggle");
	assert.ok(lines.some((line) => line.includes("[Tools: off]")), "tab should focus the Tools toggle");

	overlay.handleInput(" ");
	assert.equal(state.toolsEnabled, true, "space should toggle the focused Tools control");
	assert.deepEqual(state.sentMessages, [], "toggle controls should not send a chat message");
	lines = overlay.render(80);
	assert.ok(lines.some((line) => line.includes("[Tools: on]")), "overlay should render the updated Tools state");

	overlay.handleInput("\t");
	lines = overlay.render(80);
	assert.ok(lines.some((line) => line.includes("[Share: off]")), "tab should move focus to the Share toggle");

	overlay.handleInput(" ");
	assert.equal(state.followUpEnabled, true, "space should toggle the focused Share control");
	lines = overlay.render(80);
	assert.ok(lines.some((line) => line.includes("[Share: on]")), "overlay should render the updated Share state");

	overlay.handleInput("\t");
	lines = overlay.render(80);
	assert.ok(lines.some((line) => line.includes("[Steer: off]")), "tab should move focus to the Steer toggle");

	overlay.handleInput("\r");
	assert.equal(state.steerEnabled, true, "enter should toggle the focused Steer control");
	lines = overlay.render(80);
	assert.ok(lines.some((line) => line.includes("[Steer: on]")), "overlay should render the updated Steer state");

	overlay.handleInput("\x1b[Z");
	lines = overlay.render(80);
	assert.ok(lines.some((line) => line.includes("[Share: on]")), "shift+tab should move focus backward");

	overlay.handleInput("\x1b[Z");
	lines = overlay.render(80);
	assert.ok(lines.some((line) => line.includes("[Tools: on]")), "shift+tab should move focus back to the Tools toggle");

	overlay.handleInput("\t");
	overlay.handleInput("\t");
	overlay.handleInput("\t");
	lines = overlay.render(80);
	assert.equal(cursorMarkerPresent(lines), true, "tab should wrap focus back to the message input");
}

async function testJarvisOverlayInputHistoryNavigatesUserMessages(): Promise<void> {
	const terminal = new FakeTerminal();
	const tui = new TUI(terminal);
	const bridge = new JarvisOverlayBridge();
	const { view } = createTestOverlayView({
		displayEntries: [
			{ kind: "system", text: "Starting..." },
			{ kind: "user", text: "first message" },
			{ kind: "assistant", text: "hi" },
			{ kind: "user", text: "second message" },
		],
	});
	const overlay = new JarvisOverlayComponent(tui, theme, bridge, view, () => {});
	overlay.focused = true;

	overlay.handleInput("D");
	overlay.handleInput("r");
	overlay.handleInput("a");
	overlay.handleInput("f");
	overlay.handleInput("t");
	
	// Up -> second message
	overlay.handleInput("\x1b[A");
	assert.equal((overlay as any).input.getValue(), "second message", "Up arrow should load the most recent user message");

	// Up -> first message
	overlay.handleInput("\x1b[A");
	assert.equal((overlay as any).input.getValue(), "first message", "Up arrow again should load the older user message");

	// Up -> clamped to first message
	overlay.handleInput("\x1b[A");
	assert.equal((overlay as any).input.getValue(), "first message", "Up arrow should clamp at the oldest user message");

	// Down -> second message
	overlay.handleInput("\x1b[B");
	assert.equal((overlay as any).input.getValue(), "second message", "Down arrow should navigate forward to the newer user message");

	// Down -> draft restored
	overlay.handleInput("\x1b[B");
	assert.equal((overlay as any).input.getValue(), "Draft", "Down arrow at the end should restore the original input draft");

	// Down -> clamped at draft
	overlay.handleInput("\x1b[B");
	assert.equal((overlay as any).input.getValue(), "Draft", "Down arrow should clamp at the draft");
}

async function testSideSessionPersistence(): Promise<void> {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-jarvis-test-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const sessionFile = await createSideSessionFile(cwd);
		const sessionManager = SessionManager.open(sessionFile, dirname(sessionFile));
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "restore me" }],
			timestamp: Date.now(),
		} as any);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "restored response" }],
			api: "test-api",
			provider: "test-provider",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as any);

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const bridge = new JarvisOverlayBridge();
		const runtime = await JarvisSideSessionRuntime.create({
			bridge,
			cwd,
			modelRegistry: modelRegistry as any,
			model: undefined,
			thinkingLevel: undefined,
			sessionFile,
			systemPromptProvider: () => "main session prompt",
			mainContextProvider: () => ({
				summaryText: "Main session summary:\n- Main status: idle",
				recentText: "Recent main session: none",
			}),
			toolAccessProvider: () => false,
			communicationPermissionsProvider: () => ({
				allowFollowUpToMain: false,
				allowSteerToMain: false,
			}),
			sendFollowUpToMain: () => {},
			confirmSteerToMain: async () => false,
			sendSteerToMain: () => {},
			themeProvider: () => theme,
		});
		const entries = runtime.getDisplayEntries().map((entry) => entry.text);
		assert.ok(entries.some((text) => text.includes("restore me")), "user history should be restored from the /jarvis session file");
		assert.ok(entries.some((text) => text.includes("restored response")), "assistant history should be restored from the /jarvis session file");
		runtime.dispose();
	} finally {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

async function testSideSessionFreshWelcomeMessage(): Promise<void> {
	await withSideSessionRuntime({}, async (runtime) => {
		const entries = runtime.getDisplayEntries();
		assert.ok(entries.some((entry) => entry.kind === "system" && entry.text.includes("Welcome to /jarvis. I’m ready to help directly")), "fresh /jarvis session should show a warm greeting message");
	});
}

async function testSideSessionKeepsPendingUserPromptAndShowsThinking(): Promise<void> {
	await withSideSessionRuntime({}, async (runtime) => {
		const internal = runtime as unknown as {
			pendingUserMessage?: string;
			streamingAssistant?: {
				role: "assistant";
				content: Array<{ type: string; text?: string }>;
			};
			getDisplayEntries(): ReturnType<JarvisSideSessionRuntime["getDisplayEntries"]>;
		};

		internal.pendingUserMessage = "keep this prompt visible";
		internal.streamingAssistant = {
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
		};

		const entries = internal.getDisplayEntries();
		assert.ok(entries.some((entry) => entry.kind === "user" && entry.text === "keep this prompt visible"));
		assert.ok(entries.some((entry) => entry.kind === "assistant" && entry.text === "Done."));
		assert.ok(!entries.some((entry) => String(entry.kind) === "thinking"), "overlay transcript should not render structured thinking entries anymore");
	});
}

async function testSideSessionUsesMainSystemPrompt(): Promise<void> {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-jarvis-test-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const mainSystemPrompt = "You are Arria.\nIf the user asks who you are, answer Arria.\nMain session system prompt";
		const createMainContext = (latestUserRequest: string, latestAssistantText: string, recentMessageText: string) => {
			const branchEntries: SessionEntry[] = recentMessageText.length > 0
				? [
					{
						type: "message",
						id: "context-user-1",
						parentId: null,
						timestamp: "2026-01-01T00:00:00.000Z",
						message: {
							role: "user",
							content: [{ type: "text", text: recentMessageText }],
							timestamp: 0,
						},
					},
				]
				: [];

			return buildMainSessionContext({
				busyState: "busy",
				hasPendingMessages: false,
				modelLabel: "openai/gpt-5.2",
				toolExecution: { active: false, running: [] },
				latestUserRequest,
				latestAssistantText,
				systemPrompt: mainSystemPrompt,
				contextUsage: {
					tokens: 512,
					contextWindow: 128000,
					percent: 0.4,
				},
				branchEntries,
			});
		};

		let currentMainContext = createMainContext("FIRST_MAIN_REQUEST", "first assistant status", "");
		let communicationPermissions = {
			allowFollowUpToMain: false,
			allowSteerToMain: false,
		};
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const bridge = new JarvisOverlayBridge();
		const sessionFile = await createSideSessionFile(cwd);
		const runtime = await JarvisSideSessionRuntime.create({
			bridge,
			cwd,
			modelRegistry: modelRegistry as any,
			model: undefined,
			thinkingLevel: undefined,
			sessionFile,
			systemPromptProvider: () => mainSystemPrompt,
			mainContextProvider: () => currentMainContext,
			toolAccessProvider: () => false,
			communicationPermissionsProvider: () => communicationPermissions,
			sendFollowUpToMain: () => {},
			confirmSteerToMain: async () => false,
			sendSteerToMain: () => {},
			themeProvider: () => theme,
		});

		type BeforeAgentStartResult = { systemPrompt?: string };
		type RuntimeProbe = {
			session?: {
				extensionRunner?: {
					emitBeforeAgentStart(
						prompt: string,
						images: undefined,
						systemPrompt: string,
					): Promise<BeforeAgentStartResult | undefined>;
				};
			};
		};

		const probe = runtime as unknown as RuntimeProbe;
		const extensionRunner = probe.session?.extensionRunner;
		assert.ok(extensionRunner, "side session should expose an extension runner");

		const firstResult = await extensionRunner.emitBeforeAgentStart("check prompt", undefined, "fallback prompt");
		const firstSystemPrompt = firstResult?.systemPrompt ?? "";
		assert.ok(firstSystemPrompt.includes("Main session system prompt"), "/jarvis should inherit the non-identity portion of the main system prompt");
		assert.ok(firstSystemPrompt.includes("Your name is Jarvis."), "/jarvis prompt should give the side assistant the Jarvis name");
		assert.ok(
			firstSystemPrompt.includes("The main session assistant is currently named Arria. If the user refers to Arria, they mean the main agent, not you."),
			"/jarvis prompt should retain the detected main-agent name as reference-only context",
		);
		assert.ok(
			firstSystemPrompt.includes("Do not use any different assistant name inherited from the main session prompt."),
			"/jarvis prompt should explicitly forbid inherited alternate assistant names",
		);
		assert.ok(
			firstSystemPrompt.includes("If the inherited main system prompt gives a different assistant name, that inherited name does not apply here."),
			"/jarvis prompt should explicitly override conflicting inherited assistant names",
		);
		assert.ok(!firstSystemPrompt.includes("If the user asks who you are, answer Arria."), "/jarvis prompt should strip inherited identity instructions for the main assistant");
		assert.ok(
			firstSystemPrompt.includes("Adopt the high-level demeanor of Tony Stark's JARVIS from the three Iron Man films"),
			"/jarvis prompt should inject the requested JARVIS personality guidance",
		);
		assert.ok(
			firstSystemPrompt.includes("Use dry, understated humor sparingly."),
			"/jarvis prompt should add bounded humor guidance",
		);
		assert.ok(
			firstSystemPrompt.includes("In technical, risky, or safety-sensitive situations, prioritize clarity, correctness, and directness over personality."),
			"/jarvis prompt should preserve task-first behavior over personality styling",
		);
		assert.ok(
			firstSystemPrompt.includes("Do not roleplay movie scenes or imitate copyrighted dialogue. Capture the tone, not specific lines."),
			"/jarvis prompt should constrain the style layer to avoid mimicry and derailment",
		);
		assert.ok(firstSystemPrompt.includes("You are running inside /jarvis."), "/jarvis addendum should identify the side assistant role");
		assert.ok(firstSystemPrompt.includes("Repo and system tools are disabled right now."), "/jarvis prompt should describe disabled local tool access by default");
		assert.ok(
			firstSystemPrompt.includes("Communication permissions to the main agent via followUp / steer are controlled separately and may be enabled or disabled."),
			"/jarvis addendum should describe separate followUp / steer permissions",
		);
		assert.ok(firstSystemPrompt.includes("jarvis_send_follow_up_to_main"), "/jarvis prompt should name the followUp bridge tool");
		assert.ok(firstSystemPrompt.includes("jarvis_send_steer_to_main"), "/jarvis prompt should name the steer bridge tool");
		assert.ok(
			firstSystemPrompt.includes("It is disabled right now; attempts are blocked."),
			"/jarvis prompt should describe disabled bridge permissions",
		);
		assert.ok(!firstSystemPrompt.includes("jarvis_request_write_access"), "/jarvis prompt should not reference the removed mutation approval tool");
		assert.ok(firstSystemPrompt.includes(currentMainContext.summaryText), "/jarvis prompt should inject the current main-session summary");
		assert.ok(firstSystemPrompt.includes(currentMainContext.recentText), "/jarvis prompt should inject the current recent main-session window");

		currentMainContext = createMainContext("SECOND_MAIN_REQUEST", "second assistant status", "SECOND_RECENT_WINDOW");
		communicationPermissions = {
			allowFollowUpToMain: true,
			allowSteerToMain: true,
		};
		const secondResult = await extensionRunner.emitBeforeAgentStart("check prompt again", undefined, "fallback prompt");
		const secondSystemPrompt = secondResult?.systemPrompt ?? "";
		assert.ok(secondSystemPrompt.includes(currentMainContext.summaryText), "/jarvis prompt should refresh the injected main-session summary for each turn");
		assert.ok(secondSystemPrompt.includes(currentMainContext.recentText), "/jarvis prompt should refresh the injected recent main-session window for each turn");
		assert.ok(!secondSystemPrompt.includes("FIRST_MAIN_REQUEST"), "/jarvis should not keep stale startup context in later turns");
		assert.ok(secondSystemPrompt.includes("SECOND_MAIN_REQUEST"), "/jarvis should inject the latest main-session request");
		assert.ok(secondSystemPrompt.includes("SECOND_RECENT_WINDOW"), "/jarvis should inject the latest recent main-session text");
		assert.ok(
			secondSystemPrompt.includes("It is enabled right now."),
			"/jarvis prompt should reflect enabled followUp forwarding",
		);
		assert.ok(
			secondSystemPrompt.includes("It is enabled right now, but every actual send still requires explicit user confirmation."),
			"/jarvis prompt should reflect enabled steer forwarding with confirmation gating",
		);

		runtime.dispose();
	} finally {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

async function testBuildMainSessionContext(): Promise<void> {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	const branchEntries: SessionEntry[] = [
		{
			type: "message",
			id: "user-0",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "pre-compaction chatter" }],
				timestamp: 0,
			},
		},
		{
			type: "compaction",
			id: "compaction-1",
			parentId: "user-0",
			timestamp: "2026-01-01T00:00:01.000Z",
			summary: "Older context",
			firstKeptEntryId: "assistant-1",
			tokensBefore: 512,
		},
		{
			type: "message",
			id: "assistant-1",
			parentId: "compaction-1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Checking the post-compaction state." }],
				api: "test-api",
				provider: "test-provider",
				model: "test-model",
				usage,
				stopReason: "stop",
				timestamp: 1,
			},
		},
		{
			type: "message",
			id: "user-2",
			parentId: "assistant-1",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "Need the latest /jarvis context." }],
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "assistant-3",
			parentId: "user-2",
			timestamp: "2026-01-01T00:00:04.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Reviewing index.ts" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "index.ts" } },
				],
				api: "test-api",
				provider: "test-provider",
				model: "test-model",
				usage,
				stopReason: "toolUse",
				timestamp: 3,
			},
		},
		{
			type: "message",
			id: "tool-result-4",
			parentId: "assistant-3",
			timestamp: "2026-01-01T00:00:05.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "index.ts contents" }],
				isError: false,
				timestamp: 4,
			},
		},
		{
			type: "custom_message",
			id: "custom-hidden",
			parentId: "tool-result-4",
			timestamp: "2026-01-01T00:00:06.000Z",
			customType: "jarvis.hidden",
			content: "hidden internal status",
			display: false,
		},
		{
			type: "custom_message",
			id: "custom-visible",
			parentId: "custom-hidden",
			timestamp: "2026-01-01T00:00:07.000Z",
			customType: "jarvis.visible",
			content: "Forward this summary later",
			display: true,
		},
		{
			type: "message",
			id: "bash-5",
			parentId: "custom-visible",
			timestamp: "2026-01-01T00:00:08.000Z",
			message: {
				role: "bashExecution",
				command: "npm run check",
				output: "lint clean",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 5,
			},
		},
		{
			type: "message",
			id: "user-6",
			parentId: "bash-5",
			timestamp: "2026-01-01T00:00:09.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "Investigate the /jarvis context window" }],
				timestamp: 6,
			},
		},
		{
			type: "message",
			id: "assistant-7",
			parentId: "user-6",
			timestamp: "2026-01-01T00:00:10.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Summarizing the main session state." }],
				api: "test-api",
				provider: "test-provider",
				model: "test-model",
				usage,
				stopReason: "stop",
				timestamp: 7,
			},
		},
		{
			type: "branch_summary",
			id: "branch-summary-8",
			parentId: "assistant-7",
			timestamp: "2026-01-01T00:00:11.000Z",
			fromId: "user-2",
			summary: "branched away to inspect an alternate fix",
		},
	];

	const snapshot = {
		busyState: "busy",
		hasPendingMessages: true,
		modelLabel: "openai/gpt-5.2",
		toolExecution: {
			active: true,
			running: [
				{ toolName: "read", args: { path: "index.ts" } },
				{ toolName: "mcp", args: { search: "main context" } },
			],
		},
		latestUserRequest: "Investigate the /jarvis context window",
		latestAssistantText: "Summarizing the main session state.",
		systemPrompt: "main system prompt",
		contextUsage: {
			tokens: 2048,
			contextWindow: 128000,
			percent: 1.6,
		},
		branchEntries,
	} satisfies Parameters<typeof buildMainSessionContext>[0];

	const context = buildMainSessionContext(snapshot);

	assert.equal(context.summary.mainStatus, "busy");
	assert.equal(context.summary.mainModelLabel, "openai/gpt-5.2");
	assert.equal(context.summary.currentToolActivity.active, true);
	assert.equal(context.summary.currentToolActivity.running.length, 2);
	assert.equal(context.summary.latestUserRequest, "Investigate the /jarvis context window");
	assert.equal(context.summary.latestAssistantText, "Summarizing the main session state.");
	assert.equal(context.summary.pendingMessages, true);
	assert.equal(context.summary.contextUsage?.tokens, 2048);
	assert.equal(context.recentEntries.length, DEFAULT_MAIN_SESSION_RECENT_LIMIT);
	assert.equal(context.recentEntries[0]?.text, "Reviewing index.ts");
	assert.ok(context.summaryText.includes("Main session summary:"));
	assert.ok(context.summaryText.includes("Current tool activity: read {\"path\":\"index.ts\"}, mcp search main context"));
	assert.ok(context.summaryText.includes("Pending messages: yes"));
	assert.ok(context.summaryText.includes("Context usage: 2048/128000 tokens (1.6%)"));
	assert.ok(!context.recentText.includes("pre-compaction chatter"), "recent window should skip entries before the latest compaction boundary");
	assert.ok(!context.recentText.includes("hidden internal status"), "recent window should skip hidden custom messages");
	assert.ok(context.recentText.includes("Branch summary: branched away to inspect an alternate fix"));
	assert.ok(context.recentText.includes("$ npm run check (ok) — lint clean"));
}

async function testOverlayInputSwallowedOnToggleFocus(): Promise<void> {
	const terminal = new FakeTerminal();
	const tui = new TUI(terminal);
	const bridge = new JarvisOverlayBridge();
	const { state, view } = createTestOverlayView();
	const overlay = new JarvisOverlayComponent(tui, theme, bridge, view, () => {});
	overlay.focused = true;

	overlay.handleInput("\t");
	let lines = overlay.render(80);
	assert.ok(lines.some((line) => line.includes("[Tools: off]")), "tab should focus the Tools toggle");

	overlay.handleInput("a");
	overlay.handleInput("b");
	overlay.handleInput("c");
	assert.equal(state.toolsEnabled, false, "text keys should not toggle the focused control");
	assert.deepEqual(state.sentMessages, [], "text keys must not be queued as messages while a toggle has focus");

	overlay.handleInput("\t");
	overlay.handleInput("\t");
	overlay.handleInput("\t");
	lines = overlay.render(80);
	assert.equal(cursorMarkerPresent(lines), true, "focus should wrap back to the message input");

	overlay.handleInput("\r");
	assert.deepEqual(state.sentMessages, [], "empty input should not submit a message after returning to the input field");
}

async function testHandleMessageStartMarksAssistantStreaming(): Promise<void> {
	const tracker = new MainSessionTracker();
	tracker.refreshFromContext({
		getSystemPrompt: () => "main prompt",
		getContextUsage: () => undefined,
		isIdle: () => false,
		hasPendingMessages: () => false,
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					id: "prior-assistant",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "PRIOR_PERSISTED_TEXT" }],
						api: "test-api",
						provider: "test-provider",
						model: "test-model",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 0,
					},
				},
			],
		},
	} as any, "openai/gpt-5.2");
	assert.equal(tracker.snapshot().latestAssistantText, "PRIOR_PERSISTED_TEXT");

	tracker.handleMessageStart({
		message: {
			role: "assistant",
			content: [{ type: "text", text: "IN_FLIGHT_TEXT" }],
		},
	});
	assert.equal(tracker.snapshot().latestAssistantText, "IN_FLIGHT_TEXT", "message_start should capture the in-flight assistant text");

	tracker.refreshFromContext({
		getSystemPrompt: () => "main prompt",
		getContextUsage: () => undefined,
		isIdle: () => false,
		hasPendingMessages: () => false,
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					id: "prior-assistant",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "PRIOR_PERSISTED_TEXT" }],
						api: "test-api",
						provider: "test-provider",
						model: "test-model",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 0,
					},
				},
			],
		},
	} as any, "openai/gpt-5.2");
	assert.equal(
		tracker.snapshot().latestAssistantText,
		"IN_FLIGHT_TEXT",
		"refreshFromContext during streaming must not overwrite the in-flight assistant text with the persisted prior message",
	);

	tracker.handleMessageEnd({
		message: {
			role: "assistant",
			content: [{ type: "text", text: "FINAL_ASSISTANT_TEXT" }],
		},
	});
	assert.equal(tracker.snapshot().latestAssistantText, "FINAL_ASSISTANT_TEXT", "message_end should record the final assistant text");
}

async function testToolOnlyAssistantTurnDoesNotReuseOlderAssistantText(): Promise<void> {
	const tracker = new MainSessionTracker();
	tracker.refreshFromContext({
		getSystemPrompt: () => "main prompt",
		getContextUsage: () => undefined,
		isIdle: () => false,
		hasPendingMessages: () => false,
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					id: "assistant-with-text",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "OLDER_TEXT" }],
						api: "test-api",
						provider: "test-provider",
						model: "test-model",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 0,
					},
				},
				{
					type: "message",
					id: "assistant-tool-only",
					parentId: "assistant-with-text",
					timestamp: "2026-01-01T00:00:01.000Z",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "index.ts" } }],
						api: "test-api",
						provider: "test-provider",
						model: "test-model",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: 1,
					},
				},
			],
		},
	} as any, "openai/gpt-5.2");

	const snapshot = tracker.snapshot();
	const context = buildMainSessionContext(snapshot);
	assert.equal(snapshot.latestAssistantText, undefined, "the latest assistant summary field must clear when the latest assistant turn is tool-only");
	assert.equal(context.summary.latestAssistantText, undefined, "the /jarvis main-session summary must not reuse older assistant text for a tool-only latest turn");
	assert.ok(context.summaryText.includes("Latest assistant text: none"), "the formatted main-session summary should report no assistant text for a tool-only latest turn");
	assert.ok(context.recentText.includes('read {"path":"index.ts"}'), "the recent main-session window should still include the current tool activity");
}

async function testPackageManifestDeclaresPiPeerDependencies(): Promise<void> {
	type PackageManifest = {
		peerDependencies?: Record<string, string>;
	};

	const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest;
	const peerDependencies = packageJson.peerDependencies ?? {};
	assert.equal(peerDependencies["@mariozechner/pi-ai"], "*", "package.json must declare @mariozechner/pi-ai as a peer dependency for published Pi packages");
	assert.equal(peerDependencies["@mariozechner/pi-coding-agent"], "*", "package.json must declare @mariozechner/pi-coding-agent as a peer dependency for published Pi packages");
	assert.equal(peerDependencies["@mariozechner/pi-tui"], "*", "package.json must declare @mariozechner/pi-tui as a peer dependency for published Pi packages");
}

type BridgeToolDefinition = {
	execute: (
		toolCallId: string,
		params: { message: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: undefined,
	) => Promise<{ content: Array<{ text: string }>; details: { status: string } }>;
};

type SideRuntimeToolProbe = {
	session?: {
		getAllTools(): Array<{ name: string }>;
		getActiveToolNames(): string[];
		getToolDefinition(name: string): BridgeToolDefinition | undefined;
	};
};

async function withSideSessionRuntime(
	overrides: {
		toolAccessEnabled?: boolean;
		communicationPermissions?: { allowFollowUpToMain: boolean; allowSteerToMain: boolean };
		sendFollowUpToMain?: (message: string) => void;
		confirmSteerToMain?: (message: string) => Promise<boolean>;
		sendSteerToMain?: (message: string) => void;
	},
	run: (runtime: JarvisSideSessionRuntime, probe: SideRuntimeToolProbe) => Promise<void>,
): Promise<void> {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-jarvis-test-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const bridge = new JarvisOverlayBridge();
		const sessionFile = await createSideSessionFile(cwd);
		let permissions = overrides.communicationPermissions ?? { allowFollowUpToMain: false, allowSteerToMain: false };
		const runtime = await JarvisSideSessionRuntime.create({
			bridge,
			cwd,
			modelRegistry: modelRegistry as any,
			model: undefined,
			thinkingLevel: undefined,
			sessionFile,
			systemPromptProvider: () => "main session prompt",
			mainContextProvider: () => ({
				summaryText: "Main session summary:\n- Main status: idle",
				recentText: "Recent main session: none",
			}),
			toolAccessProvider: () => overrides.toolAccessEnabled ?? false,
			communicationPermissionsProvider: () => permissions,
			sendFollowUpToMain: overrides.sendFollowUpToMain ?? (() => {}),
			confirmSteerToMain: overrides.confirmSteerToMain ?? (async () => false),
			sendSteerToMain: overrides.sendSteerToMain ?? (() => {}),
			themeProvider: () => theme,
		});
		try {
			const probe = runtime as unknown as SideRuntimeToolProbe;
			await run(runtime, probe);
		} finally {
			runtime.dispose();
		}
		// Re-run helper users may swap permissions via this object reference
		void permissions;
	} finally {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

type TestModel = ReturnType<ModelRegistry["getAvailable"]>[number];

type TestNotification = {
	message: string;
	type: "info" | "warning" | "error";
};

type TestExtensionCommandContext = {
	model: TestModel | undefined;
	modelRegistry: ModelRegistry;
	notifications: TestNotification[];
	ui: {
		theme: typeof theme;
		notify: (message: string, type?: "info" | "warning" | "error") => void;
		custom: (...args: unknown[]) => Promise<void>;
	};
	hasUI: boolean;
	cwd: string;
	sessionManager: {
		getBranch: () => SessionEntry[];
	};
	isIdle: () => boolean;
	signal: undefined;
	abort: () => void;
	hasPendingMessages: () => boolean;
	shutdown: () => void;
	getContextUsage: () => undefined;
	compact: () => void;
	getSystemPrompt: () => string;
	waitForIdle: () => Promise<void>;
	newSession: () => Promise<{ cancelled: boolean }>;
	fork: () => Promise<{ cancelled: boolean }>;
	navigateTree: () => Promise<{ cancelled: boolean }>;
	switchSession: () => Promise<{ cancelled: boolean }>;
	reload: () => Promise<void>;
};

class FakeExtensionAPI {
	private readonly commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }>();
	private readonly listeners = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void> | void>>();
	thinkingLevel: string | undefined = "high";

	registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> | void }): void {
		this.commands.set(name, definition);
	}

	on(eventName: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void): void {
		const handlers = this.listeners.get(eventName) ?? [];
		handlers.push(handler);
		this.listeners.set(eventName, handlers);
	}

	appendEntry(): void {}

	sendUserMessage(): void {}

	getThinkingLevel(): string | undefined {
		return this.thinkingLevel;
	}

	async runCommand(name: string, args: string, ctx: TestExtensionCommandContext): Promise<void> {
		const command = this.commands.get(name);
		assert.ok(command, `expected command ${name} to be registered`);
		await command.handler(args, ctx);
	}

	async emit(eventName: string, event: unknown, ctx: TestExtensionCommandContext): Promise<void> {
		for (const handler of this.listeners.get(eventName) ?? []) {
			await handler(event, ctx);
		}
	}
}

class FakeJarvisRuntime {
	syncModelCalls: Array<{ model: TestModel | undefined; thinkingLevel: string | undefined }> = [];
	toolAccessCalls: boolean[] = [];

	constructor(
		public currentModel: TestModel | undefined,
		public initialThinkingLevel: string | undefined,
	) {}

	isReady(): boolean {
		return true;
	}

	isStreaming(): boolean {
		return false;
	}

	getModelLabel(): string {
		return this.currentModel ? `${this.currentModel.provider}/${this.currentModel.id}` : "model unavailable";
	}

	getDisplayEntries(): ReturnType<JarvisOverlayView["getDisplayEntries"]> {
		return [];
	}

	setToolAccessEnabled(enabled: boolean): void {
		this.toolAccessCalls.push(enabled);
	}

	async sendMessage(): Promise<void> {}

	async syncModel(model: TestModel | undefined, thinkingLevel: string | undefined): Promise<void> {
		this.syncModelCalls.push({ model, thinkingLevel });
		this.currentModel = model;
	}

	dispose(): void {}
}

type JarvisExtensionHarness = {
	api: FakeExtensionAPI;
	ctx: TestExtensionCommandContext;
	mainModel: TestModel;
	pinnedModel: TestModel;
	nextMainModel: TestModel;
	getRuntime(): FakeJarvisRuntime | undefined;
};

function createTestExtensionCommandContext(
	cwd: string,
	modelRegistry: ModelRegistry,
	model: TestModel | undefined,
): TestExtensionCommandContext {
	const notifications: TestNotification[] = [];
	const branchEntries: SessionEntry[] = [];
	return {
		model,
		modelRegistry,
		notifications,
		ui: {
			theme,
			notify: (message, type) => {
				notifications.push({ message, type: type ?? "info" });
			},
			custom: async () => undefined,
		},
		hasUI: true,
		cwd,
		sessionManager: {
			getBranch: () => branchEntries,
		},
		isIdle: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "main session prompt",
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => {},
	};
}

async function waitForAsyncWork(): Promise<void> {
	await flushTicks();
	await new Promise<void>((resolve) => setImmediate(resolve));
	await flushTicks();
}

async function withJarvisExtensionHarness(run: (harness: JarvisExtensionHarness) => Promise<void>): Promise<void> {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-jarvis-test-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider("test-provider", {
		api: "openai",
		baseUrl: "https://example.com/v1",
		apiKey: "test-key",
		models: [
			{
				id: "main-alpha",
				name: "Main Alpha",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
			{
				id: "side-beta",
				name: "Side Beta",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
			{
				id: "next-gamma",
				name: "Next Gamma",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
	});
	modelRegistry.registerProvider("xai", {
		api: "openai",
		baseUrl: "https://api.x.ai/v1",
		apiKey: "xai-key",
		models: [
			{
				id: "grok-incompatible-multi-agent",
				name: "Grok Incompatible Multi Agent",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
			{
				id: "grok-standard",
				name: "Grok Standard",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
	});

	const mainModel = modelRegistry.find("test-provider", "main-alpha");
	const pinnedModel = modelRegistry.find("test-provider", "side-beta");
	const nextMainModel = modelRegistry.find("test-provider", "next-gamma");
	assert.ok(mainModel, "expected the harness main model to exist");
	assert.ok(pinnedModel, "expected the harness pinned model to exist");
	assert.ok(nextMainModel, "expected the harness next main model to exist");

	const api = new FakeExtensionAPI();
	const ctx = createTestExtensionCommandContext(cwd, modelRegistry, mainModel);
	let runtime: FakeJarvisRuntime | undefined;

	const originalCreate = JarvisSideSessionRuntime.create;
	const replacement: typeof JarvisSideSessionRuntime.create = async (options) => {
		runtime = new FakeJarvisRuntime(options.model as TestModel | undefined, options.thinkingLevel);
		return runtime as unknown as JarvisSideSessionRuntime;
	};
	(JarvisSideSessionRuntime as { create: typeof JarvisSideSessionRuntime.create }).create = replacement;

	try {
		jarvisExtension(api as unknown as Parameters<typeof jarvisExtension>[0]);
		await api.emit("session_start", {}, ctx);
		await run({
			api,
			ctx,
			mainModel,
			pinnedModel,
			nextMainModel,
			getRuntime: () => runtime,
		});
	} finally {
		(JarvisSideSessionRuntime as { create: typeof JarvisSideSessionRuntime.create }).create = originalCreate;
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

async function openJarvisRuntime(harness: JarvisExtensionHarness): Promise<FakeJarvisRuntime> {
	await harness.api.runCommand("jarvis", "", harness.ctx);
	await waitForAsyncWork();
	const runtime = harness.getRuntime();
	assert.ok(runtime, "/jarvis should boot a side-session runtime");
	return runtime;
}

async function testJarvisModelDefaultFollowMainBehavior(): Promise<void> {
	await withJarvisExtensionHarness(async (harness) => {
		const runtime = await openJarvisRuntime(harness);
		assert.equal(runtime.currentModel?.id, harness.mainModel.id, "/jarvis should start on the current main model by default");

		harness.ctx.model = harness.nextMainModel;
		await harness.api.emit("model_select", { model: harness.nextMainModel }, harness.ctx);

		assert.equal(
			runtime.currentModel?.id,
			harness.nextMainModel.id,
			"/jarvis should continue following main model_select events until explicitly pinned",
		);
		assert.deepEqual(
			runtime.syncModelCalls.map((call) => call.model?.id),
			[harness.nextMainModel.id],
			"default follow-main mode should sync the /jarvis runtime when the main model changes",
		);
	});
}

async function testXaiFollowMainForcesThinkingOff(): Promise<void> {
	await withJarvisExtensionHarness(async (harness) => {
		const runtime = await openJarvisRuntime(harness);
		const xaiModel = harness.ctx.modelRegistry.find("xai", "grok-standard");
		assert.ok(xaiModel, "expected the harness xai model to exist");

		harness.ctx.model = xaiModel;
		await harness.api.emit("model_select", { model: xaiModel }, harness.ctx);

		assert.deepEqual(
			runtime.syncModelCalls.at(-1),
			{ model: xaiModel, thinkingLevel: "off" },
			"xAI models should force /jarvis thinking off even in follow-main mode",
		);
	});
}

async function testJarvisModelOpensModelMenuWhenNoArgs(): Promise<void> {
	await withJarvisExtensionHarness(async (harness) => {
		(harness.ctx.ui as any).custom = async () => harness.pinnedModel;
		await harness.api.runCommand("jarvis-model", "", harness.ctx);

		const runtime = await openJarvisRuntime(harness);
		assert.equal(
			runtime.currentModel?.id,
			harness.pinnedModel.id,
			"the /jarvis model selected from the menu should be used when the side runtime starts later",
		);
		assert.ok(
			harness.ctx.notifications.some((notification) =>
				notification.message.includes(`Pinned /jarvis to ${harness.pinnedModel.provider}/${harness.pinnedModel.id}`),
			),
			"/jarvis-model menu selection should report the pinned /jarvis model",
		);
		assert.equal(
			harness.ctx.model?.id,
			harness.mainModel.id,
			"/jarvis-model menu selection must not mutate the main session model state",
		);
	});
}

async function testJarvisModelOverrideAndStateSeparation(): Promise<void> {
	await withJarvisExtensionHarness(async (harness) => {
		await harness.api.runCommand("jarvis-model", "side-beta", harness.ctx);
		assert.equal(
			harness.ctx.model?.id,
			harness.mainModel.id,
			"/jarvis-model must not mutate the main session model state",
		);

		const runtime = await openJarvisRuntime(harness);
		assert.equal(
			runtime.currentModel?.id,
			harness.pinnedModel.id,
			"a pinned /jarvis model should be used when the side runtime starts later",
		);
		assert.ok(
			harness.ctx.notifications.some((notification) =>
				notification.message.includes(`Pinned /jarvis to ${harness.pinnedModel.provider}/${harness.pinnedModel.id}`),
			),
			"/jarvis-model should report the pinned /jarvis model without changing the main model",
		);
	});
}

async function testPinnedJarvisModelNotClobberedByMainModelSelect(): Promise<void> {
	await withJarvisExtensionHarness(async (harness) => {
		await harness.api.runCommand("jarvis-model", "side-beta", harness.ctx);
		const runtime = await openJarvisRuntime(harness);
		assert.equal(runtime.syncModelCalls.length, 0, "pinning before /jarvis starts should not require a live runtime sync");

		harness.ctx.model = harness.nextMainModel;
		await harness.api.emit("model_select", { model: harness.nextMainModel }, harness.ctx);
		assert.equal(
			runtime.currentModel?.id,
			harness.pinnedModel.id,
			"main model_select must not clobber a pinned /jarvis model",
		);
		assert.equal(runtime.syncModelCalls.length, 0, "no /jarvis runtime sync should happen while the /jarvis model is pinned");
	});
}

async function testJarvisPinnedModelResetsThinkingLevelToOffForLiveRuntime(): Promise<void> {
	await withJarvisExtensionHarness(async (harness) => {
		const runtime = await openJarvisRuntime(harness);
		await harness.api.runCommand("jarvis-model", "side-beta", harness.ctx);
		assert.deepEqual(
			runtime.syncModelCalls.at(-1),
			{ model: harness.pinnedModel, thinkingLevel: "off" },
			"pinning a /jarvis model while the runtime is live should reset its local thinking level to off",
		);
	});
}

async function testJarvisOverlayToolToggleSyncsRuntime(): Promise<void> {
	await withJarvisExtensionHarness(async (harness) => {
		let capturedComponent: any;
		const originalCustom = harness.ctx.ui.custom;
		(harness.ctx.ui as any).custom = async (fn: any, opts: any) => {
			capturedComponent = fn({ requestRender: () => {}, terminal: { rows: 40 } }, harness.ctx.ui.theme, {}, () => {});
			return originalCustom.call(harness.ctx.ui, fn, opts);
		};

		const runtime = await openJarvisRuntime(harness);
		assert.ok(capturedComponent, "should capture overlay component");
		capturedComponent.handleInput("\t");
		capturedComponent.handleInput(" ");
		assert.deepEqual(runtime.toolAccessCalls, [true], "toggling Tools in the overlay should update the live /jarvis runtime");
	});
}

async function testJarvisModelIncompatibleGuardBlocksTogglesAndShowsWarning(): Promise<void> {
	await withJarvisExtensionHarness(async (harness) => {
		let capturedComponent: any;
		const originalCustom = harness.ctx.ui.custom;
		(harness.ctx.ui as any).custom = async (fn: any, opts: any) => {
			capturedComponent = fn({ requestRender: () => {}, terminal: { rows: 40 } }, harness.ctx.ui.theme, {}, () => {});
			return originalCustom.call(harness.ctx.ui, fn, opts);
		};

		await harness.api.runCommand("jarvis", "", harness.ctx);
		await waitForAsyncWork();

		assert.ok(capturedComponent, "should capture overlay component");

		// It's a JarvisOverlayComponent. Its `view` property is private, but we can still move focus to Share and toggle it.
		// The default focus is "input".
		capturedComponent.handleInput("\t"); // focus Tools
		capturedComponent.handleInput("\t"); // focus Share
		capturedComponent.handleInput(" "); // toggle it ON

		// Now switch model to incompatible
		harness.ctx.model = harness.ctx.modelRegistry.find("xai", "grok-incompatible-multi-agent");
		await harness.api.emit("model_select", { model: harness.ctx.model }, harness.ctx);

		const lines = capturedComponent.render(80) as string[];
		assert.ok(
			lines.some((line) => line.includes("Relay disabled:")),
			"/jarvis should notify when an incompatible main model disables the bridge tools",
		);
		assert.ok(
			lines.some((line) => line.includes("Disabled Follow-up/Steer:")),
			"/jarvis should use polished Follow-up casing in compatibility warnings",
		);
	});
}

async function testJarvisModelReturnToFollowMainBehavior(): Promise<void> {
	await withJarvisExtensionHarness(async (harness) => {
		await harness.api.runCommand("jarvis-model", "side-beta", harness.ctx);
		const runtime = await openJarvisRuntime(harness);

		harness.ctx.model = harness.nextMainModel;
		await harness.api.emit("model_select", { model: harness.nextMainModel }, harness.ctx);
		assert.equal(runtime.currentModel?.id, harness.pinnedModel.id, "the pinned /jarvis model should remain active before follow-main is restored");

		await harness.api.runCommand("jarvis-model", "follow-main", harness.ctx);
		assert.equal(
			runtime.currentModel?.id,
			harness.nextMainModel.id,
			"follow-main should immediately resync /jarvis to the current main model",
		);

		harness.ctx.model = harness.mainModel;
		await harness.api.emit("model_select", { model: harness.mainModel }, harness.ctx);
		assert.equal(
			runtime.currentModel?.id,
			harness.mainModel.id,
			"after follow-main is restored, later main model changes should sync /jarvis again",
		);
		assert.deepEqual(
			runtime.syncModelCalls.map((call) => call.model?.id),
			[harness.nextMainModel.id, harness.mainModel.id],
			"only the explicit follow-main reset and later main model_select should sync the runtime after pinning",
		);
	});
}
async function testSideSessionToolWhitelist(): Promise<void> {
	await withSideSessionRuntime({}, async (_runtime, probe) => {
		assert.ok(probe.session, "side session runtime should expose the underlying session");
		const activeToolNames: string[] = probe.session!.getActiveToolNames().slice().sort();
		assert.deepEqual(
			activeToolNames,
			[],
			"/jarvis should not expose followUp/steer bridge tools to the LLM while forwarding permissions are OFF",
		);
		const forbiddenTools: string[] = ["read", "write", "edit", "bash", "grep", "find", "ls"];
		for (const forbidden of forbiddenTools) {
			assert.ok(
				!activeToolNames.some((toolName) => toolName === forbidden),
				`/jarvis side session must not expose the built-in ${forbidden} tool to the LLM`,
			);
		}
	});
}

async function testSideSessionLocalToolsActivateWhenPermitted(): Promise<void> {
	await withSideSessionRuntime({ toolAccessEnabled: true }, async (_runtime, probe) => {
		assert.ok(probe.session, "side session runtime should expose the underlying session");
		const activeToolNames: string[] = probe.session!.getActiveToolNames().slice().sort();
		for (const toolName of ["read", "bash", "edit", "write"]) {
			assert.ok(activeToolNames.includes(toolName), `/jarvis should expose ${toolName} when local tool access is enabled`);
		}
	});
}

async function testSideSessionBridgeToolsActivateWhenPermitted(): Promise<void> {
	await withSideSessionRuntime(
		{ communicationPermissions: { allowFollowUpToMain: true, allowSteerToMain: true } },
		async (_runtime, probe) => {
			assert.ok(probe.session, "side session runtime should expose the underlying session");
			const activeToolNames: string[] = probe.session!.getActiveToolNames().slice().sort();
			assert.deepEqual(
				activeToolNames,
				["jarvis_send_follow_up_to_main", "jarvis_send_steer_to_main"],
				"/jarvis should expose the bridge tools only when forwarding permissions are enabled",
			);
		},
	);
}

async function testFollowUpToolPermissionGating(): Promise<void> {
	let permissionsState = { allowFollowUpToMain: false, allowSteerToMain: false };
	let sentFollowUp: string | undefined;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-jarvis-test-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const bridge = new JarvisOverlayBridge();
		const sessionFile = await createSideSessionFile(cwd);
		const runtime = await JarvisSideSessionRuntime.create({
			bridge,
			cwd,
			modelRegistry: modelRegistry as any,
			model: undefined,
			thinkingLevel: undefined,
			sessionFile,
			systemPromptProvider: () => "main session prompt",
			mainContextProvider: () => ({
				summaryText: "Main session summary:\n- Main status: idle",
				recentText: "Recent main session: none",
			}),
			toolAccessProvider: () => false,
			communicationPermissionsProvider: () => permissionsState,
			sendFollowUpToMain: (message) => {
				sentFollowUp = message;
			},
			confirmSteerToMain: async () => false,
			sendSteerToMain: () => {},
			themeProvider: () => theme,
		});

		try {
			const probe = runtime as unknown as SideRuntimeToolProbe;
			assert.ok(probe.session, "side session runtime should expose the underlying session");
			const followUp = probe.session!.getToolDefinition("jarvis_send_follow_up_to_main");
			assert.ok(followUp, "followUp bridge tool should be registered on the side session");

			const blockedByPermission = await followUp!.execute("call-1", { message: "please poke main" }, undefined, undefined, undefined);
			assert.equal(blockedByPermission.details.status, "blocked", "followUp must be blocked when permission is OFF");
			assert.equal(sentFollowUp, undefined, "followUp callback must not fire while permission is OFF");

			const blockedByEmpty = await followUp!.execute("call-2", { message: "   " }, undefined, undefined, undefined);
			assert.equal(blockedByEmpty.details.status, "blocked", "followUp must reject empty/whitespace messages");
			assert.equal(sentFollowUp, undefined, "followUp callback must not fire on empty message");

			permissionsState = { allowFollowUpToMain: true, allowSteerToMain: false };
			const sent = await followUp!.execute("call-3", { message: "  hello main  " }, undefined, undefined, undefined);
			assert.equal(sent.details.status, "sent", "followUp must be delivered when permission is ON");
			assert.equal(sentFollowUp, "hello main", "followUp callback must be invoked with the trimmed message");
		} finally {
			runtime.dispose();
		}
	} finally {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

async function testSteerToolPermissionAndConfirmGating(): Promise<void> {
	let permissionsState = { allowFollowUpToMain: false, allowSteerToMain: false };
	let confirmCalls = 0;
	let confirmAnswer = false;
	let sentSteer: string | undefined;

	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-jarvis-test-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const bridge = new JarvisOverlayBridge();
		const sessionFile = await createSideSessionFile(cwd);
		const runtime = await JarvisSideSessionRuntime.create({
			bridge,
			cwd,
			modelRegistry: modelRegistry as any,
			model: undefined,
			thinkingLevel: undefined,
			sessionFile,
			systemPromptProvider: () => "main session prompt",
			mainContextProvider: () => ({
				summaryText: "Main session summary:\n- Main status: idle",
				recentText: "Recent main session: none",
			}),
			toolAccessProvider: () => false,
			communicationPermissionsProvider: () => permissionsState,
			sendFollowUpToMain: () => {},
			confirmSteerToMain: async () => {
				confirmCalls += 1;
				return confirmAnswer;
			},
			sendSteerToMain: (message) => {
				sentSteer = message;
			},
			themeProvider: () => theme,
		});

		try {
			const probe = runtime as unknown as SideRuntimeToolProbe;
			assert.ok(probe.session, "side session runtime should expose the underlying session");
			const steer = probe.session!.getToolDefinition("jarvis_send_steer_to_main");
			assert.ok(steer, "steer bridge tool should be registered on the side session");

			const blockedByPermission = await steer!.execute("call-1", { message: "steer main" }, undefined, undefined, undefined);
			assert.equal(blockedByPermission.details.status, "blocked", "steer must be blocked when permission is OFF");
			assert.equal(confirmCalls, 0, "steer must not request confirmation while permission is OFF");
			assert.equal(sentSteer, undefined, "steer callback must not fire while permission is OFF");

			permissionsState = { allowFollowUpToMain: false, allowSteerToMain: true };

			const blockedByEmpty = await steer!.execute("call-2", { message: "   " }, undefined, undefined, undefined);
			assert.equal(blockedByEmpty.details.status, "blocked", "steer must reject empty/whitespace messages");
			assert.equal(confirmCalls, 0, "steer must not request confirmation on an empty message");

			confirmAnswer = false;
			const cancelled = await steer!.execute("call-3", { message: "refocus on tests" }, undefined, undefined, undefined);
			assert.equal(cancelled.details.status, "cancelled", "steer must be cancelled when confirmation is denied");
			assert.equal(confirmCalls, 1, "steer must request confirmation when permission is ON");
			assert.equal(sentSteer, undefined, "steer callback must not fire when confirmation is denied");

			confirmAnswer = true;
			const sent = await steer!.execute("call-4", { message: "  refocus on tests  " }, undefined, undefined, undefined);
			assert.equal(sent.details.status, "sent", "steer must be delivered when confirmation is granted");
			assert.equal(confirmCalls, 2, "steer must request confirmation for every send attempt");
			assert.equal(sentSteer, "refocus on tests", "steer callback must be invoked with the trimmed message");
		} finally {
			runtime.dispose();
		}
	} finally {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

async function testBridgeConfirmationPrimitive(): Promise<void> {
	const bridge = new JarvisOverlayBridge();
	assert.equal(bridge.hasPendingConfirmation(), false);
	assert.equal(bridge.getPendingConfirmation(), undefined);

	const detachedPromise = bridge.requestConfirmation("title", "message");
	assert.equal(bridge.hasPendingConfirmation(), true);
	assert.deepEqual(bridge.getPendingConfirmation(), { title: "title", message: "message" });
	bridge.resolveConfirmation(true);
	assert.equal(await detachedPromise, true);
	assert.equal(bridge.hasPendingConfirmation(), false);

	let renderCount = 0;
	bridge.attach(() => {
		renderCount += 1;
	});
	renderCount = 0;
	const falsePromise = bridge.requestConfirmation("t", "m");
	assert.ok(renderCount > 0, "requestConfirmation must request a render when attached");
	renderCount = 0;
	bridge.resolveConfirmation(false);
	assert.equal(await falsePromise, false);
	assert.ok(renderCount > 0, "resolveConfirmation must request a render when attached");

	const survivesDetach = bridge.requestConfirmation("t2", "m2");
	bridge.detach();
	assert.equal(bridge.hasPendingConfirmation(), true, "detach must not cancel pending confirmation");
	bridge.attach(() => {});
	bridge.resolveConfirmation(true);
	assert.equal(await survivesDetach, true);

	const resetPromise = bridge.requestConfirmation("t3", "m3");
	bridge.reset();
	assert.equal(await resetPromise, false);
	assert.equal(bridge.hasPendingConfirmation(), false);

	const older = bridge.requestConfirmation("older", "o");
	const newer = bridge.requestConfirmation("newer", "n");
	assert.equal(await older, false, "older confirmation must resolve false when superseded");
	assert.deepEqual(bridge.getPendingConfirmation(), { title: "newer", message: "n" });
	bridge.resolveConfirmation(true);
	assert.equal(await newer, true);

	bridge.resolveConfirmation(true);
	bridge.resolveConfirmation(false);
	assert.equal(bridge.hasPendingConfirmation(), false);
}

async function testOverlayConfirmationRenderingAndKeys(): Promise<void> {
	const terminal = new FakeTerminal();
	const tui = new TUI(terminal);
	const bridge = new JarvisOverlayBridge();
	const { state, view } = createTestOverlayView();
	let closed = false;
	const overlay = new JarvisOverlayComponent(tui, theme, bridge, view, () => {
		closed = true;
	});
	overlay.focused = true;
	bridge.attach(() => tui.requestRender());

	let lines = overlay.render(80);
	assert.equal(cursorMarkerPresent(lines), true, "input cursor should be visible before any confirmation");

	const confirmPromise = bridge.requestConfirmation(
		"Send /jarvis steer to main?",
		"This will steer the main agent with:\n\nfocus on edge cases",
	);
	lines = overlay.render(80);
	assert.ok(
		lines.some((line) => line.includes("Send /jarvis steer to main?")),
		"overlay should render the confirmation title inside the floating overlay",
	);
	assert.ok(
		lines.some((line) => line.includes("focus on edge cases")),
		"overlay should render the confirmation message body",
	);
	assert.ok(
		lines.some((line) => line.includes("Press Y to confirm, N or Esc to cancel.")),
		"overlay should display the confirmation hint",
	);
	assert.ok(
		lines.some((line) => line.includes("Y confirm")),
		"footer should advertise the confirmation hotkeys",
	);
	assert.equal(cursorMarkerPresent(lines), false, "input cursor must be hidden while a confirmation is pending");

	// Text keys are swallowed and must not flip toggles or enqueue input.
	overlay.handleInput("a");
	overlay.handleInput("b");
	overlay.handleInput("\t");
	overlay.handleInput("\x1b[Z");
	overlay.handleInput("\r");
	assert.equal(bridge.hasPendingConfirmation(), true, "non-confirmation keys must be swallowed");
	assert.equal(state.followUpEnabled, false, "Tab must not cycle focus while a confirmation is pending");
	assert.equal(state.steerEnabled, false, "Enter must not toggle anything while a confirmation is pending");
	assert.deepEqual(state.sentMessages, [], "no messages may be submitted while a confirmation is pending");

	// Esc during confirmation cancels only the confirmation, not the overlay.
	overlay.handleInput("\x1b");
	assert.equal(await confirmPromise, false, "Esc must cancel the confirmation");
	assert.equal(closed, false, "Esc during confirmation must not close the overlay");
	assert.equal(bridge.hasPendingConfirmation(), false);

	// After resolution, the input is restored and Esc closes the overlay again.
	lines = overlay.render(80);
	assert.equal(cursorMarkerPresent(lines), true, "input cursor must return after the confirmation resolves");

	// 'Y' accepts, lowercase 'n' cancels, lowercase 'y' accepts.
	for (const [key, expected] of [
		["Y", true],
		["y", true],
		["N", false],
		["n", false],
	] as const) {
		const promise = bridge.requestConfirmation("title", "body");
		overlay.handleInput(key);
		assert.equal(await promise, expected, `key '${key}' should resolve the confirmation to ${expected}`);
	}

	// Finally, make sure Esc still closes the overlay after the confirmation
	// is gone.
	overlay.handleInput("\x1b");
	assert.equal(closed, true, "Esc must close the overlay once no confirmation is pending");
}

async function testSteerConfirmationRoutedThroughBridge(): Promise<void> {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-jarvis-test-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const bridge = new JarvisOverlayBridge();
		bridge.attach(() => {});
		const sessionFile = await createSideSessionFile(cwd);
		const permissionsState = { allowFollowUpToMain: false, allowSteerToMain: true };
		let sentSteer: string | undefined;
		const runtime = await JarvisSideSessionRuntime.create({
			bridge,
			cwd,
			modelRegistry: modelRegistry as any,
			model: undefined,
			thinkingLevel: undefined,
			sessionFile,
			systemPromptProvider: () => "main session prompt",
			mainContextProvider: () => ({
				summaryText: "Main session summary:\n- Main status: idle",
				recentText: "Recent main session: none",
			}),
			toolAccessProvider: () => false,
			communicationPermissionsProvider: () => permissionsState,
			sendFollowUpToMain: () => {},
			confirmSteerToMain: (message: string) =>
				bridge.requestConfirmation(
					"Send /jarvis steer to main?",
					`This will steer the main agent with:\n\n${message}`,
				),
			sendSteerToMain: (message) => {
				sentSteer = message;
			},
			themeProvider: () => theme,
		});

		try {
			const probe = runtime as unknown as SideRuntimeToolProbe;
			assert.ok(probe.session, "side session runtime should expose the underlying session");
			const steer = probe.session!.getToolDefinition("jarvis_send_steer_to_main");
			assert.ok(steer, "steer bridge tool should be registered on the side session");

			// ACCEPT path: execute blocks on bridge confirmation, user answers Yes.
			const execAccept = steer!.execute("call-1", { message: "focus on errors" }, undefined, undefined, undefined);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(bridge.hasPendingConfirmation(), true, "steer execute must request bridge confirmation");
			assert.deepEqual(
				bridge.getPendingConfirmation(),
				{
					title: "Send /jarvis steer to main?",
					message: "This will steer the main agent with:\n\nfocus on errors",
				},
				"bridge confirmation must carry the steer title and message body",
			);
			bridge.resolveConfirmation(true);
			const acceptResult = await execAccept;
			assert.equal(acceptResult.details.status, "sent");
			assert.equal(sentSteer, "focus on errors");

			// CANCEL path: user answers No.
			sentSteer = undefined;
			const execCancel = steer!.execute("call-2", { message: "stop" }, undefined, undefined, undefined);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(bridge.hasPendingConfirmation(), true);
			bridge.resolveConfirmation(false);
			const cancelResult = await execCancel;
			assert.equal(cancelResult.details.status, "cancelled");
			assert.equal(sentSteer, undefined);

			// RESET path: bridge.reset() during a pending confirmation must
			// unblock the tool as cancelled so session_shutdown cannot hang.
			const execReset = steer!.execute("call-3", { message: "teardown" }, undefined, undefined, undefined);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(bridge.hasPendingConfirmation(), true);
			bridge.reset();
			const resetResult = await execReset;
			assert.equal(resetResult.details.status, "cancelled", "bridge.reset() must unblock the pending steer as cancelled");
			assert.equal(sentSteer, undefined);
		} finally {
			runtime.dispose();
		}
	} finally {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

async function testMainSessionTrackerToolExecutionKeying(): Promise<void> {
	const tracker = new MainSessionTracker();

	// Matching toolCallIds: start+end by id should clean up correctly.
	tracker.handleToolExecutionStart({ toolCallId: "call-read-1", toolName: "read", args: { path: "a.ts" } });
	tracker.handleToolExecutionStart({ toolCallId: "call-bash-1", toolName: "bash", args: { command: "ls" } });
	assert.equal(tracker.snapshot().toolExecution.running.length, 2);
	tracker.handleToolExecutionEnd({ toolCallId: "call-read-1", toolName: "read" });
	tracker.handleToolExecutionEnd({ toolCallId: "call-bash-1", toolName: "bash" });
	assert.equal(tracker.snapshot().toolExecution.active, false);
	assert.equal(tracker.snapshot().toolExecution.running.length, 0);

	// Start without a toolCallId must still be cleared by an end event that
	// has only a toolName. Previously the synthetic `tool:${toolName}` key set
	// by handleToolExecutionStart could be missed by handleToolExecutionEnd if
	// the end carried a toolCallId instead of a toolName.
	tracker.handleToolExecutionStart({ toolName: "grep", args: { pattern: "foo" } });
	assert.equal(tracker.snapshot().toolExecution.running.length, 1);
	tracker.handleToolExecutionEnd({ toolName: "grep" });
	assert.equal(
		tracker.snapshot().toolExecution.running.length,
		0,
		"tool execution end by toolName must clear a synthetic `tool:${toolName}` entry",
	);

	// End by toolCallId should still clean up a start that had no toolCallId
	// if the toolName matches.
	tracker.handleToolExecutionStart({ toolName: "find", args: { path: "." } });
	assert.equal(tracker.snapshot().toolExecution.running.length, 1);
	tracker.handleToolExecutionEnd({ toolCallId: "late-call-id", toolName: "find" });
	assert.equal(
		tracker.snapshot().toolExecution.running.length,
		0,
		"tool execution end must fall back to the synthetic key when the toolCallId does not match any stored entry",
	);
}

async function main(): Promise<void> {
	await testSessionRef();
	await testOverlayFocusAndEscRouting();
	await testOverlayRenderDistinctness();
	await testOverlayAnimatedThinkingFallback();
	await testOverlayForwardingToggleControls();
	await testOverlayInputSwallowedOnToggleFocus();
	await testJarvisOverlayInputHistoryNavigatesUserMessages();
	await testBridgeConfirmationPrimitive();
	await testOverlayConfirmationRenderingAndKeys();
	await testHandleMessageStartMarksAssistantStreaming();
	await testToolOnlyAssistantTurnDoesNotReuseOlderAssistantText();
	await testMainSessionTrackerToolExecutionKeying();
	await testJarvisModelDefaultFollowMainBehavior();
	await testXaiFollowMainForcesThinkingOff();
	await testJarvisModelOpensModelMenuWhenNoArgs();
	await testJarvisModelOverrideAndStateSeparation();
	await testPinnedJarvisModelNotClobberedByMainModelSelect();
	await testJarvisPinnedModelResetsThinkingLevelToOffForLiveRuntime();
	await testJarvisOverlayToolToggleSyncsRuntime();
	await testJarvisModelIncompatibleGuardBlocksTogglesAndShowsWarning();
	await testJarvisModelReturnToFollowMainBehavior();
	await testSideSessionPersistence();
	await testSideSessionFreshWelcomeMessage();
	await testSideSessionKeepsPendingUserPromptAndShowsThinking();
	await testSideSessionUsesMainSystemPrompt();
	await testSideSessionToolWhitelist();
	await testSideSessionLocalToolsActivateWhenPermitted();
	await testSideSessionBridgeToolsActivateWhenPermitted();
	await testFollowUpToolPermissionGating();
	await testSteerToolPermissionAndConfirmGating();
	await testSteerConfirmationRoutedThroughBridge();
	await testBuildMainSessionContext();
	await testPackageManifestDeclaresPiPeerDependencies();
	console.log("jarvis tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
