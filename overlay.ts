import type { Theme } from "@mariozechner/pi-coding-agent";
import { Input, CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@mariozechner/pi-tui";

export interface JarvisDisplayEntry {
	kind: "user" | "assistant" | "tool" | "system" | "status";
	text: string;
}

export interface JarvisOverlayView {
	isReady(): boolean;
	isStreaming(): boolean;
	getModelLabel(): string;
	getModelModeLabel(): string;
	getMainStatusLabel(): string;
	getMainModelLabel(): string;
	isFollowUpToMainEnabled(): boolean;
	isSteerToMainEnabled(): boolean;
	toggleFollowUpToMain(): void;
	toggleSteerToMain(): void;
	getDisplayEntries(): JarvisDisplayEntry[];
	sendMessage(text: string): Promise<void>;
}

type NotificationType = "info" | "warning" | "error";
type OverlayFocusTarget = "input" | "followUp" | "steer";

const OVERLAY_FOCUS_ORDER: readonly OverlayFocusTarget[] = ["input", "followUp", "steer"];

interface NotificationItem {
	message: string;
	type: NotificationType;
	timestamp: number;
}

export interface JarvisPendingConfirmation {
	title: string;
	message: string;
}

interface PendingConfirmationRecord extends JarvisPendingConfirmation {
	resolve: (value: boolean) => void;
}

export interface JarvisOverlaySnapshot {
	statuses: string[];
	notifications: NotificationItem[];
	workingMessage?: string;
	pendingConfirmation?: JarvisPendingConfirmation;
}

export class JarvisOverlayBridge {
	private requestRender?: () => void;
	private statuses = new Map<string, string>();
	private notifications: NotificationItem[] = [];
	private workingMessage?: string;
	private pendingConfirmation?: PendingConfirmationRecord;

	reset(): void {
		this.statuses.clear();
		this.notifications = [];
		this.workingMessage = undefined;
		const pending = this.pendingConfirmation;
		this.pendingConfirmation = undefined;
		this.emit();
		pending?.resolve(false);
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

	/**
	 * Request a confirmation from the user. The returned promise resolves to
	 * `true` if the user confirms, `false` if they cancel, if `reset()` is
	 * called, or if a newer confirmation supersedes this one. Callers must not
	 * rely on the confirmation being answered immediately — the overlay may be
	 * closed when this is invoked, in which case the pending confirmation is
	 * held until the overlay is re-opened and the user answers it.
	 */
	requestConfirmation(title: string, message: string): Promise<boolean> {
		if (this.pendingConfirmation) {
			const previous = this.pendingConfirmation;
			this.pendingConfirmation = undefined;
			previous.resolve(false);
		}
		return new Promise<boolean>((resolve) => {
			this.pendingConfirmation = { title, message, resolve };
			this.emit();
		});
	}

	resolveConfirmation(value: boolean): void {
		const pending = this.pendingConfirmation;
		if (!pending) {
			return;
		}
		this.pendingConfirmation = undefined;
		this.emit();
		pending.resolve(value);
	}

	hasPendingConfirmation(): boolean {
		return this.pendingConfirmation !== undefined;
	}

	getPendingConfirmation(): JarvisPendingConfirmation | undefined {
		if (!this.pendingConfirmation) {
			return undefined;
		}
		return { title: this.pendingConfirmation.title, message: this.pendingConfirmation.message };
	}

	snapshot(): JarvisOverlaySnapshot {
		return {
			statuses: Array.from(this.statuses.values()),
			notifications: [...this.notifications],
			workingMessage: this.workingMessage,
			pendingConfirmation: this.getPendingConfirmation(),
		};
	}

	private emit(): void {
		this.requestRender?.();
	}
}

export class JarvisOverlayComponent implements Component, Focusable {
	focused = false;
	private readonly input = new Input();
	private readonly maxHeightProvider: () => number;
	private focusTarget: OverlayFocusTarget = "input";
	private historyIndex = -1;
	private historyDraft = "";

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly bridge: JarvisOverlayBridge,
		private readonly view: JarvisOverlayView,
		private readonly close: () => void,
	) {
		this.maxHeightProvider = () => Math.max(18, Math.floor(this.tui.terminal.rows * 0.78));

		this.input.onSubmit = (value) => {
			const message = value.trim();
			if (!message) {
				return;
			}
			this.input.setValue("");
			this.historyIndex = -1;
			this.historyDraft = "";
			void this.view.sendMessage(message);
		};
		this.input.onEscape = () => {
			this.close();
		};
	}

	handleInput(data: string): void {
		if (this.bridge.hasPendingConfirmation()) {
			if (data === "y" || data === "Y") {
				this.bridge.resolveConfirmation(true);
				return;
			}
			if (data === "n" || data === "N" || matchesKey(data, "escape")) {
				this.bridge.resolveConfirmation(false);
				return;
			}
			// Swallow every other key while a confirmation is pending so the user
			// cannot accidentally submit a message, move focus, or close the overlay
			// without answering the prompt.
			return;
		}
		if (matchesKey(data, "escape")) {
			this.close();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.cycleFocus(1);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.cycleFocus(-1);
			return;
		}
		if (this.focusTarget !== "input" && (matchesKey(data, "space") || matchesKey(data, "enter"))) {
			this.toggleFocusedControl();
			return;
		}
		if (this.focusTarget !== "input") {
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const entries = this.view.getDisplayEntries().filter((e) => e.kind === "user");
			if (entries.length === 0) return;

			if (matchesKey(data, "up")) {
				if (this.historyIndex === -1) {
					this.historyDraft = this.input.getValue();
					this.historyIndex = entries.length - 1;
				} else {
					this.historyIndex = Math.max(0, this.historyIndex - 1);
				}
				this.input.setValue(entries[this.historyIndex].text);
			} else {
				if (this.historyIndex !== -1) {
					this.historyIndex++;
					if (this.historyIndex >= entries.length) {
						this.historyIndex = -1;
						this.input.setValue(this.historyDraft);
					} else {
						this.input.setValue(entries[this.historyIndex].text);
					}
				}
			}
			return;
		}

		this.input.handleInput(data);
	}

	render(width: number): string[] {
		const hasConfirmation = this.bridge.hasPendingConfirmation();
		this.input.focused = this.focused && !hasConfirmation && this.focusTarget === "input";

		const maxHeight = this.maxHeightProvider();
		const innerWidth = Math.max(24, width - 4);
		const snapshot = this.bridge.snapshot();
		const notificationLines = this.notificationLines(snapshot.notifications, innerWidth);
		const headerLines = this.renderHeader(innerWidth);
		const confirmationLines = snapshot.pendingConfirmation
			? this.renderConfirmation(snapshot.pendingConfirmation, innerWidth)
			: undefined;
		const inputLine = confirmationLines ? undefined : this.renderInputLine(innerWidth);
		const footer = truncateToWidth(
			`${this.theme.fg("dim", hasConfirmation ? "Y confirm • N/esc cancel" : "tab cycle • enter send/toggle • space toggle • esc close")}`,
			innerWidth,
		);

		// Pre-compute every fixed section first so the transcript budget reflects
		// the true remaining space. Under-reserving here would push the footer
		// (or the confirmation banner) off the bottom of the overlay.
		const promptSectionLines = confirmationLines ? confirmationLines.length : 2;
		const footerSectionLines = 1;
		const borderLines = 2;
		const reservedLines =
			headerLines.length + notificationLines.length + promptSectionLines + footerSectionLines + borderLines;
		const transcriptBudget = Math.max(4, maxHeight - reservedLines);
		const transcriptLines = this.renderTranscript(innerWidth, transcriptBudget, snapshot);

		const body: string[] = [];
		body.push(...headerLines);
		if (notificationLines.length > 0) {
			body.push(...notificationLines);
		}
		body.push(...transcriptLines);
		if (confirmationLines) {
			body.push(...confirmationLines);
		} else {
			body.push(this.theme.fg(this.focused && this.focusTarget === "input" ? "accent" : "muted", "Message"));
			if (inputLine) {
				body.push(inputLine);
			}
		}
		body.push(footer);

		const lines: string[] = [];
		lines.push(this.borderTop(innerWidth));
		for (const line of body.slice(0, Math.max(1, maxHeight - borderLines))) {
			lines.push(this.row(line, innerWidth));
		}
		lines.push(this.borderBottom(innerWidth));
		return lines;
	}

	private renderConfirmation(confirmation: JarvisPendingConfirmation, innerWidth: number): string[] {
		const lines: string[] = [];
		lines.push(this.theme.bold(this.theme.fg("warning", `▶ ${confirmation.title}`)));
		for (const rawLine of confirmation.message.split("\n")) {
			if (rawLine.length === 0) {
				lines.push("");
				continue;
			}
			lines.push(...this.wrapBlock(rawLine, innerWidth));
		}
		lines.push(this.theme.fg("muted", "Press Y to confirm, N or Esc to cancel."));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.bridge.detach();
	}

	private renderHeader(innerWidth: number): string[] {
		const mainStatus = this.view.getMainStatusLabel();
		const mainStatusColor = mainStatus === "busy" ? "warning" : "success";
		const followUpToggle = this.renderToggle("FollowUp", this.view.isFollowUpToMainEnabled(), this.focused && this.focusTarget === "followUp");
		const steerToggle = this.renderToggle("Steer", this.view.isSteerToMainEnabled(), this.focused && this.focusTarget === "steer");
		return [
			truncateToWidth(`${this.theme.bold(this.theme.fg("accent", "/jarvis"))}  ${this.theme.fg("accent", "Main:")} ${this.theme.fg(mainStatusColor, mainStatus)}`, innerWidth),
			truncateToWidth(this.theme.fg("muted", `Main model: ${this.view.getMainModelLabel()}`), innerWidth, "", true),
			truncateToWidth(this.theme.fg("muted", `/jarvis model: ${this.view.getModelLabel()} (${this.view.getModelModeLabel()})`), innerWidth, "", true),
			truncateToWidth(`${followUpToggle}  ${steerToggle}`, innerWidth, "", true),
		];
	}

	private renderTranscript(innerWidth: number, budget: number, snapshot: JarvisOverlaySnapshot): string[] {
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

	private renderEntry(entry: JarvisDisplayEntry, innerWidth: number): string[] {
		switch (entry.kind) {
			case "user":
				return this.wrapWithPrefix(this.theme.fg("accent", "you"), entry.text, innerWidth);
			case "assistant":
				return this.wrapWithPrefix(this.theme.fg("success", "jarvis"), entry.text, innerWidth);
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

	private renderToggle(label: string, enabled: boolean, focused: boolean): string {
		const text = `${label}: ${enabled ? "on" : "off"}`;
		const rendered = this.theme.fg(enabled ? "success" : "muted", text);
		return focused ? this.theme.bold(`[${rendered}]`) : rendered;
	}

	private cycleFocus(direction: 1 | -1): void {
		const currentIndex = OVERLAY_FOCUS_ORDER.indexOf(this.focusTarget);
		const nextIndex = (currentIndex + direction + OVERLAY_FOCUS_ORDER.length) % OVERLAY_FOCUS_ORDER.length;
		this.focusTarget = OVERLAY_FOCUS_ORDER[nextIndex] ?? "input";
	}

	private toggleFocusedControl(): void {
		switch (this.focusTarget) {
			case "followUp":
				this.view.toggleFollowUpToMain();
				break;
			case "steer":
				this.view.toggleSteerToMain();
				break;
		}
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

export function attachOverlayBridge(component: JarvisOverlayComponent, bridge: JarvisOverlayBridge, tui: TUI): JarvisOverlayComponent {
	bridge.attach(() => tui.requestRender());
	return component;
}

export function cursorMarkerPresent(lines: readonly string[]): boolean {
	return lines.some((line) => line.includes(CURSOR_MARKER));
}
