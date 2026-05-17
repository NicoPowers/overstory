# Burrow Executor Adapter Plan

Tracer-bullet issues for adding Burrow-backed agent execution to Overstory while decoupling agent runtime from execution substrate.

Design spec: [`docs/design/burrow-executor-adapter.md`](docs/design/burrow-executor-adapter.md)

## MVP implementation order

Build the first version specifically for **Burrow + Pi**. Do not refactor all runtimes/executors up front.

1. Issue 1 — config shape for selecting `burrow-pi`.
2. Issue 2 — execution metadata for issue burrow + per-logical-agent Pi sessions.
3. Issue 5 — Burrow client/wrapper. Prefer CLI first, but keep the wrapper swappable to Burrow's TypeScript API if Pi session control requires it.
4. Issue 6 — ensure/recover project burrow.
5. Issue 7 — coordinator spawns one lead into one issue burrow.
6. Issue 9 — per-logical-agent Pi session registry + role/common skill materialization.
7. Issue 10 — Overstory-mail-driven logical addressing and serialized issue-burrow turns.
8. Issue 11 — lead spawns scout in same issue burrow.
9. Issue 12 — lead spawns builder in same issue burrow; one builder at a time.
10. Issue 13 — minimal review/QA; start with lead self-verification, add QA session later.

Explicit MVP deferrals:

- Issue 4 generic executor abstraction.
- Full event/log ingestion beyond linking/showing Burrow ids and logs.
- Pi extensions under Burrow.
- Multiple concurrent builders in one issue burrow.
- Publisher/finalizer/release roles.
- Non-Pi Burrow runtimes.

## Epic: Decouple agent runtime from executor

### Issue 1 — Define executor vocabulary and config shape

**Goal:** Add a minimal design/config seam for `runtime` vs `executor` without changing behavior.

Current Overstory conflates agent runtime and execution substrate. Introduce terminology and config types for:

- `runtime`: Pi, Claude, Codex, Sapling, etc.
- `executor`: existing tmux/direct behavior, future Burrow behavior.

Proposed config sketch:

```yaml
runtime:
  default: pi
  capabilities:
    lead: pi
    scout: pi
    builder: pi

executor:
  default: tmux
  capabilities:
    scout: burrow
    builder: burrow
  burrow:
    agent: pi
```

**Acceptance criteria:**

- Config parser accepts `executor.default`, `executor.capabilities`, and `executor.burrow` without affecting current execution.
- Defaults preserve existing behavior.
- Invalid executor names fail validation with a useful error.
- Documentation added in `docs/design/burrow-executor-adapter.md` or config docs.

---

### Issue 2 — Add execution metadata to agent sessions

**Goal:** Store executor-specific metadata without changing existing session semantics.

Add a structured metadata field for execution backend state, e.g.:

```ts
execution: {
  executor: "tmux" | "burrow";
  runtime: "pi" | "claude" | string;
  externalId?: string;
  workspacePath?: string;
  branch?: string;
  details?: Record<string, unknown>;
}
```

For Burrow, this should hold:

- project burrow id;
- issue burrow id;
- whether this logical agent owns the issue burrow or is a child running inside it;
- Burrow workspace path;
- branch;
- selected Burrow agent id.

**Acceptance criteria:**

- Existing sessions still load.
- `ov status --json` can include execution metadata when present.
- No existing runtime tests regress.

---

### Issue 3 — Add a narrow Burrow-Pi execution path, not a generic executor abstraction

**Goal:** Avoid a broad executor refactor for the MVP. Add a Pi-specific Burrow execution path for `ov sling` while leaving existing tmux/direct runtimes untouched.

Current Overstory spawn behavior is spread across multiple paths:

- `src/commands/sling.ts` creates worker sessions, worktrees, overlays, tmux sessions, and headless runs.
- `src/commands/coordinator.ts`, `monitor.ts`, and `supervisor.ts` start persistent root-level agents separately.
- `src/agents/turn-runner.ts` resumes spawn-per-turn agents and injects mail.
- runtime adapters in `src/runtimes/*` build commands, deploy config/guards, parse transcripts, and build env.
- tmux helpers in `src/worktree/tmux.ts` own process/session mechanics.

A generic `AgentExecutor` abstraction would need to touch many of those seams. For the MVP, do **not** extract existing tmux/direct behavior. Instead, add a clearly isolated Burrow-Pi branch used only when config selects the Burrow-Pi executor.

Proposed MVP config sketch:

