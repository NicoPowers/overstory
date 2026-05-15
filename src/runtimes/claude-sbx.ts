// Claude Code runtime adapter that wraps every subprocess in a Docker
// Sandbox (sbx) microVM. Tracer 2 of the docker-sbx isolation effort
// (NicoPowers/overstory#3 → upstream jayminwest/overstory#3).
//
// Design summary
// --------------
//   * Statically headless (`headless = true`). The orchestrator drives
//     it via the spawn-per-turn engine in `src/agents/turn-runner.ts`.
//     `--headless` / `--no-headless` flags are no-ops for this runtime.
//   * Each agent owns one named sbx VM. The VM is created lazily in
//     `prepareWorktree` and reused across turns; `stopAgent` tears it
//     down on `ov stop`.
//   * Per-turn `Bun.spawn` invokes `sbx exec <agentName> -- claude ...`
//     instead of bare `claude ...`. Argv is built by composing the
//     wrapped `ClaudeRuntime.buildDirectSpawn()` argv onto the sbx
//     prefix — never via shell interpolation (PowerShell quoting
//     destroyed multi-token prompts during the Tracer 1 spike, see
//     `docs/sbx-spike.md` §9a).
//   * Windows path translation: `C:\Users\foo` becomes `/c/Users/foo`
//     inside the VM. Identity on macOS/Linux. Implemented by the
//     exported `hostPathToVmPath()` helper and unit-tested.
//
// Out of scope for Tracer 2 (handled by later tracers):
//   * Per-capability kits / explicit network policy (Tracer 3).
//   * Skills allowlist (Tracer 4).
//   * Multi-agent mail concurrency proof (Tracer 5).
//   * Operator UX for nudge / attach / clean (Tracer 6).
//   * `ov doctor --category sandbox` + default-on flip (Tracer 7).

import type { ResolvedModel } from "../types.ts";
import { ClaudeRuntime } from "./claude.ts";
import type {
	AgentEvent,
	AgentRuntime,
	DirectSpawnOpts,
	HooksDef,
	OverlayContent,
	ReadyState,
	SpawnOpts,
	TranscriptSummary,
} from "./types.ts";

/**
 * Translate an absolute host path to the path the workspace mount appears
 * at inside an sbx VM.
 *
 * On Windows, sbx remaps drive-letter paths: `C:\Users\nicol\foo` becomes
 * `/c/Users/nicol/foo` (drive lowercased, backslashes flipped, prefixed
 * with `/`). On macOS / Linux the path is mounted at the same absolute
 * location, so this is identity.
 *
 * Inputs that are already POSIX-style (start with `/`) are returned
 * verbatim — they may already be VM paths or POSIX host paths.
 *
 * @param hostPath - Absolute path on the host filesystem.
 * @returns Absolute path inside the VM where the same bytes are visible.
 */
export function hostPathToVmPath(hostPath: string): string {
	if (hostPath.length === 0) return hostPath;
	// Already POSIX: no translation needed.
	if (hostPath.startsWith("/")) return hostPath;

	// Windows drive-letter form with a non-empty path tail: `C:\foo\bar`
	// or `C:/foo/bar`. (Bare drive roots are handled below.)
	const driveMatch = /^([A-Za-z]):[\\/](.+)$/.exec(hostPath);
	if (driveMatch) {
		const drive = (driveMatch[1] ?? "").toLowerCase();
		const rest = (driveMatch[2] ?? "").replace(/\\/g, "/");
		return `/${drive}/${rest}`;
	}

	// Bare drive root (`C:` or `C:\`).
	const bareDriveMatch = /^([A-Za-z]):[\\/]?$/.exec(hostPath);
	if (bareDriveMatch) {
		const drive = (bareDriveMatch[1] ?? "").toLowerCase();
		return `/${drive}`;
	}

	// UNC / unrecognized: leave untouched. Better to surface verbatim and
	// let the operator notice than to silently mangle.
	return hostPath;
}

/**
 * Resolve which command to invoke for `sbx`. Defaults to bare `"sbx"`
 * (let the OS resolve via PATH). Honors `OV_SBX_BIN` for unit tests
 * (and operators with non-standard install paths): when set, the value
 * is used verbatim as the executable path.
 *
 * Exported for unit-testing.
 */
export function resolveSbxBin(env: Record<string, string | undefined> = process.env): string {
	const override = env.OV_SBX_BIN?.trim();
	return override && override.length > 0 ? override : "sbx";
}

/**
 * Run a one-shot `sbx` subcommand. Returns `{ exitCode, stdout, stderr }`.
 * Never throws — callers decide how to react to a non-zero exit.
 *
 * Centralized for testability (the unit tests stub `sbx` via the
 * `OV_SBX_BIN` env var; integration paths leave it unset and use the
 * real binary on PATH).
 */
