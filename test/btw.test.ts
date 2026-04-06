import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
import { BtwOverlayBridge, BtwOverlayComponent, attachOverlayBridge, cursorMarkerPresent, type BtwOverlayView } from "../overlay.js";
import { buildMainSessionContext, DEFAULT_MAIN_SESSION_RECENT_LIMIT } from "../main-context.js";
import { createBtwSessionRef, readBtwSessionRef, BTW_SESSION_REF_CUSTOM_TYPE } from "../session-ref.js";
import { BtwSideSessionRuntime, createSideSessionFile } from "../side-session.js";

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

const overlayView: BtwOverlayView = {
	isReady: () => true,
	isStreaming: () => false,
	getModelLabel: () => "faux/test-model",
	getModeLabel: () => "advisory only",
	getDisplayEntries: () => [{ kind: "assistant", text: "hello from /btw" }],
	sendMessage: async () => {},
};

function flushTicks(): Promise<void> {
	return new Promise((resolve) => process.nextTick(resolve));
}

async function testSessionRef(): Promise<void> {
	const ref = createBtwSessionRef("/tmp/btw.jsonl");
	const loaded = readBtwSessionRef([
		{ type: "custom", customType: "other", data: {} },
		{ type: "custom", customType: BTW_SESSION_REF_CUSTOM_TYPE, data: ref },
	]);
	assert.deepEqual(loaded, ref);
	assert.equal(readBtwSessionRef([]), undefined);
}

async function testOverlayFocusAndEscRouting(): Promise<void> {
	const terminal = new FakeTerminal();
	const tui = new TUI(terminal);
	const base = new BaseComponent();
	const bridge = new BtwOverlayBridge();
	let closed = false;

	const overlay = attachOverlayBridge(new BtwOverlayComponent(tui, theme, bridge, overlayView, () => {
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
	const bridge = new BtwOverlayBridge();
	const overlay = new BtwOverlayComponent(tui, theme, bridge, overlayView, () => {});
	const lines = overlay.render(80);
	assert.ok(lines.some((line) => line.includes("\x1b[48;2;24;28;36m")), "overlay should render its own shaded background");
	assert.ok(lines[0]?.includes("╭") && lines.at(-1)?.includes("╰"), "overlay should render a bordered floating window");
}

async function testSideSessionPersistence(): Promise<void> {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-btw-test-"));
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
		const bridge = new BtwOverlayBridge();
		const runtime = await BtwSideSessionRuntime.create({
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
			themeProvider: () => theme,
		});
		const entries = runtime.getDisplayEntries().map((entry) => entry.text);
		assert.ok(entries.some((text) => text.includes("restore me")), "user history should be restored from the /btw session file");
		assert.ok(entries.some((text) => text.includes("restored response")), "assistant history should be restored from the /btw session file");
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

async function testSideSessionUsesMainSystemPrompt(): Promise<void> {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-btw-test-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const mainSystemPrompt = "Main session system prompt";
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
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const bridge = new BtwOverlayBridge();
		const sessionFile = await createSideSessionFile(cwd);
		const runtime = await BtwSideSessionRuntime.create({
			bridge,
			cwd,
			modelRegistry: modelRegistry as any,
			model: undefined,
			thinkingLevel: undefined,
			sessionFile,
			systemPromptProvider: () => mainSystemPrompt,
			mainContextProvider: () => currentMainContext,
			themeProvider: () => theme,
		});
		assert.equal(runtime.getModeLabel(), "advisory only", "/btw should stay in advisory-only mode");

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
		assert.ok(firstSystemPrompt.includes(mainSystemPrompt), "/btw should inherit the main session system prompt");
		assert.ok(firstSystemPrompt.includes("You are running inside /btw."), "/btw addendum should identify the side assistant role");
		assert.ok(firstSystemPrompt.includes("You have no repo, system, or MCP tools in /btw."), "/btw addendum should remove repo/system/MCP tool authority");
		assert.ok(
			firstSystemPrompt.includes("Communication permissions to the main agent via followUp / steer are controlled separately and may be enabled or disabled."),
			"/btw addendum should describe separate followUp / steer permissions",
		);
		assert.ok(!firstSystemPrompt.includes("btw_request_write_access"), "/btw prompt should not reference the removed mutation approval tool");
		assert.ok(firstSystemPrompt.includes(currentMainContext.summaryText), "/btw prompt should inject the current main-session summary");
		assert.ok(firstSystemPrompt.includes(currentMainContext.recentText), "/btw prompt should inject the current recent main-session window");

		currentMainContext = createMainContext("SECOND_MAIN_REQUEST", "second assistant status", "SECOND_RECENT_WINDOW");
		const secondResult = await extensionRunner.emitBeforeAgentStart("check prompt again", undefined, "fallback prompt");
		const secondSystemPrompt = secondResult?.systemPrompt ?? "";
		assert.ok(secondSystemPrompt.includes(currentMainContext.summaryText), "/btw prompt should refresh the injected main-session summary for each turn");
		assert.ok(secondSystemPrompt.includes(currentMainContext.recentText), "/btw prompt should refresh the injected recent main-session window for each turn");
		assert.ok(!secondSystemPrompt.includes("FIRST_MAIN_REQUEST"), "/btw should not keep stale startup context in later turns");
		assert.ok(secondSystemPrompt.includes("SECOND_MAIN_REQUEST"), "/btw should inject the latest main-session request");
		assert.ok(secondSystemPrompt.includes("SECOND_RECENT_WINDOW"), "/btw should inject the latest recent main-session text");

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
				content: [{ type: "text", text: "Need the latest /btw context." }],
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
			customType: "btw.hidden",
			content: "hidden internal status",
			display: false,
		},
		{
			type: "custom_message",
			id: "custom-visible",
			parentId: "custom-hidden",
			timestamp: "2026-01-01T00:00:07.000Z",
			customType: "btw.visible",
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
				content: [{ type: "text", text: "Investigate the /btw context window" }],
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
		latestUserRequest: "Investigate the /btw context window",
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
	assert.equal(context.summary.latestUserRequest, "Investigate the /btw context window");
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

async function main(): Promise<void> {
	await testSessionRef();
	await testOverlayFocusAndEscRouting();
	await testOverlayRenderDistinctness();
	await testSideSessionPersistence();
	await testSideSessionUsesMainSystemPrompt();
	await testBuildMainSessionContext();
	console.log("btw tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
