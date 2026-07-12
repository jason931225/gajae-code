import * as logger from "../src/logger";
import * as postmortem from "../src/postmortem";

logger.setTransports({ console: true, file: false });

type ExitListener = (code?: number) => unknown;

function getPostmortemExitListener(): ExitListener {
	const listener = process.rawListeners("exit").at(-1);
	if (!listener) {
		throw new Error("postmortem exit listener was not registered");
	}
	return listener as ExitListener;
}

function writeResult(result: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runExitReentryWhileRunning(): Promise<void> {
	let count = 0;
	const exitListener = getPostmortemExitListener();
	postmortem.register("fixture-exit-reentry", async () => {
		count++;
		await Promise.resolve(exitListener(0));
	});

	await postmortem.cleanup();
	await Bun.sleep(20);
	writeResult({ count });
}

async function runNonExitRecursiveCleanup(): Promise<void> {
	let count = 0;
	postmortem.register("fixture-non-exit-recursion", () => {
		count++;
		void postmortem.cleanup();
	});

	await postmortem.cleanup();
	await Bun.sleep(20);
	writeResult({ count });
}

async function runCompletedCleanupExitNoop(): Promise<void> {
	let count = 0;
	const exitListener = getPostmortemExitListener();
	postmortem.register("fixture-complete-exit", () => {
		count++;
	});

	await postmortem.cleanup();
	await Promise.resolve(exitListener(0));
	await Bun.sleep(20);
	writeResult({ count });
}

async function runBrokenPipeStdoutWrite(): Promise<void> {
	// The test harness runs this scenario as `bun fixture.ts ... | true`, so the
	// stdout pipe's read end is closed almost immediately. Under Bun the write
	// below then throws a synchronous EPIPE from an async tick, which must reach
	// the postmortem uncaughtException handler — NOT be caught here.
	await Bun.sleep(50); // let `true` exit and close the pipe's read end
	setTimeout(async () => {
		await Promise.resolve();
		for (let i = 0; i < 256; i++) {
			process.stdout.write(`${"x".repeat(8192)}\n`);
		}
	}, 10);
	await Bun.sleep(2_000);
}

async function runBrokenPipeUnhandledRejection(): Promise<void> {
	const epipe = Object.assign(new Error("EPIPE: broken pipe, write"), {
		code: "EPIPE",
		syscall: "write",
		errno: -32,
	});
	void Promise.reject(epipe);
	await Bun.sleep(2_000);
}

async function runNonPipeUncaughtException(): Promise<void> {
	setTimeout(() => {
		throw new Error("fixture: genuine fatal error");
	}, 10);
	await Bun.sleep(2_000);
}

const scenario = process.argv[2];
switch (scenario) {
	case "exit-reentry-while-running":
		await runExitReentryWhileRunning();
		break;
	case "non-exit-recursive-cleanup":
		await runNonExitRecursiveCleanup();
		break;
	case "completed-cleanup-exit-noop":
		await runCompletedCleanupExitNoop();
		break;
	case "broken-pipe-stdout-write":
		await runBrokenPipeStdoutWrite();
		break;
	case "broken-pipe-unhandled-rejection":
		await runBrokenPipeUnhandledRejection();
		break;
	case "non-pipe-uncaught-exception":
		await runNonPipeUncaughtException();
		break;
	default:
		throw new Error(`unknown postmortem fixture scenario: ${scenario ?? "(missing)"}`);
}
