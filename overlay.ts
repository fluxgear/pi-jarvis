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
	getMainFocusLabel(): string;
	getMainDeltaLabel(): string;
	getRepoToolsDetailLabel(): string;
	isToolAccessEnabled(): boolean;
	isFollowUpToMainEnabled(): boolean;
	isSteerToMainEnabled(): boolean;
	toggleToolAccess(): void;
	toggleFollowUpToMain(): void;
	toggleSteerToMain(): void;
	getDisplayEntries(): JarvisDisplayEntry[];
	sendMessage(text: string): Promise<void>;
}

type NotificationType = "info" | "warning" | "error";
type OverlayFocusTarget = "input" | "tools" | "followUp" | "steer";

const OVERLAY_FOCUS_ORDER: readonly OverlayFocusTarget[] = ["input", "tools", "followUp", "steer"];

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

interface TranscriptBlock {
	lines: string[];
	preserveHeaderWhenClipped: boolean;
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
	private thinkingAnimationTick = 0;
	private thinkingAnimationTimer?: NodeJS.Timeout;

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
		const transcriptDivider = this.sectionDivider("Conversation", innerWidth);
		const promptDivider = this.sectionDivider(hasConfirmation ? "Confirm" : "Prompt", innerWidth);
		const confirmationLines = snapshot.pendingConfirmation
			? this.renderConfirmation(snapshot.pendingConfirmation, innerWidth)
			: undefined;
		const inputLine = confirmationLines ? undefined : this.renderInputLine(innerWidth);
		const footer = truncateToWidth(
			`${this.theme.fg("dim", hasConfirmation ? "Y confirm • N/esc cancel" : "tab cycle • enter send/toggle • space toggle • esc close")}`,
			innerWidth,
		);

		const promptSectionLines = [
			promptDivider,
			...(confirmationLines ?? (inputLine ? [inputLine] : [])),
			footer,
		];
		const borderLines = 2;
		const maxBodyLines = Math.max(1, maxHeight - borderLines);
		const reservedBottomLines = promptSectionLines.length;
		let remainingLines = Math.max(0, maxBodyLines - reservedBottomLines);

		const topSections: string[] = [];
		const visibleHeaderLines = headerLines.slice(0, remainingLines);
		topSections.push(...visibleHeaderLines);
		remainingLines -= visibleHeaderLines.length;

		if (remainingLines > 0 && notificationLines.length > 0) {
			const visibleNotificationLines = notificationLines.slice(-remainingLines);
			topSections.push(...visibleNotificationLines);
			remainingLines -= visibleNotificationLines.length;
		}

		if (remainingLines > 0) {
			topSections.push(transcriptDivider);
			remainingLines -= 1;
			topSections.push(...this.renderTranscript(innerWidth, remainingLines, snapshot));
		}

		const body = [...topSections, ...promptSectionLines].slice(0, maxBodyLines);