```yaml
executor:
  default: tmux
  capabilities:
    lead: burrow-pi
    scout: burrow-pi
    builder: burrow-pi
    reviewer: burrow-pi
  burrowPi:
    runtime: pi
```

**Acceptance criteria:**

- Existing `ov sling` behavior is unchanged unless `executor.* = burrow-pi` is configured.
- No attempt is made to wrap/extract tmux/direct execution in this issue.
- Burrow-Pi path is isolated behind a small resolver/helper that can later evolve into a generic executor.
- Unit tests cover capability resolution to `burrow-pi` vs existing default behavior.

---

### Issue 4 — Reserved: generic executor abstraction after Burrow-Pi proves out

**Goal:** Document that a general executor abstraction is intentionally deferred.

Do not implement this in the MVP. Revisit only after the Pi-specific Burrow path has proven:

- one issue burrow per lead/issue;
- one Pi session per logical agent;
- Overstory mail-driven turn scheduling;
- role-scoped skills;
- builder revision loop.

**Acceptance criteria:**

- No code changes required for MVP.
- Design notes explain why the MVP is Pi-specific.

---

## Epic: Burrow executor tracer bullet

### Issue 5 — Add a `BurrowClient` wrapper

**Goal:** Create a small internal wrapper over the Burrow CLI/API.

Start with CLI calls to minimize dependency coupling:

- `bw up --json`
- `bw list --json`
- `bw show <id> --json`
- `bw fork <id> --json`
- `bw prompt <id> --agent <runtime> --json`
- `bw send <id> ...`
- `bw stop <id> --json`

If Burrow's TypeScript API is stable enough later, swap the implementation behind the same wrapper.

**Acceptance criteria:**

- Wrapper has unit tests with mocked process execution.
- Errors include command, exit code, stderr, and recovery hint.
- No Overstory orchestration logic is in this wrapper.

---

### Issue 6 — Ensure/recover project burrow

**Goal:** Ensure each Overstory project has one reusable Burrow project burrow.

Possible state file:

```text
.overstory/burrow.json
```

Example:

```json
{
  "projectBurrowId": "bur_abc123",
  "projectRoot": "/repo"
}
```

Behavior:

1. Read `.overstory/burrow.json`.
2. Check whether the burrow exists.
3. If missing, run `bw up --json`.
4. Persist the new id.

**Acceptance criteria:**

- Idempotent project burrow creation.
- Recovers when recorded burrow is gone.
- Supports passing declared Burrow agent ids, initially `pi`.

---

### Issue 7 — Implement issue-burrow start for lead only

**Goal:** First real tracer bullet: spawn a lead in one Burrow issue workspace while the coordinator remains outside Burrow.

Flow:

1. Resolve project burrow.
2. Coordinator runs `ov sling <issue-task> --capability lead`.
3. Burrow executor creates one issue burrow: `bw fork <project-burrow-id> --task "issue: <task-id>: lead <name>" --json`.
4. Prepare minimal Overstory context in the issue workspace.
5. `bw prompt <issue-burrow-id> --agent pi "<lead prompt>"`.
6. Save Burrow metadata on the Overstory lead session.

**Acceptance criteria:**

- Coordinator can spawn a lead with executor `burrow`.
- Exactly one issue burrow/worktree is created for the lead-assigned issue.
- Lead receives Overstory role/task prompt.
- `ov status --json` includes the issue burrow id and workspace.

---

### Issue 8 — Minimal Burrow observability in Overstory

**Goal:** Make Burrow-backed agents minimally observable from Overstory without building full event ingestion yet.

Full event/log streaming can wait. The MVP only needs enough state for operators and later issues to debug Burrow-backed sessions.

**Acceptance criteria:**

- `ov status --json` shows issue burrow id, workspace, branch, and active logical agent when known.
- `ov inspect <agent>` shows the corresponding `bw show`, `bw logs`, or `bw events` command hints for deeper inspection.
- Obvious failed/stopped/destroyed issue burrows are surfaced as Overstory warnings.
- Full Burrow event-to-Overstory event ingestion is explicitly deferred.

---

### Issue 9 — Per-logical-agent Pi session registry and role-scoped skills

**Goal:** In one shared issue burrow/workspace, keep each Overstory logical agent's model conversation isolated and load only that agent's approved Pi skills.

Overstory needs a durable mapping from logical agent session to Pi session state:

```ts
{
  agentName: string;
  issueBurrowId: string;
  piSessionDir: string;
  piSessionId?: string;
  lastBurrowRunId?: string;
}
```

The Burrow executor should run/resume Pi for the intended logical agent only, using that agent's session directory/session id, while keeping the workspace shared.

