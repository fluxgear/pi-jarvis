import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuthStorage, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
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
import { classifyMcpTool, requiresMcpMutationApproval } from "../mcp-policy.js";
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
	getModeLabel: () => "read-only",
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

async function testMcpPolicy(): Promise<void> {
	assert.equal(classifyMcpTool({ name: "get_document", description: "Read-only document lookup" }), "read-only");
	assert.equal(classifyMcpTool({ name: "update_document", description: "Writes changes back" }), "mutation");
	assert.equal(classifyMcpTool({ name: "mystery_tool", description: "Does something" }), "unknown");

	assert.equal(
		requiresMcpMutationApproval({ search: "document" }, { name: "get_document", description: "Read-only" }),
		false,
	);
	assert.equal(
		requiresMcpMutationApproval({ tool: "get_document" }, { name: "get_document", description: "Read-only" }),
		false,
	);
	assert.equal(
		requiresMcpMutationApproval({ tool: "update_document" }, { name: "update_document", description: "Writes changes" }),
		true,
	);
	assert.equal(requiresMcpMutationApproval({ tool: "mystery_tool" }, undefined), true);
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

		const result = await extensionRunner.emitBeforeAgentStart("check prompt", undefined, "fallback prompt");
		assert.equal(result?.systemPrompt, mainSystemPrompt, "/btw should run with the main session system prompt");

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

async function main(): Promise<void> {
	await testSessionRef();
	await testMcpPolicy();
	await testOverlayFocusAndEscRouting();
	await testOverlayRenderDistinctness();
	await testSideSessionPersistence();
	await testSideSessionUsesMainSystemPrompt();
	console.log("btw tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
