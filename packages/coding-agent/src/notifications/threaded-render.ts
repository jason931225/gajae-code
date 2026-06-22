/**
 * Pure rendering of threaded-session frames into Telegram send specs.
 *
 * The daemon receives the additive `ServerMessage` frames (identity_header,
 * context_update, turn_stream, image_attachment, config_update) over the session
 * WS and must turn each into a Bot API call scoped to the session's forum topic
 * (`message_thread_id`), throttled through the shared rate-limit pool. This
 * module is the pure frame→send mapping (including the priority lane and live-
 * edit coalesce key), so rendering is unit-testable without a live Bot API.
 */

import { truncate } from "./helpers";
import type { RateLimitLane } from "./rate-limit-pool";

/** A Telegram send derived from a threaded frame (topic id is applied by the daemon). */
export interface ThreadedSend {
	method: "sendMessage" | "sendPhoto";
	/** Rate-limit lane for prioritisation/fairness. */
	lane: RateLimitLane;
	/** Message text (sendMessage) or photo caption (sendPhoto). */
	text?: string;
	/** Base64 image bytes for sendPhoto. */
	photoBase64?: string;
	/** Image MIME type for sendPhoto. */
	mime?: string;
	/** Coalesce key for live edits (same key collapses to the latest). */
	coalesceKey?: string;
	/** True for the one-time identity header (the daemon pins it once). */
	identity?: boolean;
}

interface ThreadedFrame {
	type?: unknown;
	sessionId?: unknown;
	// identity_header
	repo?: unknown;
	branch?: unknown;
	machine?: unknown;
	title?: unknown;
	// context_update
	lastMessage?: unknown;
	task?: unknown;
	goal?: unknown;
	tokenUsage?: unknown;
	model?: unknown;
	diff?: unknown;
	// turn_stream
	phase?: unknown;
	text?: unknown;
	messageRef?: unknown;
	// image_attachment
	source?: unknown;
	data?: unknown;
	mime?: unknown;
	caption?: unknown;
	// config_update
	verbosity?: unknown;
	redact?: unknown;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Format the one-time identity header as pinned bullets. */
export function formatIdentityHeader(frame: {
	repo?: unknown;
	branch?: unknown;
	machine?: unknown;
	sessionId?: unknown;
	title?: unknown;
}): string {
	const title = str(frame.title) ?? "GJC session";
	const bullets = [
		`• repo: ${str(frame.repo) ?? "?"}`,
		`• branch: ${str(frame.branch) ?? "?"}`,
		`• machine: ${str(frame.machine) ?? "?"}`,
		`• session: ${str(frame.sessionId) ?? "?"}`,
	];
	return `${title}\n${bullets.join("\n")}`;
}

/** Format a streamed context update into a compact block (omitting empty fields). */
export function formatContextUpdate(frame: ThreadedFrame): string | undefined {
	const lines: string[] = [];
	const last = str(frame.lastMessage);
	if (last) lines.push(truncate(last, 600));
	const task = str(frame.task);
	if (task) lines.push(`task: ${task}`);
	const goal = str(frame.goal);
	if (goal) lines.push(`goal: ${goal}`);
	const usage = str(frame.tokenUsage);
	const model = str(frame.model);
	if (usage || model) lines.push(`ctx: ${[usage, model].filter(Boolean).join(" · ")}`);
	const diff = str(frame.diff);
	if (diff) lines.push(`diff:\n${truncate(diff, 1200)}`);
	return lines.length ? lines.join("\n") : undefined;
}

/**
 * Map a threaded frame to a Telegram send spec, or `undefined` when there is
 * nothing to send (e.g. an empty context update or an unknown frame type).
 */
export function renderThreadedFrame(frame: ThreadedFrame): ThreadedSend | undefined {
	switch (frame.type) {
		case "identity_header":
			return { method: "sendMessage", lane: "finalized", text: formatIdentityHeader(frame), identity: true };
		case "context_update": {
			const text = formatContextUpdate(frame);
			return text
				? { method: "sendMessage", lane: "live", text, coalesceKey: `ctx:${str(frame.sessionId) ?? ""}` }
				: undefined;
		}
		case "turn_stream": {
			const text = str(frame.text);
			if (!text) return undefined;
			const finalized = frame.phase === "finalized";
			return {
				method: "sendMessage",
				lane: finalized ? "finalized" : "live",
				text,
				coalesceKey: finalized ? undefined : `turn:${str(frame.messageRef) ?? str(frame.sessionId) ?? ""}`,
			};
		}
		case "image_attachment": {
			const data = str(frame.data);
			if (!data) return undefined;
			return {
				method: "sendPhoto",
				lane: "finalized",
				photoBase64: data,
				mime: str(frame.mime),
				text: str(frame.caption),
			};
		}
		case "config_update": {
			const verbosity = str(frame.verbosity);
			const redact = typeof frame.redact === "boolean" ? `redact ${frame.redact ? "on" : "off"}` : undefined;
			const parts = [verbosity ? `verbosity ${verbosity}` : undefined, redact].filter(Boolean);
			return parts.length ? { method: "sendMessage", lane: "idle", text: `⚙ ${parts.join(", ")}` } : undefined;
		}
		default:
			return undefined;
	}
}
