import { describe, expect, test } from "bun:test";
import { MasterWorkerObserver } from "../src/master/worker-observer";
import type { WorkerCreateIntent } from "../src/master/types";

function makeIntent(overrides: Partial<WorkerCreateIntent> = {}): WorkerCreateIntent {
	return {
		intentId: "intent-1",
		masterName: "console",
		taskId: "task-1",
		canonicalCwd: "/tmp/work",
		createIdempotencyKey: "console:worker-create:intent-1",
		promptDigest: "0".repeat(64),
		intendedOwner: { kind: "master", masterName: "console" },
		state: "created",
		promptIdempotencyKey: null,
		promptTurnId: null,
		followUps: [],
		createdAt: "2026-08-13T00:00:00.000Z",
		updatedAt: "2026-08-13T00:00:00.000Z",
		...overrides,
	};
}

function makeStore(intent: WorkerCreateIntent) {
	const reconcilePromptCalls: Array<{ proven: boolean; promptTurnId?: string }> = [];
	const store = {
		reconcilePromptCalls,
		async readWorkerIntent() {
			return intent;
		},
		async readWorkerIntents() {
			return [intent];
		},
		async readQueue() {
			return { tasks: [{ taskId: "task-1", summary: "do the thing", workdir: null }] };
		},
		async reconcileCreate() {
			return {
				leaseId: "lease-1",
				intentId: intent.intentId,
				taskId: "task-1",
				workerSessionId: "worker-session-1",
				lifecycle: "owned_unprompted",
				promptIdempotencyKey: null,
				quarantined: [],
				created: false,
			};
		},
		async markPromptPending() {
			return {
				leaseId: "lease-1",
				intentId: intent.intentId,
				taskId: "task-1",
				workerSessionId: "worker-session-1",
				lifecycle: "prompt_pending",
				promptIdempotencyKey: "master:worker-prompt:intent-1",
				quarantined: [],
			};
		},
		async reconcilePrompt(input: { proven: boolean; promptTurnId?: string }) {
			reconcilePromptCalls.push({ proven: input.proven, promptTurnId: input.promptTurnId });
			return {
				leaseId: "lease-1",
				intentId: intent.intentId,
				taskId: "task-1",
				workerSessionId: "worker-session-1",
				lifecycle: input.proven ? "active" : "prompt_pending",
				promptIdempotencyKey: "master:worker-prompt:intent-1",
				quarantined: [],
				proven: input.proven,
				drained: [],
			};
		},
	};
	return store;
}

const lease = {
	leaseId: "lease-1",
	intentId: "intent-1",
	taskId: "task-1",
	workerSessionId: "worker-session-1",
	attempt: 1,
	state: "leased" as const,
	idempotent: true,
	canonicalCwd: "/tmp/work",
	createIdempotencyKey: "console:worker-create:intent-1",
	promptDigest: "0".repeat(64),
};

describe("worker observer prompt acceptance", () => {
	test("direct delivery (delivered:true, queued:false) reconciles the prompt as proven", async () => {
		// The coordinator's turn.prompt success response reports `queued: false`
		// because the prompt was delivered directly rather than queued behind an
		// active turn. That is a success shape, not a rejection: treating it as
		// rejection leaves the intent prompt_pending forever, never persists the
		// proven turn id, and the observer can then never see worker_terminal.
		const store = makeStore(makeIntent());
		const observer = new MasterWorkerObserver({
			masterName: "console",
			domainStore: store as never,
			coordinator: {
				async sendPrompt() {
					return {
						turn_id: "turn-direct-1",
						status: "active",
						queued: false,
						delivered: true,
					};
				},
			},
		});
		const result = await observer.dispatchLease(lease);
		expect(result.error).toBeUndefined();
		expect(store.reconcilePromptCalls).toHaveLength(1);
		expect(store.reconcilePromptCalls[0]?.proven).toBe(true);
	});

	test("queued follow-up delivery (delivered:false, queued:true) still counts as accepted", async () => {
		const store = makeStore(makeIntent());
		const observer = new MasterWorkerObserver({
			masterName: "console",
			domainStore: store as never,
			coordinator: {
				async sendPrompt() {
					return {
						turn_id: "turn-queued-1",
						status: "queued",
						queued: true,
						delivered: false,
					};
				},
			},
		});
		const result = await observer.dispatchLease(lease);
		expect(result.error).toBeUndefined();
		expect(store.reconcilePromptCalls).toHaveLength(1);
		expect(store.reconcilePromptCalls[0]?.proven).toBe(true);
	});

	test("failed delivery (delivered:false, queued:false) is not proven", async () => {
		const store = makeStore(makeIntent());
		const observer = new MasterWorkerObserver({
			masterName: "console",
			domainStore: store as never,
			coordinator: {
				async sendPrompt() {
					return {
						turn_id: "turn-failed-1",
						status: "failed",
						queued: false,
						delivered: false,
					};
				},
			},
		});
		const result = await observer.dispatchLease(lease);
		expect(result.error).toBeUndefined();
		expect(store.reconcilePromptCalls).toHaveLength(1);
		expect(store.reconcilePromptCalls[0]?.proven).toBe(false);
	});

	test("explicit rejection (ok:false) is not proven even with a turn id", async () => {
		const store = makeStore(makeIntent());
		const observer = new MasterWorkerObserver({
			masterName: "console",
			domainStore: store as never,
			coordinator: {
				async sendPrompt() {
					return { turn_id: "turn-rejected-1", ok: false };
				},
			},
		});
		const result = await observer.dispatchLease(lease);
		expect(result.error).toBeUndefined();
		expect(store.reconcilePromptCalls).toHaveLength(1);
		expect(store.reconcilePromptCalls[0]?.proven).toBe(false);
	});
});
