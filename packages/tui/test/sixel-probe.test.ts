import { afterEach, describe, expect, it } from "bun:test";
import { ImageProtocol, isUnderTerminalMultiplexer, setTerminalImageProtocol, TERMINAL, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminalInfo = TERMINAL as unknown as MutableTerminalInfo;
const originalProtocol = TERMINAL.imageProtocol;
const originalWtSession = Bun.env.WT_SESSION;
const originalTmux = Bun.env.TMUX;
const originalTerm = Bun.env.TERM;
const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function restoreIsTty(
	stream: NodeJS.ReadStream | NodeJS.WriteStream,
	descriptor: PropertyDescriptor | undefined,
): void {
	if (descriptor) {
		Object.defineProperty(stream, "isTTY", descriptor);
		return;
	}
	delete (stream as unknown as { isTTY?: boolean }).isTTY;
}

describe("TUI SIXEL capability probe", () => {
	afterEach(() => {
		setTerminalImageProtocol(originalProtocol);
		terminalInfo.imageProtocol = originalProtocol;
		if (originalWtSession === undefined) delete Bun.env.WT_SESSION;
		else Bun.env.WT_SESSION = originalWtSession;
		if (originalTmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = originalTmux;
		if (originalTerm === undefined) delete Bun.env.TERM;
		else Bun.env.TERM = originalTerm;
		restoreIsTty(process.stdin, stdinIsTtyDescriptor);
		restoreIsTty(process.stdout, stdoutIsTtyDescriptor);
	});

	it("enables SIXEL only after positive terminal capability response", () => {
		if (process.platform !== "win32") return;
		setTerminalImageProtocol(null);
		terminalInfo.imageProtocol = null;
		Bun.env.WT_SESSION = "test-wt-session";
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;4c");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("enables SIXEL when DA and graphics replies are coalesced in one chunk", () => {
		if (process.platform !== "win32") return;
		setTerminalImageProtocol(null);
		terminalInfo.imageProtocol = null;
		Bun.env.WT_SESSION = "test-wt-session";
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;4c\x1b[?2;1;0S");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("enables SIXEL when DA reply arrives split across chunks", () => {
		if (process.platform !== "win32") return;
		setTerminalImageProtocol(null);
		terminalInfo.imageProtocol = null;
		Bun.env.WT_SESSION = "test-wt-session";
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;");
		terminal.sendInput("4c");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("keeps SIXEL disabled when capability responses are negative", () => {
		if (process.platform !== "win32") return;
		setTerminalImageProtocol(null);
		terminalInfo.imageProtocol = null;
		Bun.env.WT_SESSION = "test-wt-session";
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2c");
		terminal.sendInput("\x1b[?2;0;0S");

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("enables SIXEL under tmux when DA1 advertises sixel", () => {
		setTerminalImageProtocol(null);
		terminalInfo.imageProtocol = null;
		delete Bun.env.WT_SESSION;
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;4c");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("keeps SIXEL disabled under tmux when DA1 lacks the sixel attribute", () => {
		setTerminalImageProtocol(null);
		terminalInfo.imageProtocol = null;
		delete Bun.env.WT_SESSION;
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2c");
		terminal.sendInput("\x1b[?2;0;0S");

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("does not probe outside tmux/screen and Windows Terminal", () => {
		setTerminalImageProtocol(null);
		terminalInfo.imageProtocol = null;
		delete Bun.env.WT_SESSION;
		delete Bun.env.TMUX;
		Bun.env.TERM = "xterm-256color";
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;4c");

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});
});

describe("isUnderTerminalMultiplexer", () => {
	it("detects tmux via $TMUX and TERM, screen via TERM", () => {
		expect(isUnderTerminalMultiplexer({ TMUX: "/tmp/tmux-1000/default,1,0" })).toBe(true);
		expect(isUnderTerminalMultiplexer({ TERM: "tmux-256color" })).toBe(true);
		expect(isUnderTerminalMultiplexer({ TERM: "screen-256color" })).toBe(true);
	});

	it("stays false for plain terminals", () => {
		expect(isUnderTerminalMultiplexer({ TERM: "xterm-256color" })).toBe(false);
		expect(isUnderTerminalMultiplexer({ TERM: "xterm-kitty" })).toBe(false);
		expect(isUnderTerminalMultiplexer({})).toBe(false);
	});
});
