import { describe, expect, test } from "bun:test";
import type { ProviderEffectLease, ProviderEffectResultFrame } from "../src/master/sdk-contract";
import {
	type DiscordMasterChannelAdapter,
	DiscordMasterChannelWorker,
} from "../src/sdk/bus/discord-master-channel-worker";
import type { DiscordThread } from "../src/sdk/bus/discord-provider";
import type { MasterDaemonWorkerClientLike } from "../src/sdk/bus/master-daemon-client";

class FakeBindingProvider implements DiscordMasterChannelAdapter {
	#ctx = "ok";
	readonly calls: string[] = [];

	async findThreadByNonce(input: {
		guildId: string;
		parentId: string;
		nonce: string;
	}): Promise<DiscordThread | null> {
		void this.#ctx;
		this.calls.push(`findThreadByNonce:${input.nonce}`);
		return null;
	}

	async createThread(input: {
		guildId: string;
		parentId: string;
		name: string;
		nonce: string;
	}): Promise<DiscordThread> {
		void this.#ctx;
		this.calls.push(`createThread:${input.nonce}`);
		return { id: "thread-1", guildId: input.guildId, parentId: input.parentId, archived: false };
	}

	async confirmThreadDeleted(input: { threadId: string }): Promise<boolean> {
		void this.#ctx;
		this.calls.push(`confirmThreadDeleted:${input.threadId}`);
		return true;
	}
}

class FakeWorkerClient implements MasterDaemonWorkerClientLike {
	readonly results: ProviderEffectResultFrame[] = [];

	onFrame(): () => void {
		return () => undefined;
	}

	async submitEffectResult(frame: ProviderEffectResultFrame): Promise<void> {
		this.results.push(frame);
	}
}

function futureExpiry(): string {
	return new Date(Date.now() + 60_000).toISOString();
}

function provisionLease(
	overrides: Partial<Extract<ProviderEffectLease, { kind: "provision_channel" }>> = {},
): Extract<ProviderEffectLease, { kind: "provision_channel" }> {
	return {
		effectId: "effect-1",
		intentId: "intent-1",
		leaseId: "lease-1",
		masterName: "alpha",
		provider: "discord",
		fence: 0,
		nonce: "nonce-create",
		expiresAt: futureExpiry(),
		kind: "provision_channel",
		operation: "create",
		channelName: "GJC session",
		previousRemoteChannelId: null,
		...overrides,
	};
}

describe("DiscordMasterChannelWorker provider this-binding", () => {
	test("unbound extraction of class methods loses this and fails provision", async () => {
		const provider = new FakeBindingProvider();
		const unbound = provider.findThreadByNonce;
		await expect(unbound({ guildId: "guild", parentId: "parent", nonce: "n" })).rejects.toThrow(
			/undefined is not an object|Cannot read (properties|private member)/i,
		);
	});

	test("create provision keeps this when findThreadByNonce is a class method", async () => {
		const provider = new FakeBindingProvider();
		const client = new FakeWorkerClient();
		const worker = new DiscordMasterChannelWorker({
			client,
			provider,
			guildId: "guild",
			parentChannelId: "parent",
			requestId: () => "req-create",
		});

		const frame = await worker.handleEffect(provisionLease());

		expect(frame.outcome).toEqual({
			effectKind: "provision_channel",
			status: "succeeded",
			remoteEffectId: "discord-thread:thread-1",
			remoteChannelId: "thread-1",
			reconciled: false,
		});
		expect(provider.calls).toEqual(["findThreadByNonce:nonce-create", "createThread:nonce-create"]);
		expect(client.results).toHaveLength(1);
		expect(client.results[0]?.outcome).toEqual(frame.outcome);
	});

	test("replace provision keeps this when confirmThreadDeleted is a class method", async () => {
		const provider = new FakeBindingProvider();
		const client = new FakeWorkerClient();
		const worker = new DiscordMasterChannelWorker({
			client,
			provider,
			guildId: "guild",
			parentChannelId: "parent",
			requestId: () => "req-replace",
		});

		const frame = await worker.handleEffect(
			provisionLease({
				effectId: "effect-2",
				intentId: "intent-2",
				leaseId: "lease-2",
				nonce: "nonce-replace",
				operation: "replace",
				previousRemoteChannelId: "old-thread",
			}),
		);

		expect(frame.outcome).toEqual({
			effectKind: "provision_channel",
			status: "succeeded",
			remoteEffectId: "discord-thread:thread-1",
			remoteChannelId: "thread-1",
			reconciled: false,
		});
		expect(provider.calls).toEqual(["confirmThreadDeleted:old-thread", "createThread:nonce-replace"]);
		expect(client.results).toHaveLength(1);
		expect(client.results[0]?.outcome).toEqual(frame.outcome);
	});
});
