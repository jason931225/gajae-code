import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { YAML } from "bun";

describe("Settings global model role durability", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;
	let configPath: string;

	beforeEach(async () => {
		resetSettingsForTest();
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-settings-global-model-role-"));
		agentDir = path.join(testDir, "agent");
		projectDir = path.join(testDir, "project");
		configPath = path.join(agentDir, "config.yml");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(projectDir, { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("persists the canonical global selector without changing a runtime override", async () => {
		// Given
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.overrideModelRoles({ default: "profile/runtime:high" });

		// When
		await settings.setGlobalModelRoleAndFlush("default", "provider/selected:medium");

		// Then
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/selected:medium" },
		});
		expect(settings.getModelRole("default")).toBe("profile/runtime:high");
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider/selected:medium" });
	});

	it("removes a restored default selector without changing other durable roles", async () => {
		// Given
		await Bun.write(
			configPath,
			YAML.stringify({ modelRoles: { default: "provider/selected:medium", planner: "planner/model:high" } }),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		// When
		await settings.setGlobalModelRoleAndFlush("default", undefined);

		// Then
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { planner: "planner/model:high" },
		});
		expect(settings.getGlobal("modelRoles")).toEqual({ planner: "planner/model:high" });
	});

	it("rejects an older restore when direct model roles change during its durable flush", async () => {
		// Given: selection A starts durably committing B.
		await Bun.write(
			configPath,
			YAML.stringify({ modelRoles: { default: "provider/original:low", planner: "planner/original:medium" } }),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const originalWrite = Bun.write.bind(Bun);
		const firstConfigWrite = Promise.withResolvers<void>();
		const continueFirstConfigWrite = Promise.withResolvers<void>();
		let configWrite = 0;
		vi.spyOn(Bun, "write").mockImplementation(async (destination, input) => {
			if (typeof destination !== "string" || typeof input !== "string") {
				throw new Error("unexpected non-string settings write");
			}
			if (destination !== configPath) return originalWrite(destination, input);
			configWrite += 1;
			if (configWrite === 1) {
				firstConfigWrite.resolve();
				await continueFirstConfigWrite.promise;
			}
			return originalWrite(destination, input);
		});

		const selection = settings.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");
		await firstConfigWrite.promise;

		// When: direct writer C commits while B's durable flush remains pending.
		const newerRoles = {
			default: "provider/selection-c:medium",
			planner: "planner/original:medium",
			reviewer: "reviewer/newer:low",
		};
		settings.set("modelRoles", newerRoles);
		continueFirstConfigWrite.resolve();
		const commit = await selection;
		const restored = await settings.restoreGlobalDefaultModelRoleIfCurrent(commit);
		await settings.flush();

		// Then: A cannot replace C or discard C's unrelated role in memory or YAML.
		expect(restored).toBe(false);
		expect(settings.getGlobal("modelRoles")).toEqual(newerRoles);
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ modelRoles: newerRoles });
	});

	it("restores an absent original default without changing unrelated durable roles", async () => {
		// Given
		await Bun.write(configPath, YAML.stringify({ modelRoles: { planner: "planner/original:medium" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const commit = await settings.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");
		expect(commit).toEqual({ previousDefault: undefined, defaultRevision: expect.any(Number) });

		// When
		const restored = await settings.restoreGlobalDefaultModelRoleIfCurrent(commit);

		// Then
		expect(restored).toBe(true);
		expect(settings.getGlobal("modelRoles")).toEqual({ planner: "planner/original:medium" });
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { planner: "planner/original:medium" },
		});
	});

	it("restores the committed default after a planner-only helper update", async () => {
		// Given: selection A durably commits B while planner retains an independent role.
		await Bun.write(
			configPath,
			YAML.stringify({ modelRoles: { default: "provider/original:low", planner: "planner/original:medium" } }),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const commit = await settings.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");

		// When: an unrelated helper update writes planner before B must be rolled back.
		settings.setModelRole("planner", "planner/newer:medium");
		const restored = await settings.restoreGlobalDefaultModelRoleIfCurrent(commit);

		// Then: recovery owns A while preserving planner Q in memory and YAML.
		expect(restored).toBe(true);
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "provider/original:low",
			planner: "planner/newer:medium",
		});
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/original:low", planner: "planner/newer:medium" },
		});
	});

	it("treats helper writes and same-value ABA as newer default revisions", async () => {
		// Given
		await Bun.write(
			configPath,
			YAML.stringify({ modelRoles: { default: "provider/original:low", planner: "planner/original:medium" } }),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const commit = await settings.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");

		// When: helper mutations return the default to B after an A/B ABA sequence.
		settings.setGlobalModelRole("planner", "planner/newer:medium");
		settings.setGlobalModelRole("default", "provider/original:low");
		settings.setGlobalModelRole("default", "provider/selection-b:high");
		await settings.flush();
		const restored = await settings.restoreGlobalDefaultModelRoleIfCurrent(commit);

		// Then: matching the prior value is insufficient ownership to restore it.
		expect(restored).toBe(false);
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "provider/selection-b:high",
			planner: "planner/newer:medium",
		});
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/selection-b:high", planner: "planner/newer:medium" },
		});
	});

	it("rolls back a rejected selector so an unrelated later save cannot retry it", async () => {
		// Given
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const originalWrite = Bun.write.bind(Bun);
		let rejectConfigWrite = true;
		vi.spyOn(Bun, "write").mockImplementation(async (destination, input) => {
			if (typeof destination === "string" && destination === configPath && rejectConfigWrite) {
				rejectConfigWrite = false;
				throw new Error("injected config write failure");
			}
			if (typeof destination !== "string" || typeof input !== "string") {
				throw new Error("unexpected non-string settings write");
			}
			return originalWrite(destination, input);
		});

		// When
		const rejected = settings.setGlobalModelRoleAndFlush("default", "provider/rejected:high");

		// Then
		await expect(rejected).rejects.toThrow("injected config write failure");
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider/original:low" });
		expect(settings.getModelRole("default")).toBe("provider/original:low");

		settings.set("theme.dark", "amber-claw");
		await settings.flush();
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/original:low" },
			theme: { dark: "amber-claw" },
		});
	});

	it("preserves a newer selector when an older queued selector is rejected", async () => {
		// Given
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const originalWrite = Bun.write.bind(Bun);
		const predecessorWrite = Promise.withResolvers<void>();
		let configWrite = 0;
		vi.spyOn(Bun, "write").mockImplementation(async (destination, input) => {
			if (typeof destination !== "string" || typeof input !== "string") {
				throw new Error("unexpected non-string settings write");
			}
			if (destination !== configPath) return originalWrite(destination, input);
			configWrite += 1;
			if (configWrite === 1) {
				await predecessorWrite.promise;
			} else if (configWrite === 2) {
				throw new Error("injected older selector failure");
			}
			return originalWrite(destination, input);
		});

		settings.set("theme.dark", "predecessor-claw");
		const predecessor = settings.flush();
		const older = settings.setGlobalModelRoleAndFlush("default", "provider/rejected:high");
		const newer = settings.setGlobalModelRoleAndFlush("default", "provider/newer:medium");

		// When
		predecessorWrite.resolve();

		// Then
		await predecessor;
		await expect(older).rejects.toThrow("injected older selector failure");
		await newer;
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider/newer:medium" });
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/newer:medium" },
			theme: { dark: "predecessor-claw" },
		});
	});

	it("rolls both overlapping rejected selectors back before an unrelated save", async () => {
		// Given
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.overrideModelRoles({ planner: "profile/planner:high" });
		const originalWrite = Bun.write.bind(Bun);
		const predecessorWrite = Promise.withResolvers<void>();
		let configWrite = 0;
		vi.spyOn(Bun, "write").mockImplementation(async (destination, input) => {
			if (typeof destination !== "string" || typeof input !== "string") {
				throw new Error("unexpected non-string settings write");
			}
			if (destination !== configPath) return originalWrite(destination, input);
			configWrite += 1;
			if (configWrite === 1) await predecessorWrite.promise;
			if (configWrite === 2 || configWrite === 3) {
				throw new Error(`injected selector failure ${configWrite}`);
			}
			return originalWrite(destination, input);
		});

		settings.set("theme.dark", "predecessor-claw");
		const predecessor = settings.flush();
		const older = settings.setGlobalModelRoleAndFlush("default", "provider/older-rejected:high");
		const newer = settings.setGlobalModelRoleAndFlush("default", "provider/newer-rejected:medium");
		const selections = Promise.allSettled([older, newer]);

		// When
		predecessorWrite.resolve();

		// Then
		await predecessor;
		expect((await selections).map(result => result.status)).toEqual(["rejected", "rejected"]);
		settings.set("theme.dark", "red-claw");
		await settings.flush();
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/original:low" },
			theme: { dark: "red-claw" },
		});
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider/original:low" });
		expect(settings.get("modelRoles")).toEqual({
			default: "provider/original:low",
			planner: "profile/planner:high",
		});
	});

	it("does not re-dirty a patch after an earlier duplicate save has persisted it", async () => {
		// Given: two queued saves that snapshot the same patch before the first write settles.
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const originalWrite = Bun.write.bind(Bun);
		const firstWrite = Promise.withResolvers<void>();
		let configWrite = 0;
		vi.spyOn(Bun, "write").mockImplementation(async (destination, input) => {
			if (typeof destination !== "string" || typeof input !== "string") {
				throw new Error("unexpected non-string settings write");
			}
			if (destination !== configPath) return originalWrite(destination, input);
			configWrite += 1;
			if (configWrite === 1) await firstWrite.promise;
			if (configWrite === 2) throw new Error("injected duplicate save failure");
			return originalWrite(destination, input);
		});

		settings.set("theme.dark", "red-claw");
		const first = settings.flush();
		const duplicate = settings.flush();

		// When: the first snapshot persists, then the obsolete duplicate snapshot fails.
		firstWrite.resolve();
		await first;
		await duplicate;
		await Bun.write(configPath, YAML.stringify({}));
		settings.set("theme.light", "blue-crab");
		await settings.flush();

		// Then: a later unrelated save cannot replay the stale, already-persisted patch.
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ theme: { light: "blue-crab" } });
	});
});