Each logical Pi session also needs a role-scoped skill allowlist. Because skills are important for the MVP, validate this here rather than deferring it to a later polish issue.

Proposed per-agent workspace shape:

```text
<issue-workspace>/.overstory/pi-sessions/<agent-name>/   # Pi session JSONL storage
<issue-workspace>/.overstory/pi-skills/<agent-name>/     # copied/symlinked allowed skills
<issue-workspace>/.pi/settings.json                      # generated before each run or points at current role skills
```

Config sketch:

```yaml
executor:
  burrowPi:
    skills:
      common:
        - ~/.pi/agent/skills/overstory-protocol
        - ~/.pi/agent/skills/seeds
        - ~/.pi/agent/skills/mulch
        - ~/.pi/agent/skills/burrow
      lead:
        - ~/.pi/agent/skills/lead-coordination
      scout:
        - ~/.pi/agent/skills/code-research
      builder:
        - ~/.pi/agent/skills/implementation-hygiene
```

Common skills are the os-eco protocol layer. Seeds, Mulch, Overstory mail/delegation, and Burrow execution conventions should be available to every logical agent so all models use the same task/context/memory language. Role-scoped skills add specialization on top of the common layer.

**Acceptance criteria:**

- Lead, scout, builder, and reviewer can share one issue burrow workspace while using separate Pi session state.
- Overstory records the Pi session id after the first successful run for a logical agent.
- Subsequent turns for that logical agent resume the same Pi session.
- A lead prompt cannot accidentally resume the scout's Pi conversation, and vice versa.
- Tests cover two logical agents in one issue burrow with different Pi session ids.
- Tests prove role-scoped skills are materialized for the intended Pi session.
- A lead run does not see scout-only skills unless configured as common/lead skills.

---

### Issue 10 — Logical addressing and nudge semantics in shared issue burrows

**Goal:** Keep Overstory mail as the logical addressing layer and avoid treating Burrow's burrow-scoped inbox as agent-scoped mail.

Burrow's `agents` registry defines runnable runtime ids, not live named agent instances. `bw agents add pi` appends a `[[agents]] id = "pi"` row to `burrow.toml`; it does not create a lead/scout/builder mailbox. `bw prompt <burrow-id> --agent <id> ...` chooses the runtime for that run, and the run row records `agentId`, but messages remain burrow-scoped.

Burrow's `bw send <burrow-id> ...` queues a message for the active/next run in that burrow. In the shared issue-burrow model, lead, scout, builder, and reviewer are separate Overstory logical agents but share one Burrow id. Therefore `bw send` is ambiguous unless Overstory knows which logical agent is currently active.

Policy:

- Coordinator-to-lead communication uses `ov mail`, not `bw send`.
- Lead-to-worker and worker-to-lead communication uses `ov mail`.
- The Burrow executor wakes the intended logical agent with `bw prompt <issue-burrow-id> --agent <runtime> <prompt containing addressed mail/context>`.
- `bw send` is reserved for low-level steering/cancellation of the currently active Burrow run, and only when the active logical agent is known.

**Acceptance criteria:**

- Burrow-backed sessions record active logical agent metadata for each Burrow run.
- `ov nudge <agent>` either schedules a new prompt for that logical agent or uses `bw send` only when that agent is the active Burrow run.
- Child mail arrival wakes/schedules the parent lead through Overstory's turn runner, not Burrow's inbox alone.
- Lead-to-builder revision loops work through Overstory mail: lead mails builder, builder turn runs, builder mails lead, lead turn runs again.
- The shared issue burrow serializes logical turns so only one logical agent runs in the workspace at a time.
- Tests prove a coordinator message to a lead is not delivered to an active scout in the same issue burrow.

---

## Epic: Lead/sub-worker hierarchy through Burrow

### Issue 11 — Lead spawns scout inside the existing issue burrow

**Goal:** Prove the desired hierarchy works without exposing Burrow commands to the lead and without creating a Burrow fork per sub-worker.

Workflow:

```text
coordinator spawns lead
Overstory creates one issue burrow for the lead
lead runs ov sling scout
Overstory runs scout as a logical child in the same issue burrow/workspace
scout mails lead
lead wakes/processes result
```

**Acceptance criteria:**

- Lead prompt still says to use `ov sling`, not `bw fork`.
- Scout parent is the lead, not coordinator.
- Scout `worker_done` mail goes directly to lead.
- Coordinator is not a conversational middleman for scout findings.
- No additional Burrow fork is created for the scout.
- Scout and lead logical sessions share the same issue burrow id in status metadata.

