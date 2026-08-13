import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { MasterDomainStore } from "../src/master/domain-store";
import { MasterRuntime } from "../src/master/runtime";

// Live incident 2026-08-13: with both master queues empty, the presentation
// outbox grew ~85 rows / 15 min and the master model was prompted ~8x/min
// forever. Loop: drain reconciles a row -> channel_updated event -> turn ->
// two master_status events -> two new outbox rows -> more drain. These tests
// pin the two dampers that break the loop.

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function statusPayload() {
	return {
		transition: "state_changed",
		previousStatus: "idle",
		status: "busy",
		reason: null,
		providers: {
			configuredProviders: ["discord"],
			activeProviders: ["discord"],
			degradedProviders: [],
			operational: true,
		},
		memoryAvailability: "unavailable",
	};
}

function memoryPayload(masterName: string) {
	return {
		activity: {
			activityId: "11111111-1111-4111-8111-111111111111",
			operation: "read",
			scope: "global",
			masterName,
			summary: "operator audit note",
			occurredAt: new Date().toISOString(),
		},
	};
}

describe("presentation outbox damping", () => {
	test("master_status events do not create presentation outbox rows; memory_activity still does", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "master-damping-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const store = await MasterDomainStore.create({
			masterName: "dampingtest",
			masterRootDir: path.join(root, "master"),
			defaultWorkdir: root,
			configuredProviders: ["discord"],
		} as never);
		await store.appendEvent({ type: "master_status", payload: statusPayload() } as never);
		expect(await store.getOutbox()).toHaveLength(0);
		await store.appendEvent({ type: "memory_activity", payload: memoryPayload("dampingtest") } as never);
		const rows = await store.getOutbox();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.provider).toBe("discord");
	});
});

describe("runtime turn-trigger damping", () => {
	function makeRuntime(events: Array<Record<string, unknown>>) {
		const prompts: string[] = [];
		const store = {
			async readEvents(afterSeq: number) {
				return events.filter(event => (event.seq as number) > afterSeq);
			},
			async readQueue() {
				return { tasks: [], maxConcurrentWorkers: 1, activeWorkerCount: 0 };
			},
			async readWorkerIntents() {
				return [];
			},
			async readWorkers() {
				return { workers: [] };
			},
			async admitNextTask() {
				return null;
			},
		};
		const runtime = new MasterRuntime({
			masterName: "dampingtest",
			domainStore: store as never,
			providerHealth: {
				configuredProviders: ["discord"],
				activeProviders: ["discord"],
				degradedProviders: [],
				operational: true,
			},
			sessionFactory: (async () => ({
				prompt: async (text: string) => {
					prompts.push(text);
				},
			})) as never,
		});
		return { runtime, prompts };
	}

	function frame(seq: number, type: string, payload: Record<string, unknown>) {
		return { protocolVersion: 1, seq, eventId: `dampingtest:event:${seq}`, masterName: "dampingtest", occurredAt: new Date().toISOString(), type, payload };
	}

	test("status flips and presentation receipts do not schedule master turns", async () => {
		const { runtime, prompts } = makeRuntime([
			frame(1, "master_status", statusPayload()),
			frame(2, "channel_updated", {
				transition: "presentation_reconciled",
				provider: "discord",
				eventId: "dampingtest:event:1",
				effectId: "present:discord:dampingtest:event:1",
				bindingId: "binding-1",
				remoteMessageId: "123",
				fence: 0,
				state: "active",
			}),
		]);
		await runtime.refreshFromStore();
		await runtime.waitForIdle(1_000);
		expect(prompts).toHaveLength(0);
	});

	test("binding lifecycle and work events still schedule master turns", async () => {
		const { runtime, prompts } = makeRuntime([
			frame(1, "channel_updated", {
				transition: "binding_active",
				provider: "discord",
				intentId: "intent-1",
				bindingId: "binding-1",
				remoteChannelId: "456",
				fence: 0,
				state: "active",
			}),
			frame(2, "memory_activity", memoryPayload("dampingtest")),
		]);
		await runtime.refreshFromStore();
		await runtime.waitForIdle(5_000);
		expect(prompts.length).toBeGreaterThanOrEqual(1);
	});
});
