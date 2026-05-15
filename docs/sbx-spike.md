# Tracer 1 spike — Docker Sandbox (`sbx`) feasibility for overstory workers

> **Status:** ✅ feasible. All concerns from upstream issue
> [`jayminwest/overstory#3`](https://github.com/jayminwest/overstory/issues/3)
> were validated end-to-end on Windows 11 + Docker Desktop. Two surprises (Windows
> path rewriting and the sparse `shell` template) need to be carried into Tracer 2's
> design — see [Implications](#implications-for-tracer-2).
>
> **Tracking issue:** [#2](https://github.com/NicoPowers/overstory/issues/2) under
> epic [#1](https://github.com/NicoPowers/overstory/issues/1).

## Environment under test

| Component | Version |
|---|---|
| Host OS | Windows 11 Pro 10.0.26200 |
| Docker | 28.5.1 |
| `sbx` | v0.28.3 (`8d114184e520cf5744502f187faf90342af599e5`) |
| Templates pulled | `docker/sandbox-templates:shell-docker`, `docker/sandbox-templates:claude-code-docker` |
| Anthropic credential | OAuth (`sbx secret list` shows `(global) anthropic (oauth configured)`) |
| Network policy at start | `default-allow-all` (`**`) — wide open by default on this install |

## 10-minute setup

```powershell
# Install + login
winget install -h Docker.sbx
sbx login

# Set Anthropic credential (OAuth or API key)
sbx secret set -g anthropic

# Pull the template once
docker pull docker/sandbox-templates:claude-code-docker

# Confirm
sbx version
sbx ls
sbx policy ls
sbx secret list
```

## What was validated

### 1. Workspace mount is RW and the full repo is visible

```bash
sbx create --name overstory-spike shell .
sbx exec overstory-spike -- mount | grep virtiofs
# bind-... on /c/Users/nicol/OneDrive/Documents/Projects/overstory type virtiofs (rw,relatime)

sbx exec overstory-spike -- ls /c/Users/nicol/OneDrive/Documents/Projects/overstory
# CLAUDE.md, package.json, .overstory/, .git/, .claude/, ...
```

A round-trip RW probe (`echo > $WS/.spike-rw-test && cat && rm`) succeeded. OneDrive
folder under `C:\Users\<user>\OneDrive\...` was not a problem in practice.

### 2. **Surprise:** Windows path rewriting

The skill description claims the workspace is mounted at the **same absolute path**
as on the host. **That is not true on Windows.** The host path
`C:\Users\nicol\OneDrive\Documents\Projects\overstory` is rewritten inside the VM to
`/c/Users/nicol/OneDrive/Documents/Projects/overstory` (drive letter lowercased,
backslashes flipped, prefixed with `/`).

A placeholder `/home/agent/workspace` directory exists but is **empty**.

This must be addressed in Tracer 2 by a `hostPathToVmPath()` helper used whenever
overstory passes a worktree path to `sbx run` / `sbx exec`. On macOS/Linux this is
identity; on Windows it's the rewrite above. Suggested location:
`src/runtimes/claude-sbx.ts` with a unit test covering both forms.

### 3. Git operations work in the mount

```bash
cd /c/Users/nicol/OneDrive/Documents/Projects/overstory
git rev-parse --abbrev-ref HEAD     # feat/docker-sandbox-isolation
git log --oneline -3                 # readable
```

Satisfies upstream issue #3 requirement: *"Allow git operations — Agents run `git
add`, `git commit`, `git diff`, etc. within their worktree."*

### 4. Bun + `bun:sqlite` WAL works on tmpfs

```js
import { Database } from "bun:sqlite";
const db = new Database("/tmp/spike-wal.db");
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA busy_timeout=5000");
// ...
// rows: {"n":5}
// journal_mode: {"journal_mode":"wal"}
// WAL/SHM files exist? true true
```

### 5. **Critical:** Bun + `bun:sqlite` WAL works on the **mounted workspace** (virtiofs)

```js
const db = new Database("/c/Users/nicol/.../.tmp-spike/spike-mount.db");
db.exec("PRAGMA journal_mode=WAL");
// mount WAL: {"journal_mode":"wal"}
// rows: {"n":1}
```

This is the single most load-bearing finding for the parent issue. WAL on
virtiofs **succeeds**, which means `.overstory/mail.db`, `events.db`,
`sessions.db`, and `metrics.db` can all live on the host and be opened RW from
inside one or more sbx VMs without any code changes to overstory's storage
layer. Satisfies issue #3 requirement: *"Allow SQLite WAL mode."*

The full multi-writer concurrency proof is the job of **Tracer 5** (two VMs
hammering the same DB), not Tracer 1.

### 6. Anthropic API is reachable from inside the VM

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://api.anthropic.com/v1/messages \
  -X POST -H 'content-type: application/json' -d '{}'
# 401
```

`401` instead of a connection error confirms:
- The default sbx network policy allows `api.anthropic.com:443`.
- TLS works.
- The request reaches Anthropic (which then rejects it for missing auth).

For Tracer 3 we will lock the policy down to **only** `api.anthropic.com` per
capability via the canonical proxy-managed kit pattern. **Note:** in this
spike the `claude-code-docker` template exposes `ANTHROPIC_API_KEY` as a real
env var inside the VM (`env | grep ANTHROPIC` returned a non-empty value).
Tracer 3 must replace this with the `proxyManaged` kit block so the value never
lands inside the VM (the parent issue calls this out explicitly as the security
goal).

### 7. Claude Code CLI is available out-of-the-box (in `claude-code-docker`)

```
$ claude --version
2.1.141 (Claude Code)
$ command -v claude
/home/agent/.local/bin/claude
```

### 8. **End-to-end:** Claude inside the VM produced a real host commit

```powershell
sbx create --name overstory-tracer1-final claude .
sbx exec overstory-tracer1-final -- mkdir -p /home/agent/spike
sbx cp ".\.tmp-spike\tracer1-prompt.txt" overstory-tracer1-final:/home/agent/spike/prompt.txt
sbx exec overstory-tracer1-final -- bash -lc `
  "cd /c/Users/nicol/OneDrive/Documents/Projects/overstory && \
   cat /home/agent/spike/prompt.txt | \
   claude --print --permission-mode bypassPermissions \
          --max-budget-usd 0.50 --output-format json"
```

Result (excerpted from the JSON envelope):

```json
{
  "type": "result", "subtype": "success", "is_error": false,
  "stop_reason": "end_turn", "num_turns": 4, "duration_ms": 9715,
  "result": "```\n070ad62\n```",
  "total_cost_usd": 0.17021455,
  "modelUsage": {
    "claude-sonnet-4-6": { "inputTokens": 5, "outputTokens": 448, ... },
    "claude-haiku-4-5-20251001": { "inputTokens": 446, ... }
  }
}
```

On the host (`git log --oneline -1`) immediately after:

```
070ad621 sbx: tracer 1 hello-world commit from inside the VM
Author: Nicolas <nicolas@montoyaautomation.com>
```

The throwaway commit was `git reset --hard HEAD~1`'d after verification.

Together this proves the full chain: **Claude auth inside VM → API call →
file edit on virtiofs mount → `git commit` from inside VM → commit visible
in host's `.git/`** with the host's git config picked up automatically.

### 9. Two operational gotchas observed during the smoke test

These don't block Tracer 1 but **must** be carried into Tracer 2's design:

**(a) Pass prompts via stdin or a file, not as positional args through PowerShell.**
The first attempt passed the prompt as a quoted positional arg through
`bash -lc '...claude --print "<prompt>"'` from PowerShell. Quoting was
mangled — Claude received only **3 tokens** of input ("Create" or similar)
and politely asked for clarification (still cost ~$0.09 for the cache
warm-up). The second attempt wrote the prompt to a host file, `sbx cp`'d
it into `/home/agent/spike/prompt.txt`, and piped it into `claude --print`
via `cat | claude`. That worked first try.

For Tracer 2: the runtime adapter must never assemble a prompt as a shell
argument. Always use `stdin: "pipe"` on `Bun.spawn(["sbx","exec",...,"claude","--print",...])`
and write the prompt bytes to the pipe.

**(b) Claude pulled a fragment of the previous commit message into its own
commit body** (the trailing `ility for overstory workers` and the
"Closes acceptance criteria..." paragraph were verbatim from the previous
commit `1e16c1d`). Likely it read `git log` to learn the project's commit
style and used `git commit -F-` with a heredoc that included context it
shouldn't have. This is a Claude prompting concern, not an sbx one — but
worth noting in the builder agent overlay later: tell builders explicitly
not to use `git commit -F-` with heredocs that may contain prior log
content; prefer `git commit -m "..."` with a single-line message or a
clean tempfile.

## Tool inventory per template

| Tool | `shell-docker` | `claude-code-docker` | overstory needs it? |
|---|---|---|---|
| `node` 20.19.4 | ✅ | ✅ | yes (claude code runtime) |
| `npm` 9.2 | ✅ | ✅ | yes |
| `git` 2.51 | ✅ | ✅ | yes |
| `python3` 3.13 | ✅ | ✅ | optional |
| `curl` 8.14 | ✅ | ✅ | yes |
| `jq` 1.8 | ❌ | ✅ | nice-to-have |
| `claude` 2.1.141 | ❌ | ✅ | yes (sentinel of the right template) |
| `bun` | ❌ | ❌ | **yes — must add** |
| `sqlite3` (CLI) | ❌ | ❌ | no — overstory uses `bun:sqlite` only |
| `tmux` | ❌ | ❌ | no — sbx replaces tmux |

`bun` is the only addition we actually need. Hence
[`templates/sbx/Dockerfile.base`](../templates/sbx/Dockerfile.base) =
`FROM claude-code-docker` + bun install. Nothing else.

## Implications for Tracer 2

Carry these into the runtime adapter design:

1. **Path translation is real on Windows.** Add `hostPathToVmPath()` in
   `src/runtimes/claude-sbx.ts` and use it for every worktree path passed to
   `sbx`. Identity on macOS/Linux.
2. **Use `claude-code-docker` (or our base image built on it), not `shell`.** The
   `shell` template lacks `claude` itself.
3. **Bun must be present in the image.** Either build & publish
   `overstory/sbx-base:0.1` once and reference it via `--template`, or push the
   bun install into a kit `commands.install` block in Tracer 3. The Dockerfile
   approach is cheaper at spawn time; the kit approach keeps everything
   declarative. Recommendation: Dockerfile for now, revisit in Tracer 3.
4. **Each `sbx exec` starts a stopped VM and stops it after the command
   finishes** (`sbx ls` between calls shows `STATUS: stopped`). Implications
   for the headless turn-runner: either use long-running sandboxes via
   `sbx create` + `sbx run` (attach), or accept startup cost per turn. Tracer 2
   should default to the former (per-agent VM kept warm for the agent's
   lifetime) and add a `--ephemeral` flag for short-lived spawns.
5. **`sbx cp` requires a Windows-style absolute host path** (forward-slash
   relative paths silently no-op on this version). Affects any helper that
   copies overlay/hooks files into the VM if we choose to do so instead of
   relying on the workspace mount. Preference: use the mount, don't `sbx cp`.
6. **Default network policy is wide-open (`**`) on a fresh install.** Don't
   rely on the system default. Tracer 3's kits must define explicit
   `allowedDomains` per capability and Tracer 7's `ov doctor` must warn when
   the host policy is wide-open.
7. **Never pass Claude prompts as positional shell args.** The runtime adapter
   must always pipe the prompt through stdin (or a tempfile) to avoid
   PowerShell/cmd quoting destroying multi-line/multi-word prompts. Practically
   this means `Bun.spawn(["sbx","exec",name,"--","claude","--print",...], { stdin: "pipe" })`
   followed by writing the prompt bytes. See §9(a).
8. **Builder overlay needs a "no `git commit -F-` heredocs" rule** to prevent
   Claude from accidentally bleeding prior commit messages into new commits.
   See §9(b). Land this in `agents/builder.md` overlay guidance.
9. **Forward-compatible cost telemetry exists.** The `--output-format json`
   envelope already includes `total_cost_usd` and per-model `inputTokens` /
   `outputTokens` / `cacheReadInputTokens`. The `metrics` subsystem in
   `src/metrics/` can ingest this directly from the sbx adapter without any
   new pricing logic.

## Acceptance checklist (issue #2)

- [x] Reproducible 10-minute setup written down (above).
- [x] One Claude turn inside the VM produces a real git commit on host
  (commit `070ad621`, validated then reset; total cost ~$0.26 across two turns,
  see §8).
- [x] `bun:sqlite` WAL access to a workspace-mounted `.db` confirmed from
  inside the VM.
- [x] Anthropic API reachable from inside the VM (401 round-trip; subsequently
  authenticated successfully via the OAuth credential auto-injected by the
  `claude-code-docker` template).

## Out-of-scope for this spike

- Per-capability kits (Tracer 3).
- Multi-VM mail concurrency (Tracer 5).
- Operator UX for `nudge`/`stop`/`clean` (Tracer 6).
- `ov doctor --category sandbox` (Tracer 7).

## Cleanup commands used

```powershell
sbx stop overstory-spike overstory-spike-cc
sbx rm overstory-spike overstory-spike-cc
```
