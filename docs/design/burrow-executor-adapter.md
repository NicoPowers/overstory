# Burrow Executor Adapter: Config Seam (overstory-f637)

## Summary

This task introduces a **new executor config namespace** that is intentionally separate from runtime selection:

- `runtime.*` continues to pick the AI coding runtime (`claude`, `pi`, `codex`, etc.).
- `executor.*` defines future non-runtime execution backends (`local`, `burrow-pi`).

No runtime spawning behavior changes in this task.

## Why split runtime and executor?

`runtime` answers: *which AI agent binary/process do we run?*

`executor` answers: *where/how should task execution be bridged?*

Keeping these concerns separate lets us add Burrow-Pi execution plumbing later without overloading runtime semantics or regressing existing runtime routing.

## Config shape

```yaml
executor:
  default: local # local | burrow-pi
  capabilities:
    builder: burrow-pi
    reviewer: local
  burrowPi:
    command: burrow-pi
    profile: default
    endpoint: http://127.0.0.1:9315
    authTokenEnv: BURROW_PI_TOKEN
```

### Fields

- `executor.default` — default backend for capabilities without override.
- `executor.capabilities.<capability>` — per-capability executor override.
- `executor.burrowPi.command` — bridge command (required, non-empty string).
- `executor.burrowPi.profile` / `endpoint` / `authTokenEnv` — optional string settings.

## Defaults

`DEFAULT_CONFIG.executor` is:

```yaml
executor:
  default: local
  capabilities: {}
  burrowPi:
    command: burrow-pi
    profile: default
    endpoint: http://127.0.0.1:9315
```

## Validation behavior

Supported executors are currently:

- `local`
- `burrow-pi`

Validation guarantees:

- `executor.default` must be one of supported executors.
- every `executor.capabilities.<cap>` value must be one of supported executors.
- `executor.burrowPi.command` must be a non-empty string.
- optional Burrow-Pi settings (profile/endpoint/authTokenEnv) must be strings when set.

Validation errors include field/value metadata through `ValidationError`.

## Runtime behavior in this task

No adapter wiring yet:

- runtime resolution still uses `runtime.default` / `runtime.capabilities`.
- `executor.default = burrow-pi` does **not** alter `getRuntime()` behavior.
- a pure helper in `sling.ts` (`resolveExecutorName`) is added for future integration.

Follow-up work will connect executor selection to actual execution paths.
