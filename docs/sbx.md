# Docker Sandbox (`sbx`) runtime — opt-in

> **Status:** Tracer 2 of the docker-sbx isolation effort
> ([NicoPowers/overstory#3](https://github.com/NicoPowers/overstory/issues/3),
> upstream goal:
> [jayminwest/overstory#3](https://github.com/jayminwest/overstory/issues/3)).
> Default runtime behavior is unchanged. See
> [`docs/sbx-spike.md`](./sbx-spike.md) for the Tracer 1 feasibility report.

## Quick start

```powershell
# One-time setup (Windows)
winget install -h Docker.sbx
sbx login
sbx secret set -g anthropic
docker pull docker/sandbox-templates:claude-code-docker

# Spawn an agent inside an sbx microVM
ov sling <task-id> --capability builder --runtime claude-sbx
```

The agent runs entirely inside a per-agent sbx VM. The agent's worktree is
mounted read-write at the VM-side path translation of the host worktree
(`C:\Users\nicol\…` → `/c/Users/nicol/…` on Windows; identity on
macOS / Linux). All `claude` invocations, git operations, and SQLite WAL
writes happen inside the VM; only the network egress to
`api.anthropic.com` crosses the VM boundary.

## What this gives you

* **Process / FS isolation.** A misbehaving agent cannot reach files
  outside its mounted worktree, cannot fork-bomb the host, and cannot see
  other agents' state.
* **Same `ov` UX.** `ov status`, `ov stop`, `ov mail`, `ov logs`, `ov feed`
  all work — they read shared SQLite databases on the host that the VM
  mounts.
* **Spawn-per-turn fidelity.** This runtime is statically headless
  (`headless = true` on the adapter). The orchestrator drives it through
  the Phase 3 spawn-per-turn engine in `src/agents/turn-runner.ts`. The
  `--headless` / `--no-headless` flags are no-ops for `--runtime
  claude-sbx`; live attach is via `sbx attach <agent-name>`.
* **Default unchanged.** Only spawns invoked with `--runtime claude-sbx`
  go through sbx. Every other runtime (`claude`, `pi`, `codex`, …)
  behaves exactly as before.

## What is NOT yet in scope

These are tracked as later tracers under epic
[#1](https://github.com/NicoPowers/overstory/issues/1):

| Concern | Tracer |
|---|---|
| Per-capability kits (explicit `allowedDomains` per agent) | 3 |
| Skills allowlist + `proxyManaged` for `ANTHROPIC_API_KEY` | 4 |
| Multi-agent mail / WAL concurrency proof | 5 |
| Operator UX (`ov nudge` → `sbx attach`, `ov clean` integration) | 6 |
| `ov doctor --category sandbox` + flipping the default | 7 |

Until Tracer 3 lands, the VM's network policy is whatever your `sbx`
install ships with (default: wide-open `**`), and `ANTHROPIC_API_KEY` is
exposed as a real env var inside the VM by the `claude-code-docker`
template.

## Adapter shape

`src/runtimes/claude-sbx.ts`:

* Wraps a real `ClaudeRuntime` so overlay deployment, transcript / event
  parsing, and provider env routing stay identical.
* Owns three sbx-specific bits:
  * `prepareWorktree` — `sbx create --name <agentName>
    claude-code-docker <worktreePath>` (idempotent: skipped when `sbx ls
    --json` already lists the VM).
  * `buildDirectSpawn` — wraps the inner claude argv as
    `["sbx", "exec", agentName, "--", "bash", "-lc", 'cd "$1" && shift &&
    exec "$@"', "bash", vmCwd, "claude", …]`. Bun.spawn passes argv
    verbatim; bash's `"$@"` preserves it. **No host-shell quoting** —
    the Tracer 1 spike (§9a) showed PowerShell silently truncating
    quoted prompts to 3 tokens.
  * `stopAgent` — `sbx stop <agentName>` then `sbx rm <agentName>`,
    best-effort and idempotent. Wired through `ov stop <agent-name>`.
* Exports `hostPathToVmPath()` for path translation
  (Windows-drive-letter aware, identity on POSIX).

## Customizing the VM image

The bundled template is `docker/sandbox-templates:claude-code-docker`.
For projects that need `bun:sqlite` access from inside the VM (e.g. for
custom hooks), build the overstory base image once and point the runtime
at it:

```bash
docker build -t overstory/sbx-base:0.1 \
    -f templates/sbx/Dockerfile.base templates/sbx
```

```powershell
$env:OVERSTORY_SBX_TEMPLATE = "overstory/sbx-base:0.1"
ov sling <task-id> --capability builder --runtime claude-sbx
```

`OVERSTORY_SBX_TEMPLATE` only affects newly-created VMs; existing VMs
keep whatever template they were created with.

## Testing

* **Unit tests** (`bun test src/runtimes/claude-sbx.test.ts`) install a
  fake `sbx` shim onto `PATH` and assert on the recorded argv. They
  never touch a real VM.
* **Integration tests** are gated behind `OV_SBX_INTEGRATION=1` and
  require a working `sbx` install with an authenticated `anthropic`
  secret. They are not part of the default `bun test` run.