		const lines: string[] = [];
		lines.push(this.borderTop(innerWidth));
		for (const line of body) {
			lines.push(this.row(line, innerWidth));
		}
		lines.push(this.borderBottom(innerWidth));
		return lines;
	}

	private renderConfirmation(confirmation: JarvisPendingConfirmation, innerWidth: number): string[] {
		const lines: string[] = [];
		lines.push(this.theme.bold(this.theme.fg("warning", `▶ ${sanitizeOverlayDisplayText(confirmation.title)}`)));
		for (const rawLine of sanitizeOverlayDisplayText(confirmation.message).split("\n")) {
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
		this.stopThinkingAnimation();
		this.bridge.detach();
	}

	private renderHeader(innerWidth: number): string[] {
		const mainStatus = sanitizeOverlayDisplayText(this.view.getMainStatusLabel());
		const mainStatusColor = mainStatus === "busy" ? "warning" : "success";
		const toolsToggle = this.renderToggle("Repo tools", this.view.isToolAccessEnabled(), this.focused && this.focusTarget === "tools");
		const followUpToggle = this.renderToggle("Note main", this.view.isFollowUpToMainEnabled(), this.focused && this.focusTarget === "followUp");
		const steerToggle = this.renderToggle("Redirect", this.view.isSteerToMainEnabled(), this.focused && this.focusTarget === "steer");
		const mainModel = sanitizeOverlayDisplayText(this.view.getMainModelLabel());
		const sideModel = sanitizeOverlayDisplayText(this.view.getModelLabel());
		const modelMode = sanitizeOverlayDisplayText(this.view.getModelModeLabel());
		const focus = sanitizeOverlayDisplayText(this.view.getMainFocusLabel());
		const delta = sanitizeOverlayDisplayText(this.view.getMainDeltaLabel());
		const repoToolsDetail = sanitizeOverlayDisplayText(this.view.getRepoToolsDetailLabel());
		return [
			truncateToWidth(
				`${this.theme.bold(this.theme.fg("accent", "Jarvis"))} ${this.theme.fg("muted", "·")} ${this.theme.fg("accent", "Main")} ${this.theme.fg(mainStatusColor, mainStatus)}`,
				innerWidth,
			),
			truncateToWidth(this.theme.fg("muted", `Focus: ${focus}`), innerWidth, "", true),
			truncateToWidth(this.theme.fg("muted", `Since last: ${delta}`), innerWidth, "", true),
			truncateToWidth(this.theme.fg("muted", `Access: ${repoToolsDetail}`), innerWidth, "", true),
			truncateToWidth(
				`${this.theme.fg("muted", "Models:")} ${this.theme.fg("muted", `main ${mainModel}  ·  jarvis ${sideModel} (${modelMode})`)}` ,
				innerWidth,
				"",
				true,
			),
			truncateToWidth(`${toolsToggle}  ${followUpToggle}  ${steerToggle}`, innerWidth, "", true),
		];
	}

	private renderTranscript(innerWidth: number, budget: number, snapshot: JarvisOverlaySnapshot): string[] {
		if (budget <= 0) {
			this.syncThinkingAnimation(Boolean(snapshot.workingMessage && this.view.isStreaming()));
			return [];
		}

		const blocks: TranscriptBlock[] = [];
		const displayEntries = this.view.getDisplayEntries();
		const showAnimatedThinkingFallback = Boolean(snapshot.workingMessage && this.view.isStreaming());
		this.syncThinkingAnimation(showAnimatedThinkingFallback);
		let previousKind: JarvisDisplayEntry["kind"] | undefined;
		for (const entry of displayEntries) {
			if (
				previousKind !== undefined && previousKind !== entry.kind && previousKind !== "system" && entry.kind !== "system"
			) {
				blocks.push({ lines: [""], preserveHeaderWhenClipped: false });
			}
			blocks.push(this.createTranscriptBlock(this.renderEntry(entry, innerWidth), entry.kind !== "system"));
			previousKind = entry.kind;
		}
		if (showAnimatedThinkingFallback) {
			blocks.push(this.createTranscriptBlock(this.renderAnimatedThinkingFallback(innerWidth, snapshot.workingMessage!), false));
		}
		for (const status of snapshot.statuses) {
			blocks.push(this.createTranscriptBlock(this.wrapBlock(sanitizeOverlayDisplayText(status), innerWidth), false));
		}
		return this.clipTranscriptBlocks(blocks, budget);
	}

	private renderEntry(entry: JarvisDisplayEntry, innerWidth: number): string[] {
		const safeText = sanitizeOverlayDisplayText(entry.text);
		switch (entry.kind) {
			case "user":
				return this.wrapWithPrefix(this.theme.fg("accent", "User:"), safeText, innerWidth);
			case "assistant":
				return this.wrapWithPrefix(this.theme.fg("success", "Jarvis:"), safeText, innerWidth);
			case "tool":
				return this.wrapWithPrefix(this.theme.fg("warning", "Tool:"), safeText, innerWidth);
			case "status":
				return this.wrapWithPrefix(this.theme.fg("muted", "Note:"), safeText, innerWidth);
			case "system":
			default:
				return this.wrapBlock(this.theme.fg("muted", safeText), innerWidth);
		}
	}

	private renderInputLine(innerWidth: number): string {
		const prefix = `${this.theme.fg("accent", "›")} `;
		const inputWidth = Math.max(8, innerWidth - 2);
		const rendered = this.input.render(inputWidth)[0] ?? "";
		return truncateToWidth(prefix + rendered, innerWidth, "", true);
	}

	private createTranscriptBlock(lines: string[], preserveHeaderWhenClipped: boolean): TranscriptBlock {
		return { lines, preserveHeaderWhenClipped };
	}

	private clipTranscriptBlocks(blocks: readonly TranscriptBlock[], budget: number): string[] {
		const visible: string[] = [];
		let remaining = budget;
		for (let i = blocks.length - 1; i >= 0 && remaining > 0; i--) {
			const block = blocks[i];
			if (block.lines.length <= remaining) {
				visible.unshift(...block.lines);
				remaining -= block.lines.length;
				continue;
			}
			visible.unshift(...this.clipTranscriptBlock(block, remaining));
			break;
		}
		return visible;
	}

	private clipTranscriptBlock(block: TranscriptBlock, budget: number): string[] {
		if (block.lines.length <= budget) {
			return [...block.lines];
		}
		if (block.preserveHeaderWhenClipped && budget > 1) {
			return [block.lines[0] ?? "", ...block.lines.slice(-(budget - 1))];
		}
		return block.lines.slice(-budget);
	}

	private notificationLines(items: readonly NotificationItem[], innerWidth: number): string[] {
		const recent = items.slice(-2);
		const lines: string[] = [];
		for (const item of recent) {
			const color = item.type === "error" ? "error" : item.type === "warning" ? "warning" : "muted";
			lines.push(this.sectionDivider("Notice", innerWidth));
			lines.push(...this.wrapBlock(this.theme.fg(color, sanitizeOverlayDisplayText(item.message)), innerWidth));
		}
		return lines;
	}

	private sectionDivider(label: string, innerWidth: number): string {
		const plain = ` ${label} `;
		const fillWidth = Math.max(0, innerWidth - plain.length);
		const left = Math.floor(fillWidth / 2);
		const right = fillWidth - left;
		return truncateToWidth(this.theme.fg("borderMuted", `${"─".repeat(left)}${plain}${"─".repeat(right)}`), innerWidth, "", true);
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
			case "tools":
				this.view.toggleToolAccess();
				break;
			case "followUp":
				this.view.toggleFollowUpToMain();
				break;
			case "steer":
				this.view.toggleSteerToMain();
				break;
		}
	}

	private syncThinkingAnimation(active: boolean): void {
		if (active) {
			if (!this.thinkingAnimationTimer) {
				this.thinkingAnimationTimer = setInterval(() => {
					this.thinkingAnimationTick += 1;
					this.tui.requestRender();
				}, 80);
			}
			return;
		}
		this.stopThinkingAnimation();
	}

	private stopThinkingAnimation(): void {
		if (!this.thinkingAnimationTimer) {
			return;
		}
		clearInterval(this.thinkingAnimationTimer);
		this.thinkingAnimationTimer = undefined;
		this.thinkingAnimationTick = 0;
	}

	private renderAnimatedThinkingFallback(innerWidth: number, message: string): string[] {
		const icons = ["◈", "◆", "◇", "✦", "✧", "✦"];
		const icon = icons[this.thinkingAnimationTick % icons.length] ?? "◈";
		const shimmerText = this.renderShimmeringThinkingText(sanitizeOverlayDisplayText(message));
		return this.wrapBlock(`${this.theme.bold(this.theme.fg("accent", icon))} ${shimmerText}`, innerWidth);
	}

	private renderShimmeringThinkingText(text: string): string {
		const chars = [...text];
		if (chars.length === 0) {
			return "";
		}
		const highlightIndex = this.thinkingAnimationTick % chars.length;
		return chars
			.map((char, index) => {
				const distance = Math.abs(index - highlightIndex);
				const color = distance === 0
					? [232, 239, 247]
					: distance === 1
						? [171, 182, 198]
						: [112, 122, 138];
				return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m${char}`;
			})
			.join("") + "\x1b[0m";
	}

	private wrapWithPrefix(prefix: string, text: string, innerWidth: number): string[] {
		const indentWidth = Math.min(innerWidth - 1, Math.max(7, visibleWidth(prefix) + 2));
		const wrapped = wrapTextWithAnsi(text || " ", Math.max(1, innerWidth - indentWidth));
		return wrapped.map((line, index) => {
			const label = index === 0 ? prefix : " ".repeat(Math.max(0, visibleWidth(prefix) + 1));
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

function sanitizeOverlayDisplayText(text: string): string {
	return text
		.replace(/\r/g, "")
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, "")
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "")
		.replace(/\x1b/g, "");
}

export function attachOverlayBridge(component: JarvisOverlayComponent, bridge: JarvisOverlayBridge, tui: TUI): JarvisOverlayComponent {
	bridge.attach(() => tui.requestRender());
	return component;
}

export function cursorMarkerPresent(lines: readonly string[]): boolean {
	return lines.some((line) => line.includes(CURSOR_MARKER));
}