export async function runSbx(
	args: string[],
	opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	// Always pass env explicitly so updates made via process.env
	// (e.g. test fake-shim configuration) are guaranteed to be visible to
	// the spawned process. Bun.spawn defaults to a snapshot of process.env
	// at module load on some platforms; explicit pass-through avoids the
	// trap.
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		...(opts.env ?? {}),
	};
	// Pipe both stdout and stderr inline so TypeScript narrows the
	// subprocess handle to a ReadableStream rather than a number-or-stream
	// union (the union appears when `Bun.spawn` is called with a
	// non-literal options object).
	const proc = Bun.spawn([resolveSbxBin(), ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env,
		...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

/**
 * Check whether an sbx VM with the given name already exists by parsing
 * `sbx ls --json`. Returns false when the binary is missing, the call
 * fails, or no entry matches.
 *
 * Accepts both `sbx` output shapes observed in the wild:
 *   - The current shape: `{ "sandboxes": [{ "name": "...", ... }] }`
 *     (sbx v0.28.x).
 *   - A bare top-level array `[{ "name": "..." }, ...]` (older / future
 *     versions and the unit-test fake shim).
 *
 * Exported for unit-testing the JSON parser.
 */
export async function sbxVmExists(agentName: string): Promise<boolean> {
	const result = await runSbx(["ls", "--json"]);
	if (result.exitCode !== 0) return false;
	try {
		const parsed = JSON.parse(result.stdout) as unknown;
		let items: unknown[] = [];
		if (Array.isArray(parsed)) {
			items = parsed;
		} else if (parsed !== null && typeof parsed === "object") {
			const root = parsed as Record<string, unknown>;
			if (Array.isArray(root.sandboxes)) {
				items = root.sandboxes;
			}
		}
		for (const entry of items) {
			if (entry === null || typeof entry !== "object") continue;
			const obj = entry as Record<string, unknown>;
			if (typeof obj.name === "string" && obj.name === agentName) {
				return true;
			}
		}
	} catch {
		// Fall through — treat unparseable output as "not found" so we
		// re-create the VM rather than collide silently.
	}
	return false;
}

/**
 * Build the argv passed to `Bun.spawn` for one headless turn inside an
 * sbx VM. Mirrors `ClaudeRuntime.buildDirectSpawn` and prepends the sbx
 * exec prefix.
 *
 * The inner claude argv is constructed via a real `ClaudeRuntime` so we
 * inherit the canonical flag set (stream-json, --resume, etc.) without
 * re-implementing it. We also wrap the call in `bash -lc 'cd <vmPath>
 * && exec "$@"' bash claude ...` so the agent runs from the worktree
 * mount (sbx exec defaults to /home/agent).
 *
 * Exported for unit-testing.
 */
export function buildSbxExecArgv(opts: {
	agentName: string;
	vmCwd: string;
	innerArgv: string[];
}): string[] {
	// `bash -lc 'cd "$1" && shift && exec "$@"' bash <vmCwd> claude ...`
	// — the `$1` form is properly quoted by bash itself, so each element
	// in innerArgv is passed verbatim. No host-shell interpolation.
	const wrapper = 'cd "$1" && shift && exec "$@"';
	return [
		"sbx",
		"exec",
		opts.agentName,
		"--",
		"bash",
		"-lc",
		wrapper,
		"bash",
		opts.vmCwd,
		...opts.innerArgv,
	];
}

/**
 * Claude Code runtime adapter that runs every turn inside an sbx VM.
 *
 * Composes a real `ClaudeRuntime` for everything that does not depend on
 * the VM (overlay deployment, transcript / event parsing, env routing).
 * Owns only the sbx-specific pieces: VM provisioning, argv wrapping,
 * and lifecycle teardown.
 */
export class ClaudeSbxRuntime implements AgentRuntime {
	readonly id = "claude-sbx";
	readonly stability = "experimental" as const;
	readonly instructionPath = ".claude/CLAUDE.md";
	/** Statically headless — no tmux, no `--no-headless` escape hatch. */
	readonly headless = true;

	/**
	 * sbx template used by `prepareWorktree` when creating the VM.
	 *
	 * Tracer 2 uses sbx's built-in `claude` agent (which resolves to
	 * `docker/sandbox-templates:claude-code-docker` — already has the
	 * `claude` CLI and OAuth env wiring). Bun is the only thing missing;
	 * that is patched in by `templates/sbx/Dockerfile.base` for operators
	 * who want `bun:sqlite` access from inside the VM. Tracer 3 will swap
	 * this for a kit-based provisioning flow.
	 *
	 * Override via the `OVERSTORY_SBX_TEMPLATE` env var.
	 */
	private readonly defaultTemplate = "claude";

	private readonly inner: ClaudeRuntime;

	constructor(inner: ClaudeRuntime = new ClaudeRuntime()) {
		this.inner = inner;
	}

	private get template(): string {
		return process.env.OVERSTORY_SBX_TEMPLATE?.trim() || this.defaultTemplate;
	}

	/**
	 * Build the tmux spawn command. Delegated to the wrapped ClaudeRuntime
	 * so that AI-assisted operations outside the VM (merge resolver,
	 * watchdog triage) keep working. Not used for headless agent spawn.
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		return this.inner.buildSpawnCommand(opts);
	}

	/**
	 * Headless one-shot AI calls (merge resolver, watchdog triage) run on
	 * the host, not inside an sbx VM. Delegate verbatim.
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		return this.inner.buildPrintCommand(prompt, model);
	}

	/**
	 * Deploy overlay + hooks into the worktree. The VM mounts the worktree
	 * read-write, so writes here are visible inside the VM at the
	 * translated path. Pure delegation.
	 */
	deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		hooks: HooksDef,
	): Promise<void> {
		return this.inner.deployConfig(worktreePath, overlay, hooks);
	}

	/**
	 * Headless: pane content does not exist. Always ready.
	 */
	detectReady(_paneContent: string): ReadyState {
		return { phase: "ready" };
	}

	/** No tmux beacon loop — claude is invoked directly via stdin. */
	requiresBeaconVerification(): boolean {
		return false;
	}

	/**
	 * Transcript files live inside the VM's `~/.claude/projects/...`
	 * directory and are not surfaced to the host in Tracer 2. Cost
	 * telemetry can still be ingested from the per-turn stream-json
	 * `result` event (see `docs/sbx-spike.md` §9c). Return null for both.
	 */
	parseTranscript(_path: string): Promise<TranscriptSummary | null> {
		return Promise.resolve(null);
	}

	getTranscriptDir(_projectRoot: string): string | null {
		return null;
	}

	/** Provider env vars are still consumed by claude inside the VM. */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return this.inner.buildEnv(model);
	}

	/**
	 * Provision the VM if it does not already exist. Idempotent — a second
	 * sling against the same agent name (e.g. `--recover`) reuses the
	 * existing VM and its mounted worktree.
	 *
	 * Failures here propagate so the operator sees them at sling time
	 * rather than a confusing per-turn spawn failure later.
	 */
	async prepareWorktree(worktreePath: string): Promise<void> {
		// The worktree manager creates worktrees at `{baseDir}/{agentName}`
		// (see src/worktree/manager.ts), so the basename is the agent name.
		const segments = worktreePath.replace(/\\/g, "/").split("/").filter(Boolean);
		const agentName = segments[segments.length - 1];
		if (!agentName) {
			throw new Error(`claude-sbx: cannot derive agent name from worktree path "${worktreePath}"`);
		}

		if (await sbxVmExists(agentName)) return;

		// `sbx create` provisions the VM in stopped state with the workspace
		// mount available at the translated path. Subsequent `sbx exec`
		// calls bring it up briefly (Tracer 1 spike §4) — keeping the VM
		// truly warm across turns is a Tracer 6 optimization.
		const result = await runSbx(["create", "--name", agentName, this.template, worktreePath]);
		if (result.exitCode !== 0) {
			throw new Error(
				`claude-sbx: failed to create VM "${agentName}" via sbx (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
			);
		}
	}

	/**
	 * Build per-turn argv that runs claude inside the agent's VM.
	 *
	 * Reads `OVERSTORY_AGENT_NAME` and `OVERSTORY_WORKTREE_PATH` from
	 * `opts.env` (populated by the turn-runner). The wrapped
	 * `ClaudeRuntime.buildDirectSpawn` produces the canonical claude
	 * stream-json argv; we prepend the sbx exec prefix and a tiny `bash
	 * -lc` cd-shim so claude runs from the mounted worktree.
	 */
	buildDirectSpawn(opts: DirectSpawnOpts): string[] {
		const agentName = opts.env.OVERSTORY_AGENT_NAME;
		const worktreePath = opts.env.OVERSTORY_WORKTREE_PATH;
		if (!agentName) {
			throw new Error(
				"claude-sbx: OVERSTORY_AGENT_NAME missing from spawn env (turn-runner contract violation)",
			);
		}
		if (!worktreePath) {
			throw new Error(
				"claude-sbx: OVERSTORY_WORKTREE_PATH missing from spawn env (turn-runner contract violation)",
			);
		}

		const innerArgv = this.inner.buildDirectSpawn(opts);
		return buildSbxExecArgv({
			agentName,
			vmCwd: hostPathToVmPath(worktreePath),
			innerArgv,
		});
	}

	/**
	 * Stream-json output is identical inside and outside the VM (claude
	 * doesn't know it's containerized). Delegate parsing.
	 */
	parseEvents(
		stream: ReadableStream<Uint8Array>,
		opts?: {
			onSessionId?: (sessionId: string) => void;
			flushIntervalMs?: number;
			flushSizeBytes?: number;
		},
	): AsyncIterable<AgentEvent> {
		return this.inner.parseEvents(stream, opts);
	}

	/**
	 * Stop and remove the VM. Best-effort and idempotent — `ov stop`
	 * tolerates failure (the host process tree is already dead). Both
	 * subcommands are issued unconditionally so a half-cleaned state
	 * (stopped but not removed) recovers on the next `ov stop`.
	 */
	async stopAgent(agentName: string): Promise<void> {
		try {
			await runSbx(["stop", agentName]);
		} catch {
			// Swallow — runSbx already absorbs spawn errors via Promise.all.
		}
		try {
			await runSbx(["rm", agentName]);
		} catch {
			// Same as above.
		}
	}
}
