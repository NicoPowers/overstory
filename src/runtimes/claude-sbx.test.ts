// Unit tests for the claude-sbx runtime adapter.
//
// Real-vs-mock policy: the only thing we mock is the `sbx` CLI itself
// (the unit test path must not boot real microVMs). Everything else —
// filesystem, env vars, argv composition — uses real implementations
// per the project test philosophy in CLAUDE.md.
//
// The fake `sbx` shim is a tiny TypeScript runner installed onto PATH
// for the duration of each test. It logs every invocation to a file
// the test can assert against, and emits canned stdout/exitCode driven
// by env vars set by the test.
//
// Real-VM acceptance is gated behind OV_SBX_INTEGRATION=1 (see
// docs/sbx.md) and not exercised here.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSbxKitPaths } from "../commands/sling.ts";
import { ClaudeRuntime } from "./claude.ts";
import {
	buildSbxExecArgv,
	ClaudeSbxRuntime,
	hostPathToVmPath,
	runSbx,
	sbxVmExists,
} from "./claude-sbx.ts";
import type { DirectSpawnOpts } from "./types.ts";

describe("hostPathToVmPath", () => {
	it("translates a Windows drive-letter path with backslashes", () => {
		expect(hostPathToVmPath("C:\\Users\\nicol\\OneDrive\\overstory")).toBe(
			"/c/Users/nicol/OneDrive/overstory",
		);
	});

	it("translates a Windows drive-letter path with forward slashes", () => {
		expect(hostPathToVmPath("D:/projects/overstory")).toBe("/d/projects/overstory");
	});

	it("lowercases the drive letter", () => {
		expect(hostPathToVmPath("Z:\\foo")).toBe("/z/foo");
	});

	it("handles a bare drive root", () => {
		expect(hostPathToVmPath("C:")).toBe("/c");
		expect(hostPathToVmPath("C:\\")).toBe("/c");
	});

	it("returns POSIX paths unchanged (identity on macOS / Linux)", () => {
		expect(hostPathToVmPath("/Users/alice/code/overstory")).toBe("/Users/alice/code/overstory");
		expect(hostPathToVmPath("/home/agent/workspace")).toBe("/home/agent/workspace");
	});

	it("returns the empty string unchanged", () => {
		expect(hostPathToVmPath("")).toBe("");
	});

	it("leaves UNC / unrecognized strings untouched rather than mangling them", () => {
		expect(hostPathToVmPath("\\\\server\\share")).toBe("\\\\server\\share");
		expect(hostPathToVmPath("not-a-path")).toBe("not-a-path");
	});
});

describe("buildSbxExecArgv", () => {
	it("composes sbx exec wrapper around inner argv with no shell interpolation", () => {
		const argv = buildSbxExecArgv({
			agentName: "builder-task-42",
			vmCwd: "/c/Users/alice/work",
			innerArgv: ["claude", "-p", "--output-format", "stream-json"],
		});

		expect(argv).toEqual([
			"sbx",
			"exec",
			"builder-task-42",
			"--",
			"bash",
			"-lc",
			'cd "$1" && shift && exec "$@"',
			"bash",
			"/c/Users/alice/work",
			"claude",
			"-p",
			"--output-format",
			"stream-json",
		]);
	});

	it("preserves prompt-bearing flags verbatim — no quoting required (Tracer 1 §9a)", () => {
		// The PowerShell quoting bug only happens when prompts go through a
		// host shell. Bun.spawn with an argv array does not invoke any host
		// shell, and bash's "$@" preserves elements verbatim.
		const argv = buildSbxExecArgv({
			agentName: "x",
			vmCwd: "/c/x",
			innerArgv: [
				"claude",
				"--append-system-prompt",
				"This is a multi word prompt with 'quotes' and $vars.",
			],
		});

		expect(argv[argv.length - 1]).toBe("This is a multi word prompt with 'quotes' and $vars.");
	});
});

