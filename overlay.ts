import type { Theme } from "@mariozechner/pi-coding-agent";
import { Input, CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@mariozechner/pi-tui";

export interface BtwDisplayEntry {
	kind: "user" | "assistant" | "tool" | "system" | "status";
	text: string;
}

export interface BtwOverlayView {
	isReady(): boolean;
	isStreaming(): boolean;
	getModelLabel(): string;
	getModeLabel(): string;
	getDisplayEntries(): BtwDisplayEntry[];
	sendMessage(text: string): Promise<void>;
}

type NotificationType = "info" | "warning" | "error";

interface NotificationItem {
	message: string;
	type: NotificationType;
	timestamp: number;
}

export interface BtwOverlaySnapshot {
	statuses: string[];
	notifications: NotificationItem[];
	workingMessage?: string;
}

export class BtwOverlayBridge {
	private requestRender?: () => void;
	private statuses = new Map<string, string>();
	private notifications: NotificationItem[] = [];
	private workingMessage?: string;

	reset(): void {
		this.statuses.clear();
		this.notifications = [];
		this.workingMessage = undefined;
		this.emit();
	}

	attach(requestRender: () => void): void {
		this.requestRender = requestRender;
		this.emit();
	}

	detach(): void {
		this.requestRender = undefined;
	}

	setStatus(key: string, value: string | undefined): void {
		if (!value) {
			this.statuses.delete(key);
		} else {
			this.statuses.set(key, value);
		}
		this.emit();
	}

	notify(message: string, type: NotificationType = "info"): void {
		this.notifications.push({ message, type, timestamp: Date.now() });
		if (this.notifications.length > 6) {
			this.notifications = this.notifications.slice(-6);
		}
		this.emit();
	}

	setWorkingMessage(message?: string): void {
		this.workingMessage = message;
		this.emit();
	}

	snapshot(): BtwOverlaySnapshot {
		return {
			statuses: Array.from(this.statuses.values()),
			notifications: [...this.notifications],
			workingMessage: this.workingMessage,
		};
	}

	private emit(): void {
		this.requestRender?.();
	}
}

export class BtwOverlayComponent implements Component, Focusable {
	focused = false;
	private readonly input = new Input();
	private readonly maxHeightProvider: () => number;
	private draft = "";

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly bridge: BtwOverlayBridge,
		private readonly view: BtwOverlayView,
		private readonly close: () => void,
	) {
		this.maxHeightProvider = () => Math.max(18, Math.floor(this.tui.terminal.rows * 0.78));

		this.input.onSubmit = (value) => {
			const message = value.trim();
			if (!message) {
				return;
			}
			this.draft = "";
			this.input.setValue("");
			void this.view.sendMessage(message);
		};
		this.input.onEscape = () => {
			this.close();
		};
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.close();
			return;
		}

		this.input.handleInput(data);
		this.draft = this.input.getValue();
	}

	render(width: number): string[] {
		this.input.focused = this.focused;

		const maxHeight = this.maxHeightProvider();
		const innerWidth = Math.max(24, width - 4);
		const snapshot = this.bridge.snapshot();
		const notificationLines = this.notificationLines(snapshot.notifications, innerWidth);
		const reservedLines = 9 + notificationLines.length;
		const transcriptBudget = Math.max(4, maxHeight - reservedLines);
		const transcriptLines = this.renderTranscript(innerWidth, transcriptBudget, snapshot);
		const inputLine = this.renderInputLine(innerWidth);
		const footer = truncateToWidth(`${this.theme.fg("dim", "enter send • esc close")}`, innerWidth);

		const body: string[] = [];
		body.push(...this.renderHeader(innerWidth));
		if (notificationLines.length > 0) {
			body.push(...notificationLines);
		}
		body.push(...transcriptLines);
		body.push(this.theme.fg("accent", "Message"));
		body.push(inputLine);
		body.push(footer);

		const lines: string[] = [];
		lines.push(this.borderTop(innerWidth));
		for (const line of body.slice(0, Math.max(1, maxHeight - 2))) {
			lines.push(this.row(line, innerWidth));
		}
		lines.push(this.borderBottom(innerWidth));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.bridge.detach();
	}

	private renderHeader(innerWidth: number): string[] {
		const readyLabel = this.view.isReady()
			? this.theme.fg("success", "● ready")
			: this.theme.fg("warning", "● starting");
		const mode = this.theme.fg("accent", this.view.getModeLabel());
		const model = this.theme.fg("muted", this.view.getModelLabel());
		return [
			truncateToWidth(`${this.theme.bold(this.theme.fg("accent", "/btw"))}  ${readyLabel}  ${mode}`, innerWidth),
			truncateToWidth(model, innerWidth),
		];
	}

	private renderTranscript(innerWidth: number, budget: number, snapshot: BtwOverlaySnapshot): string[] {
		const lines: string[] = [];
		for (const entry of this.view.getDisplayEntries()) {
			lines.push(...this.renderEntry(entry, innerWidth));
		}
		if (snapshot.workingMessage && this.view.isStreaming()) {
			lines.push(...this.wrapBlock(this.theme.fg("warning", `… ${snapshot.workingMessage}`), innerWidth));
		}
		for (const status of snapshot.statuses) {
			lines.push(...this.wrapBlock(status, innerWidth));
		}
		const collapsed = lines.slice(-budget);
		while (collapsed.length < budget) {
			collapsed.unshift("");
		}
		return collapsed;
	}

	private renderEntry(entry: BtwDisplayEntry, innerWidth: number): string[] {
		switch (entry.kind) {
			case "user":
				return this.wrapWithPrefix(this.theme.fg("accent", "you"), entry.text, innerWidth);
			case "assistant":
				return this.wrapWithPrefix(this.theme.fg("success", "btw"), entry.text, innerWidth);
			case "tool":
				return this.wrapWithPrefix(this.theme.fg("warning", "tool"), entry.text, innerWidth);
			case "status":
				return this.wrapWithPrefix(this.theme.fg("muted", "note"), entry.text, innerWidth);
			case "system":
			default:
				return this.wrapBlock(this.theme.fg("muted", entry.text), innerWidth);
		}
	}

	private renderInputLine(innerWidth: number): string {
		const prefix = `${this.theme.fg("accent", "›")} `;
		const inputWidth = Math.max(8, innerWidth - 2);
		const rendered = this.input.render(inputWidth)[0] ?? "";
		return truncateToWidth(prefix + rendered, innerWidth, "", true);
	}

	private notificationLines(items: readonly NotificationItem[], innerWidth: number): string[] {
		const recent = items.slice(-2);
		const lines: string[] = [];
		for (const item of recent) {
			const color = item.type === "error" ? "error" : item.type === "warning" ? "warning" : "muted";
			lines.push(...this.wrapBlock(this.theme.fg(color, item.message), innerWidth));
		}
		return lines;
	}

	private wrapWithPrefix(prefix: string, text: string, innerWidth: number): string[] {
		const indentWidth = Math.min(innerWidth - 1, Math.max(6, visibleWidth(prefix) + 1));
		const wrapped = wrapTextWithAnsi(text || " ", Math.max(1, innerWidth - indentWidth));
		return wrapped.map((line, index) => {
			const label = index === 0 ? prefix : " ".repeat(Math.max(0, visibleWidth(prefix)));
			return truncateToWidth(`${label} ${line}`, innerWidth, "", true);
		});
	}

	private wrapBlock(text: string, innerWidth: number): string[] {
		const wrapped = wrapTextWithAnsi(text || " ", Math.max(1, innerWidth));
		return wrapped.map((line) => truncateToWidth(line, innerWidth, "", true));
	}

	private row(content: string, innerWidth: number): string {
		const visible = visibleWidth(content);
		const padded = content + " ".repeat(Math.max(0, innerWidth - visible));
		const bg = this.overlayBackground(padded);
		return `${this.theme.fg("borderMuted", "│")} ${bg} ${this.theme.fg("borderMuted", "│")}`;
	}

	private borderTop(innerWidth: number): string {
		return this.theme.fg("borderAccent", `╭${"─".repeat(innerWidth + 2)}╮`);
	}

	private borderBottom(innerWidth: number): string {
		return this.theme.fg("borderAccent", `╰${"─".repeat(innerWidth + 2)}╯`);
	}

	private overlayBackground(text: string): string {
		return `\x1b[48;2;24;28;36m${text}\x1b[0m`;
	}
}

export function attachOverlayBridge(component: BtwOverlayComponent, bridge: BtwOverlayBridge, tui: TUI): BtwOverlayComponent {
	bridge.attach(() => tui.requestRender());
	return component;
}

export function cursorMarkerPresent(lines: readonly string[]): boolean {
	return lines.some((line) => line.includes(CURSOR_MARKER));
}