---

### Issue 12 — Builder runs in the lead's issue burrow and branch

**Goal:** Support builder agents in the same Burrow issue workspace/branch created for the lead.

The issue burrow branch should be created when the lead is spawned, using an explicit branch name such as `ov/<task-id>-<lead-name>`. Builders do not get their own Burrow forks or branches in the default mode.

Open design questions:

- How does Overstory serialize scout/build/review prompts within one Burrow issue workspace?
- Should multiple builders be disallowed in one issue burrow until workspace locking exists?
- What exact cleanliness check should the lead run after scouts and before builders?

Recommended tracer decision: one issue burrow, one issue branch, one builder at a time.

**Acceptance criteria:**

- Builder receives file scope/spec.
- Builder works in the lead's issue burrow/workspace.
- Builder changes land on the issue branch known to Overstory.
- Builder can send `worker_done` with branch metadata.
- Coordinator can run existing merge/PR flow against the issue branch.

---

### Issue 13 — Reviewer/QA and merger execution in the issue burrow

**Goal:** Extend Burrow execution to read-only reviewer/QA and merge-specialist roles inside the same issue workspace.

QA policy:

- Simple issues: lead may self-verify by reading the diff and running acceptance commands.
- Moderate/complex issues: lead should spawn a logical reviewer/QA agent with a separate Pi session in the same issue burrow.
- UI/mobile issues: prefer a QA agent that can run browser/device/tooling checks and produce durable evidence.

**Acceptance criteria:**

- Reviewer/QA can inspect the issue branch and report PASS/FAIL to lead.
- Reviewer/QA can run project quality gates and task-specific acceptance commands from inside the issue burrow.
- Reviewer/QA can attach or reference durable evidence such as logs, screenshots, traces, or reproduction steps.
- Reviewer/QA write policy is explicit: either read-only and reports missing tests as FAIL, or allowed to add narrowly-scoped independent regression tests.
- Builder-authored tests are treated as supplementary for non-trivial work; acceptance tests should be lead/QA-owned or independently reviewed.
- Any builder modification to existing tests is surfaced in completion mail and reviewed by lead/QA.
- Merger can be spawned by lead for high-tier conflict predictions if needed.
- No extra Burrow fork is created for reviewer/QA/merger by default.
- Role-specific guardrails are preserved or replaced with Burrow-compatible enforcement.

---

## Epic: Credentials, skills, and extensions

### Issue 14 — Provider and tool credential allowlists

**Goal:** Make credential flow explicit for Burrow sandboxes.

Initial provider targets:

- Anthropic
- OpenAI
- Google Gemini
- Kimi

Current Overstory mostly relies on process env inheritance plus runtime `buildEnv()` output. Burrow-backed execution should instead pass only allowlisted environment variables into each sandbox.

Proposed config sketch:

```yaml
providers:
  anthropic:
    type: native
  openai:
    type: native
  gemini:
    type: native
  kimi:
    type: gateway
    baseUrl: https://api.moonshot.ai/v1
    authTokenEnv: KIMI_API_KEY

models:
  coordinator: anthropic/claude-opus-4-6
  lead: openai/gpt-5.2
  scout: gemini/gemini-3-pro
  builder: kimi/kimi-k2-thinking

executor:
  burrow:
    envPassthrough:
      common: []
      runtime:
        pi:
          - ANTHROPIC_API_KEY
          - ANTHROPIC_AUTH_TOKEN
          - ANTHROPIC_BASE_URL
          - OPENAI_API_KEY
          - GEMINI_API_KEY
          - KIMI_API_KEY
      capabilities:
        lead:
          - GITHUB_TOKEN
        scout: []
        builder: []
```

**Acceptance criteria:**

- Burrow executor has an allowlist for env vars passed into task sandboxes.
- Runtime/provider API keys are included only when needed by selected runtime/model.
- Tool secrets can be scoped by capability.
- Missing required provider credentials fail fast with a clear message.
- No sandbox receives the operator's full host environment by default.

---

### Issue 15 — SSH git credential policy

**Goal:** Decide and implement how GitHub/GitLab SSH credentials are exposed to Burrow-backed agents.

Preferred model: SSH agent passthrough, not copying private keys. Burrow has sandbox support for an `sshAuthSock` socket mount; Overstory should request/enable that only for roles that need remote git access.

Policy questions:

- Which capabilities may receive `SSH_AUTH_SOCK`?
- Do builders need remote push, or only local branch commits?
- Should PR/push be handled by a dedicated `publisher`/`release` role rather than normal leads/builders?
- How should an agent-specific deploy key or machine-user key be configured?

