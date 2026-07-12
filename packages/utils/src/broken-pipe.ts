/**
 * Broken-pipe (EPIPE) classification shared by output-stream writers.
 *
 * Under Bun a non-TTY `process.stdout`/`process.stderr` is an fs write stream
 * over a pipe fd; once the consumer exits (`gjc --help | head -1`), the next
 * write throws EPIPE synchronously. Node surfaces the same condition as an
 * async stream `'error'` event (`EPIPE` / `ERR_STREAM_DESTROYED`). Either way
 * it means "the reader went away" — a normal CLI shutdown condition, not an
 * internal error.
 */

const BROKEN_PIPE_ERROR_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED"]);

/** True when `error` reports a write against a pipe/stream whose peer is gone. */
export function isBrokenPipeError(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return typeof code === "string" && BROKEN_PIPE_ERROR_CODES.has(code);
}

/**
 * Exit code for a producer terminated because its output pipe broke:
 * 128 + SIGPIPE (13), matching what shells report for SIGPIPE-killed tools
 * in `foo | head`-style pipelines.
 */
export const BROKEN_PIPE_EXIT_CODE = 141;