// ---------------------------------------------------------------------------
// Fake sbx shim — installed via the OV_SBX_BIN env var for tests that
// need to observe the argv passed to `sbx` (and assert exit codes /
// stdout). We avoid PATH manipulation because Bun.spawn on Windows does
// not consistently honor PATHEXT for `.cmd` files placed on a runtime-
// updated PATH; the explicit binary path env-var override is reliable
// across both POSIX and Windows.
// ---------------------------------------------------------------------------

interface ShimContext {
	binDir: string;
	logPath: string;
	shimJsPath: string;
	originalSbxBin: string | undefined;
}

/**
 * Install a fake `sbx` shim and point the runtime adapter at it via
 * `OV_SBX_BIN`. The shim:
 *   1. Appends each invocation's argv as a JSON line to `logPath`.
 *   2. Writes the SBX_FAKE_STDOUT env var (if set) to stdout.
 *   3. Exits with the SBX_FAKE_EXIT env var (if set, default 0).
 *
 * Implementation is a tiny shell wrapper that re-execs into `bun
 * shim.js`. The wrapper is what ends up in `OV_SBX_BIN` because
 * `Bun.spawn` on Windows expects a real .exe / .cmd / .bat at the
 * resolved path, not a bare .js file.
 */
async function installSbxShim(): Promise<ShimContext> {
	const binDir = await mkdtemp(join(tmpdir(), "ov-sbx-shim-"));
	const logPath = join(binDir, "calls.log");
	const shimJsPath = join(binDir, "shim.js");

	const shimJs = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(argv) + "\\n");