Recommended default:

- scouts/reviewers: no write-capable git credentials;
- builders: local repo only, no remote push by default;
- leads/senior engineers: optional SSH agent passthrough or scoped GitHub/GitLab token for pushing their final task branch and opening a PR;
- default/protected branch merge remains human-owned.

Do **not** add a publisher/release/finalizer role in the first implementation. The lead already owns the task context, scout findings, builder output, and verification decisions; adding another agent creates an extra context-transfer hop. Revisit only if PR creation needs stricter separation later.

**Acceptance criteria:**

- Config supports disabling/enabling SSH agent passthrough by capability.
- Private key files are never copied into workspaces.
- If `SSH_AUTH_SOCK` is forwarded, it is mounted as a socket only.
- Leads can be granted push/PR credentials without granting them to scouts/builders/reviewers.
- Documentation recommends agent-specific deploy keys/machine users for push/PR workflows.
- Documentation explicitly states leads may open PRs but should not merge protected/default branches.

---

### Issue 16 — Harden role-scoped skill packaging

**Goal:** Harden the role-scoped skill packaging proven in Issue 9.

Proposed behavior:

```text
.burrow task workspace
  .pi/settings.json
  .pi/skills/<copied skills>
```

Config sketch:

```yaml
executor:
  burrow:
    skills:
      common:
        - ~/.pi/agent/skills/overstory-protocol
        - ~/.pi/agent/skills/seeds
        - ~/.pi/agent/skills/mulch
        - ~/.pi/agent/skills/burrow
      scout:
        - ~/.pi/agent/skills/code-research
      builder:
        - ~/.pi/agent/skills/implementation-hygiene
```

**Acceptance criteria:**

- Skills are copied/symlinked into the issue workspace in deterministic per-agent directories.
- Pi sees common os-eco protocol skills plus the role-approved skills for the logical agent being run.
- Missing skill paths fail fast with clear error.
- Works without relying on host-global `~/.pi/agent/skills` visibility inside bwrap.
- Skill materialization is idempotent and safe across repeated turns for the same agent.

---

### Issue 17 — Decide Pi extension support policy under Burrow

**Goal:** Make an explicit decision about Pi extensions under Burrow.

Burrow's built-in Pi runtime currently uses `--no-extensions`. That conflicts with Overstory's existing Pi guard extension approach.

Options:

1. Keep extensions disabled; enforce guardrails through Overstory/Burrow.
2. Add a custom Burrow Pi agent variant that allows non-interactive extensions.
3. Add Burrow-side support for safe extension allowlists.

**Acceptance criteria:**

- Decision documented.
- If enabled, only non-interactive extensions are allowed.
- Headless hangs from extension UI requests are tested or explicitly mitigated.

---

## Epic: Hardening and rollout

### Issue 18 — Watchdog and cleanup for Burrow agents

**Goal:** Extend Overstory cleanup/watchdog behavior to Burrow-backed agents.

**Acceptance criteria:**

- `ov stop <agent>` stops the Burrow task.
- `ov clean` can destroy completed Burrow issue burrows when safe.
- Watchdog can detect stuck/failed Burrow-backed logical agents.
- No issue burrow is destroyed before relevant branches/artifacts are merged, pushed, or archived.

---

### Issue 19 — End-to-end seed workflow

**Goal:** Full workflow from seed issue to merged branch using Burrow-backed Pi agents.

Scenario:

```text
coordinator receives seed
coordinator spawns lead
lead spawns scout(s)
scouts report to lead
lead spawns builder
builder reports to lead
lead self-verifies or spawns reviewer
lead sends merge_ready
coordinator merges
```

**Acceptance criteria:**

- Each issue/lead gets exactly one Burrow issue burrow.
- Lead-spawned scouts/builders/reviewers run as logical Overstory agents inside the lead's shared issue burrow.
- Parent/child mail routing works.
- Merge branch is known and mergeable.
- `ov status`, `ov inspect`, and logs are usable throughout.
- The coordinator is not a middleman for scout/builder findings.

---

### Issue 20 — Documentation and migration guide

**Goal:** Document how to enable and use Burrow-backed execution.

Include:

- config examples;
- required Burrow setup (`bw init`, `bw doctor`, `bw up` behavior);
- Pi runtime notes;
- skills behavior;
- extension limitations;
- cleanup/recovery commands.

**Acceptance criteria:**

- README or docs explain `runtime` vs `executor`.
- Example config for Burrow + Pi exists.
- Known limitations are documented.
