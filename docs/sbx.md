# Docker Sandbox (`sbx`) runtime — opt-in

> **Status:** Tracer 3 of the docker-sbx isolation effort
> ([NicoPowers/overstory#4](https://github.com/NicoPowers/overstory/issues/4),
> epic: [#1](https://github.com/NicoPowers/overstory/issues/1)).
> Default runtime behavior is unchanged. See
> [`docs/sbx-spike.md`](./sbx-spike.md) for the Tracer 1 feasibility report.

## Quick start

```powershell
# One-time setup (Windows)
winget install -h Docker.sbx
sbx login
sbx secret set -g anthropic
docker pull docker/sandbox-templates:claude-code-docker

# Spawn an agent inside an sbx microVM (uses per-capability kits automatically)
ov sling <task-id> --capability builder --runtime claude-sbx
```

The agent runs entirely inside a per-agent sbx VM. The agent's worktree is
mounted read-write at the VM-side path translation of the host worktree
(`C:\Users\nicol\…` → `/c/Users/nicol/…` on Windows; identity on
macOS / Linux). All `claude` invocations, git operations, and SQLite WAL
writes happen inside the VM; only the network egress to
`api.anthropic.com` (and npm/GitHub for builder/lead) crosses the VM boundary.

## What this gives you

* **Process / FS isolation.** A misbehaving agent cannot reach files
  outside its mounted worktree, cannot fork-bomb the host, and cannot see
  other agents' state.
* **Per-capability network policy.** Scout and reviewer agents are locked
  to `api.anthropic.com` only. Builder and lead agents additionally reach
  npm registries and GitHub. Merger is locked to `api.anthropic.com`.
* **Credential never enters the VM.** `ANTHROPIC_API_KEY` is wired via
  the sbx proxy-managed pattern — the agent sees a placeholder; the host
  proxy substitutes the real key before forwarding.
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
| Skills allowlist + `proxyManaged` for `ANTHROPIC_API_KEY` | 4 |
| Multi-agent mail / WAL concurrency proof | 5 |
| Operator UX (`ov nudge` → `sbx attach`, `ov clean` integration) | 6 |
| `ov doctor --category sandbox` + flipping the default | 7 |

## Kit composition per capability

Each capability spawns under a composed set of kits defined in
`agent-manifest.json` (`sandbox.kits`). Kit directories live in
`templates/sbx-kits/` and are copied to `.overstory/sbx-kits/` in target
projects by `ov update --sbx-kits`.

| Capability | Kits | Network | Workspace |
|---|---|---|---|
| `scout` | `base`, `read-only`, `network-strict` | `api.anthropic.com` only | read-only |
| `reviewer` | `base`, `read-only`, `network-strict` | `api.anthropic.com` only | read-only |
| `merger` | `base`, `network-strict` | `api.anthropic.com` only | read-write |
| `builder` | `base`, `network-dev` | anthropic + npm + github | read-write |
| `lead` | `base`, `network-dev` | anthropic + npm + github | read-write |

### Kit descriptions

| Kit | Purpose |
|---|---|
| `base` | Installs Bun + overstory CLI; wires `ANTHROPIC_API_KEY` via proxy-managed pattern |
| `read-only` | `chmod -R a-w` on the workspace at creation — blocks accidental writes |
| `network-strict` | `allowedDomains: [api.anthropic.com]` — minimal surface |
| `network-dev` | `allowedDomains: [api.anthropic.com, *.npmjs.org, registry.npmjs.org, github.com, api.github.com]` |

## Overriding kits per spawn

```bash
# Replace the manifest kit list entirely (one or more --kit flags)
ov sling <t> --capability scout --runtime claude-sbx \
  --kit /path/to/my-kit

# Append extra kits to the manifest list
ov sling <t> --capability builder --runtime claude-sbx \
  --add-kit /path/to/extra-kit

# Skip all kits — bare template, no network policy or credential injection
# (debug / escape hatch only)
ov sling <t> --capability builder --runtime claude-sbx --no-sandbox
```

## Refreshing kits in a target project

```bash
# Copy templates/sbx-kits/ → .overstory/sbx-kits/ (run after ov upgrade)
ov update --sbx-kits

# Or refresh all managed files at once
ov update
```

The kits in `.overstory/sbx-kits/` are used when passing local kit paths
to `sbx create`. The package's `templates/sbx-kits/` directory is the
canonical source of truth.

## Adapter shape

`src/runtimes/claude-sbx.ts`:

* Wraps a real `ClaudeRuntime` so overlay deployment, transcript / event
  parsing, and provider env routing stay identical.
* Owns four sbx-specific bits:
  * `setKitPaths(paths)` — called by `ov sling` with resolved kit paths
    before `prepareWorktree` runs.
  * `prepareWorktree` — `sbx create --name <agentName> [--kit <path>
    ...] <template> <worktreePath>` (idempotent: skipped when `sbx ls
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

### Validating the kit specs

```bash
sbx kit validate templates/sbx-kits/base
sbx kit validate templates/sbx-kits/read-only
sbx kit validate templates/sbx-kits/network-strict
sbx kit validate templates/sbx-kits/network-dev
```

All four must exit 0.