const out = process.env.SBX_FAKE_STDOUT;
if (typeof out === "string" && out.length > 0) {
	process.stdout.write(out);
}
const exit = Number.parseInt(process.env.SBX_FAKE_EXIT ?? "0", 10);
process.exit(Number.isNaN(exit) ? 0 : exit);
`;
	await writeFile(shimJsPath, shimJs);

	let binPath: string;
	if (process.platform === "win32") {
		binPath = join(binDir, "sbx.cmd");
		const cmd = ["@echo off", `bun "${shimJsPath}" %*`].join("\r\n");
		await writeFile(binPath, cmd);
	} else {
		binPath = join(binDir, "sbx");
		const sh = ["#!/usr/bin/env bash", `exec bun "${shimJsPath}" "$@"`].join("\n");
		await writeFile(binPath, sh, { mode: 0o755 });
	}

	const originalSbxBin = process.env.OV_SBX_BIN;
	process.env.OV_SBX_BIN = binPath;

	return { binDir, logPath, shimJsPath, originalSbxBin };
}

async function uninstallSbxShim(ctx: ShimContext): Promise<void> {
	if (ctx.originalSbxBin === undefined) {
		delete process.env.OV_SBX_BIN;
	} else {
		process.env.OV_SBX_BIN = ctx.originalSbxBin;
	}
	delete process.env.SBX_FAKE_STDOUT;
	delete process.env.SBX_FAKE_EXIT;
	await rm(ctx.binDir, { recursive: true, force: true });
}

async function readShimCalls(ctx: ShimContext): Promise<string[][]> {
	const file = Bun.file(ctx.logPath);
	if (!(await file.exists())) return [];
	const text = await file.text();
	return text
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as string[]);
}

describe("runSbx (with fake shim)", () => {
	let ctx: ShimContext;
	beforeEach(async () => {
		ctx = await installSbxShim();
	});
	afterEach(async () => {
		await uninstallSbxShim(ctx);
	});

	it("invokes sbx with the given args and captures stdout + exit", async () => {
		process.env.SBX_FAKE_STDOUT = "hello from sbx";
		process.env.SBX_FAKE_EXIT = "0";

		const result = await runSbx(["ls", "--json"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello from sbx");
		const calls = await readShimCalls(ctx);
		expect(calls).toEqual([["ls", "--json"]]);
	});

	it("propagates a non-zero exit code without throwing", async () => {
		process.env.SBX_FAKE_EXIT = "7";

		const result = await runSbx(["stop", "missing-vm"]);

		expect(result.exitCode).toBe(7);
	});
});

describe("sbxVmExists (with fake shim)", () => {
	let ctx: ShimContext;
	beforeEach(async () => {
		ctx = await installSbxShim();
	});
	afterEach(async () => {
		await uninstallSbxShim(ctx);
	});

	it("returns true when an entry with the given name is present in `sbx ls --json`", async () => {
		process.env.SBX_FAKE_STDOUT = JSON.stringify([
			{ name: "other-agent", status: "stopped" },
			{ name: "builder-foo", status: "running" },
		]);
		expect(await sbxVmExists("builder-foo")).toBe(true);
	});

	it("accepts the wrapped { sandboxes: [...] } shape used by sbx v0.28.x", async () => {
		process.env.SBX_FAKE_STDOUT = JSON.stringify({
			sandboxes: [
				{ name: "builder-baz", agent: "claude", status: "running" },
				{ name: "scout-quux", agent: "claude", status: "stopped" },
			],
		});
		expect(await sbxVmExists("builder-baz")).toBe(true);
		expect(await sbxVmExists("scout-quux")).toBe(true);
		expect(await sbxVmExists("not-here")).toBe(false);
	});

	it("returns false when no entry matches", async () => {
		process.env.SBX_FAKE_STDOUT = JSON.stringify([{ name: "other-agent" }]);
		expect(await sbxVmExists("builder-foo")).toBe(false);
	});

	it("returns false on malformed JSON output", async () => {
		process.env.SBX_FAKE_STDOUT = "not json";
		expect(await sbxVmExists("anything")).toBe(false);
	});

	it("returns false when sbx ls fails", async () => {
		process.env.SBX_FAKE_EXIT = "1";
		expect(await sbxVmExists("anything")).toBe(false);
	});
});

describe("ClaudeSbxRuntime", () => {
	const runtime = new ClaudeSbxRuntime();

	it("declares the expected static identity", () => {
		expect(runtime.id).toBe("claude-sbx");
		expect(runtime.stability).toBe("experimental");
		expect(runtime.headless).toBe(true);
		expect(runtime.instructionPath).toBe(".claude/CLAUDE.md");
	});

	it("detectReady is always ready (headless)", () => {
		expect(runtime.detectReady("")).toEqual({ phase: "ready" });
		expect(runtime.detectReady("anything")).toEqual({ phase: "ready" });
	});

	it("requiresBeaconVerification is false (no tmux beacon loop)", () => {
		expect(runtime.requiresBeaconVerification()).toBe(false);
	});

	it("parseTranscript returns null (transcript lives inside the VM)", async () => {
		expect(await runtime.parseTranscript("/anywhere")).toBeNull();
	});

	it("getTranscriptDir returns null (Tracer 2 does not extract VM transcripts)", () => {
		expect(runtime.getTranscriptDir("/anywhere")).toBeNull();
	});

	it("delegates buildPrintCommand to ClaudeRuntime so AI-assisted host calls keep working", () => {
		const inner = new ClaudeRuntime();
		expect(runtime.buildPrintCommand("hello", "sonnet")).toEqual(
			inner.buildPrintCommand("hello", "sonnet"),
		);
	});

	describe("buildDirectSpawn", () => {
		it("wraps the inner claude argv with sbx exec + cd shim", () => {
			const argv = runtime.buildDirectSpawn({
				cwd: "C:\\Users\\nicol\\worktree",
				env: {
					OVERSTORY_AGENT_NAME: "builder-task-1",
					OVERSTORY_WORKTREE_PATH: "C:\\Users\\nicol\\worktree",
				},
				instructionPath: ".claude/CLAUDE.md",
			} as DirectSpawnOpts);

			// Outer prefix from buildSbxExecArgv
			expect(argv.slice(0, 4)).toEqual(["sbx", "exec", "builder-task-1", "--"]);
			// Worktree path translated to VM form
			expect(argv).toContain("/c/Users/nicol/worktree");
			// Inner claude argv flags must all be present (delegated)
			expect(argv).toContain("claude");
			expect(argv).toContain("-p");
			expect(argv).toContain("stream-json");
			expect(argv).toContain("--permission-mode");
			expect(argv).toContain("bypassPermissions");
		});

		it("threads --resume on follow-up turns (delegated to ClaudeRuntime)", () => {
			const argv = runtime.buildDirectSpawn({
				cwd: "/Users/alice/wt",
				env: {
					OVERSTORY_AGENT_NAME: "x",
					OVERSTORY_WORKTREE_PATH: "/Users/alice/wt",
				},
				instructionPath: ".claude/CLAUDE.md",
				resumeSessionId: "sess-abc-123",
			} as DirectSpawnOpts);

			const idx = argv.indexOf("--resume");
			expect(idx).toBeGreaterThan(-1);
			expect(argv[idx + 1]).toBe("sess-abc-123");
		});

		it("throws when OVERSTORY_AGENT_NAME is missing (turn-runner contract)", () => {
			expect(() =>
				runtime.buildDirectSpawn({
					cwd: "/x",
					env: { OVERSTORY_WORKTREE_PATH: "/x" },
					instructionPath: ".claude/CLAUDE.md",
				} as DirectSpawnOpts),
			).toThrow(/OVERSTORY_AGENT_NAME/);
		});

		it("throws when OVERSTORY_WORKTREE_PATH is missing (turn-runner contract)", () => {
			expect(() =>
				runtime.buildDirectSpawn({
					cwd: "/x",
					env: { OVERSTORY_AGENT_NAME: "x" },
					instructionPath: ".claude/CLAUDE.md",
				} as DirectSpawnOpts),
			).toThrow(/OVERSTORY_WORKTREE_PATH/);
		});
	});

	describe("prepareWorktree (with fake shim)", () => {
		let ctx: ShimContext;
		beforeEach(async () => {
			ctx = await installSbxShim();
		});
		afterEach(async () => {
			await uninstallSbxShim(ctx);
		});

		it("creates the VM when sbx ls reports it does not exist", async () => {
			process.env.SBX_FAKE_STDOUT = "[]"; // ls returns no matching entries
			process.env.SBX_FAKE_EXIT = "0";

			const worktree =
				process.platform === "win32"
					? "C:\\Users\\nicol\\worktrees\\builder-foo"
					: "/tmp/wt/builder-foo";
			await runtime.prepareWorktree(worktree);

			const calls = await readShimCalls(ctx);
			// Two calls: ls --json, then create.
			expect(calls.length).toBe(2);
			expect(calls[0]).toEqual(["ls", "--json"]);
			expect(calls[1]?.[0]).toBe("create");
			expect(calls[1]).toContain("--name");
			expect(calls[1]).toContain("builder-foo");
			expect(calls[1]).toContain(worktree);
		});

		it("is a no-op when the VM already exists (idempotent)", async () => {
			process.env.SBX_FAKE_STDOUT = JSON.stringify([{ name: "builder-bar" }]);

			const worktree =
				process.platform === "win32"
					? "C:\\Users\\nicol\\worktrees\\builder-bar"
					: "/tmp/wt/builder-bar";
			await runtime.prepareWorktree(worktree);

			const calls = await readShimCalls(ctx);
			expect(calls.length).toBe(1); // only the ls call
			expect(calls[0]).toEqual(["ls", "--json"]);
		});

		it("respects OVERSTORY_SBX_TEMPLATE override", async () => {
			process.env.SBX_FAKE_STDOUT = "[]";
			process.env.OVERSTORY_SBX_TEMPLATE = "overstory/sbx-base:0.1";
			try {
				const worktree =
					process.platform === "win32"
						? "C:\\Users\\nicol\\worktrees\\builder-tmpl"
						: "/tmp/wt/builder-tmpl";
				await runtime.prepareWorktree(worktree);
				const calls = await readShimCalls(ctx);
				const create = calls.find((c) => c[0] === "create");
				expect(create).toBeDefined();
				expect(create).toContain("overstory/sbx-base:0.1");
			} finally {
				delete process.env.OVERSTORY_SBX_TEMPLATE;
			}
		});

		it("throws a useful error when sbx create fails", async () => {
			process.env.SBX_FAKE_STDOUT = "[]";
			process.env.SBX_FAKE_EXIT = "0"; // ls succeeds with empty list
			// Switch the failure on for the second call by using a stateful shim env.
			// Simpler: just set EXIT=2 globally — `ls` then returns 2 and we end up
			// in the "VM does not exist" branch (good), then create returns 2 too.
			process.env.SBX_FAKE_EXIT = "2";

			const worktree =
				process.platform === "win32"
					? "C:\\Users\\nicol\\worktrees\\builder-fail"
					: "/tmp/wt/builder-fail";

			await expect(runtime.prepareWorktree(worktree)).rejects.toThrow(/failed to create VM/);
		});

		it("rejects worktree paths from which an agent name cannot be derived", async () => {
			await expect(runtime.prepareWorktree("")).rejects.toThrow(/cannot derive agent name/);
			// "/" has no basename after filtering empty segments.
			await expect(runtime.prepareWorktree("/")).rejects.toThrow(/cannot derive agent name/);
		});
	});

	describe("stopAgent (with fake shim)", () => {
		let ctx: ShimContext;
		beforeEach(async () => {
			ctx = await installSbxShim();
		});
		afterEach(async () => {
			await uninstallSbxShim(ctx);
		});

		it("issues stop then rm and ignores non-zero exit codes", async () => {
			process.env.SBX_FAKE_EXIT = "3"; // simulate a partially-cleaned VM

			await runtime.stopAgent("builder-baz");

			const calls = await readShimCalls(ctx);
			expect(calls.length).toBe(2);
			expect(calls[0]).toEqual(["stop", "builder-baz"]);
			expect(calls[1]).toEqual(["rm", "builder-baz"]);
		});
	});

	describe("setKitPaths / kitPaths", () => {
		it("defaults to an empty kit list", () => {
			const r = new ClaudeSbxRuntime();
			expect(r.kitPaths).toEqual([]);
		});

		it("setKitPaths replaces the list", () => {
			const r = new ClaudeSbxRuntime();
			r.setKitPaths(["/kits/base", "/kits/network-strict"]);
			expect(r.kitPaths).toEqual(["/kits/base", "/kits/network-strict"]);
		});

		it("setKitPaths with empty list clears previous entries", () => {
			const r = new ClaudeSbxRuntime();
			r.setKitPaths(["/kits/base"]);
			r.setKitPaths([]);
			expect(r.kitPaths).toEqual([]);
		});
	});

	describe("prepareWorktree with kits (fake shim)", () => {
		let ctx: ShimContext;
		beforeEach(async () => {
			ctx = await installSbxShim();
		});
		afterEach(async () => {
			await uninstallSbxShim(ctx);
		});

		it("passes --kit flags to sbx create in declaration order", async () => {
			process.env.SBX_FAKE_STDOUT = "[]"; // ls: no existing VM
			process.env.SBX_FAKE_EXIT = "0";

			const r = new ClaudeSbxRuntime();
			r.setKitPaths(["/kits/base", "/kits/read-only", "/kits/network-strict"]);

			const worktree =
				process.platform === "win32"
					? "C:\\Users\\nicol\\worktrees\\scout-task-7"
					: "/tmp/wt/scout-task-7";
			await r.prepareWorktree(worktree);

			const calls = await readShimCalls(ctx);
			const create = calls.find((c) => c[0] === "create");
			expect(create).toBeDefined();
			if (!create) return;
			// Kit flags must appear before the template name in the correct order.
			const kitIdx = create.indexOf("--kit");
			expect(kitIdx).toBeGreaterThan(-1);
			expect(create[kitIdx + 1]).toBe("/kits/base");
			expect(create[kitIdx + 2]).toBe("--kit");
			expect(create[kitIdx + 3]).toBe("/kits/read-only");
			expect(create[kitIdx + 4]).toBe("--kit");
			expect(create[kitIdx + 5]).toBe("/kits/network-strict");
		});

		it("passes no --kit flags when kitPaths is empty (--no-sandbox / bare template)", async () => {
			process.env.SBX_FAKE_STDOUT = "[]";
			process.env.SBX_FAKE_EXIT = "0";

			const r = new ClaudeSbxRuntime();
			// kitPaths defaults to [] — bare template

			const worktree =
				process.platform === "win32"
					? "C:\\Users\\nicol\\worktrees\\builder-bare"
					: "/tmp/wt/builder-bare";
			await r.prepareWorktree(worktree);

			const calls = await readShimCalls(ctx);
			const create = calls.find((c) => c[0] === "create");
			expect(create).toBeDefined();
			expect(create).not.toContain("--kit");
		});

		it("passes two --kit flags for builder capability (base + network-dev)", async () => {
			process.env.SBX_FAKE_STDOUT = "[]";
			process.env.SBX_FAKE_EXIT = "0";

			const r = new ClaudeSbxRuntime();
			r.setKitPaths(["/kits/base", "/kits/network-dev"]);

			const worktree =
				process.platform === "win32"
					? "C:\\Users\\nicol\\worktrees\\builder-task-9"
					: "/tmp/wt/builder-task-9";
			await r.prepareWorktree(worktree);

			const calls = await readShimCalls(ctx);
			const create = calls.find((c) => c[0] === "create");
			expect(create).toBeDefined();
			if (!create) return;
			// Exactly two --kit occurrences.
			const kitCount = create.filter((arg) => arg === "--kit").length;
			expect(kitCount).toBe(2);
			const firstKitIdx = create.indexOf("--kit");
			expect(create[firstKitIdx + 1]).toBe("/kits/base");
			expect(create[firstKitIdx + 3]).toBe("/kits/network-dev");
		});
	});
});

// ---------------------------------------------------------------------------
// resolveSbxKitPaths — unit tests for the sling helper
// ---------------------------------------------------------------------------

describe("resolveSbxKitPaths", () => {
	const fakeTemplatesDir = "/pkg/templates";

	it("returns empty list when --no-sandbox is set", () => {
		expect(
			resolveSbxKitPaths({
				noSandbox: true,
				manifestKits: ["base", "read-only"],
				pkgTemplatesDir: fakeTemplatesDir,
			}),
		).toEqual([]);
	});

	it("--kit replaces the manifest list", () => {
		const result = resolveSbxKitPaths({
			kit: ["/custom/kit-a"],
			manifestKits: ["base", "network-strict"],
			pkgTemplatesDir: fakeTemplatesDir,
		});
		expect(result).toEqual(["/custom/kit-a"]);
	});

	it("resolves manifest kit names to absolute package paths", () => {
		const result = resolveSbxKitPaths({
			manifestKits: ["base", "network-strict"],
			pkgTemplatesDir: fakeTemplatesDir,
		});
		expect(result).toEqual([
			join(fakeTemplatesDir, "sbx-kits", "base"),
			join(fakeTemplatesDir, "sbx-kits", "network-strict"),
		]);
	});

	it("--add-kit appends to manifest-resolved paths", () => {
		const result = resolveSbxKitPaths({
			manifestKits: ["base"],
			addKit: ["/extra/kit"],
			pkgTemplatesDir: fakeTemplatesDir,
		});
		expect(result).toEqual([join(fakeTemplatesDir, "sbx-kits", "base"), "/extra/kit"]);
	});

	it("--add-kit appends to --kit paths (not manifest)", () => {
		const result = resolveSbxKitPaths({
			kit: ["/override"],
			addKit: ["/extra"],
			manifestKits: ["base"],
			pkgTemplatesDir: fakeTemplatesDir,
		});
		expect(result).toEqual(["/override", "/extra"]);
	});

	it("returns empty list when no kits specified and manifest has none", () => {
		expect(resolveSbxKitPaths({ pkgTemplatesDir: fakeTemplatesDir })).toEqual([]);
	});

	it("--no-sandbox overrides --kit and --add-kit", () => {
		expect(
			resolveSbxKitPaths({
				noSandbox: true,
				kit: ["/should-be-ignored"],
				addKit: ["/also-ignored"],
				pkgTemplatesDir: fakeTemplatesDir,
			}),
		).toEqual([]);
	});
});
