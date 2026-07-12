/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `gjc -p "prompt"` - text output
 * - `gjc --mode json "prompt"` - JSON event stream
 */
import { type AssistantMessage, type ImageContent, isContextOverflow } from "@gajae-code/ai";
import { isBrokenPipeError, logger, sanitizeText } from "@gajae-code/utils";
import type { AgentSession } from "../session/agent-session";
import { isSilentAbort } from "../session/messages";
import { initializeExtensions } from "./runtime-init";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/**
	 * When true, an assistant error/abort does not call process.exit(); print mode
	 * returns instead so the caller (e.g. RLM autonomous mode) can run its own
	 * finalization/cleanup before the process exits.
	 */
	suppressProcessExit?: boolean;
}

/**
 * Exit code used when a non-interactive **text-mode** run (`gjc -p`) terminates
 * because the model context window is exhausted and automatic compaction could
 * not bring the request under the limit. Distinct from the generic failure code
 * (1) so text-mode callers can detect context exhaustion specifically instead of
 * parsing the raw provider error string.
 *
 * Scope: text-mode final-response path only. JSON mode (`--mode json`) streams
 * events from the subscription and does not run this terminal-error branch, so
 * it is intentionally NOT covered by this exit code.
 */
export const CONTEXT_OVERFLOW_EXIT_CODE = 2;

/**
 * Build an actionable stderr diagnostic for a terminal context-overflow error in
 * text mode. The raw provider message is preserved (appended) for debugging, but
 * the leading guidance explains what happened and what the operator can do —
 * tailored to whether auto-compaction was even enabled.
 */
function formatContextOverflowError(message: AssistantMessage, autoCompactionEnabled: boolean): string {
	const providerDetail = message.errorMessage ? ` (provider error: ${sanitizeText(message.errorMessage)})` : "";
	const guidance = autoCompactionEnabled
		? "Context window exhausted: automatic compaction ran but could not reduce the request below the model's context limit. Reduce the input size (smaller file reads / tool output), raise the compaction threshold, or switch to a larger-context model."
		: "Context window exhausted and automatic compaction is disabled. Enable it (compaction.enabled=true with a non-off compaction.strategy) so GJC can compact and continue, reduce the input size, or switch to a larger-context model.";
	return `${guidance}${providerDetail}`;
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages } = options;

	// Print-mode stdout is routinely piped onward (`gjc -p ... | jq`, `| head`).
	// When that consumer exits early, Bun surfaces the next write as a
	// synchronous EPIPE throw. Inside the agent-event subscription below such a
	// throw would rip through event dispatch (and become a fatal uncaught
	// exception), so once the pipe is known-broken all further stdout writes
	// latch to a no-op: the run still completes and the session persists.
	let stdoutBroken = false;
	const writeStdout = (chunk: string): void => {
		if (stdoutBroken) return;
		try {
			process.stdout.write(chunk);
		} catch (err) {
			if (!isBrokenPipeError(err)) throw err;
			stdoutBroken = true;
		}
	};

	// Emit session header for JSON mode
	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			writeStdout(`${JSON.stringify(header)}\n`);
		}
	}
	// Set up extensions for print mode (no UI, no command context)
	await initializeExtensions(session, {
		reportSendError: (action, err) => {
			process.stderr.write(
				`Extension ${action === "extension_send" ? "sendMessage" : "sendUserMessage"} failed: ${err.message}\n`,
			);
		},
		reportRuntimeError: err => {
			process.stderr.write(`Extension error (${err.extensionPath}): ${err.error}\n`);
		},
	});

	// Always subscribe to enable session persistence via _handleAgentEvent
	session.subscribe(event => {
		// In JSON mode, output all events
		if (mode === "json") {
			writeStdout(`${JSON.stringify(event)}\n`);
		}
	});

	// Send initial message with attachments
	if (initialMessage !== undefined) {
		await logger.time("print:prompt:initial", () => session.prompt(initialMessage, { images: initialImages }));
	}

	// Send remaining messages
	for (const message of messages) {
		await logger.time("print:prompt:next", () => session.prompt(message));
	}

	// In text mode, output final response
	if (mode === "text") {
		const state = session.state;
		const lastMessage = state.messages.findLast(message => message.role === "assistant");

		if (lastMessage?.role === "assistant") {
			const assistantMsg = lastMessage as AssistantMessage;

			// Check for error/aborted — skip silent-abort (plan-mode compaction transition)
			if (
				(assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") &&
				!isSilentAbort(assistantMsg.errorMessage)
			) {
				// Context-overflow is an expected, recoverable-in-principle condition — not
				// an opaque crash. Auto-compaction has already run inside session.prompt();
				// if we still land here the request could not be made to fit. In this
				// text-mode final-response path, surface an actionable diagnostic and a
				// distinct exit code so text-mode (`gjc -p`) callers can detect context
				// exhaustion instead of parsing the raw provider error string. (JSON mode
				// does not reach this branch and is intentionally out of scope.)
				const isOverflow =
					assistantMsg.stopReason === "error" && isContextOverflow(assistantMsg, session.model?.contextWindow);
				const errorLine = isOverflow
					? formatContextOverflowError(assistantMsg, session.autoCompactionEnabled)
					: sanitizeText(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
				const exitCode = isOverflow ? CONTEXT_OVERFLOW_EXIT_CODE : 1;
				const flushed = process.stderr.write(`${errorLine}\n`);
				// When the caller owns finalization (RLM autonomous), return instead of
				// exiting so its cleanup runs; the caller surfaces a non-zero exit itself.
				if (!options.suppressProcessExit) {
					if (flushed) {
						process.exit(exitCode);
					} else {
						process.stderr.once("drain", () => process.exit(exitCode));
					}
				}
			}

			if (
				assistantMsg.errorMessage &&
				assistantMsg.stopReason !== "error" &&
				assistantMsg.stopReason !== "aborted"
			) {
				process.stderr.write(`${sanitizeText(assistantMsg.errorMessage)}\n`);
			}

			// Output text content
			for (const content of assistantMsg.content) {
				if (content.type === "text") {
					writeStdout(`${sanitizeText(content.text)}\n`);
				}
			}
		}
	}

	// Ensure stdout is fully flushed before returning
	// This prevents race conditions where the process exits before all output is written
	await new Promise<void>((resolve, reject) => {
		try {
			process.stdout.write("", err => {
				if (err && !isBrokenPipeError(err)) reject(err);
				else resolve();
			});
		} catch (err) {
			// Bun throws synchronously when the pipe consumer is already gone;
			// there is nothing left to flush to, so this is not an error.
			if (isBrokenPipeError(err)) resolve();
			else reject(err);
		}
	});

	await session.dispose();
}
