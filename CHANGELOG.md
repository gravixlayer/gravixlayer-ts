# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.6] - 2026-08-25

### Changed

- On Node 20+, the HTTP stack is undici: HTTP/2 first (one multiplexed TLS
  session per origin, HTTP/2 PING + TCP keep-alive so ALB does not drop it),
  then HTTP/1.1 keep-alive if `h2` is not negotiated. Handshake fallback is
  per-origin and only retries replayable bodies. Endpoints, request bodies,
  and public method signatures are unchanged. Bun, Deno, and edge runtimes
  are unchanged.
- Streaming requests (`runCmd` / `runCode` callbacks, `streamCmd`, PTY, file
  watch, agent stream) send `Accept: text/event-stream` and
  `Accept-Encoding: identity` so gzip cannot buffer SSE frames.
- `runCmd` / `runCode` keep the HTTP request open for the guest deadline plus
  30s of margin, so a long command is not killed by the 60s default timeout.

### Added

- `client.close()` drains the connection pool, matching the Python client.
  Safe to call more than once. A no-op when a custom `fetch` was supplied.

### Fixed

- Removed a circular `gravixlayer` dependency from `package.json` that could
  make local examples resolve to the published package instead of this tree.

## [0.1.5] - 2026-08-22

### Fixed

- Fixed code examples to bring consistency.

## [0.1.4] - 2026-08-22

### Changed

- Runtime create is `client.runtime.create(...)`, matching the Python SDK.
- Nested runtime resources match the Python SDK: `client.runtime.file`,
  `client.runtime.service`, and `runtime.file`. Open a published port with
  `runtime.service(port)`. List and revoke stay on `client.runtime.service`.
  There is no `files` or `services` alias.

### Fixed

- Template `build()` / `buildAndWait()` now send the client cloud and region
  (`aws` / `us-east-1` by default), matching runtime create. Builds no longer
  depend on the API filling placement itself.

## [0.1.3] - 2026-08-22

Fixed examples.

## [0.1.0] - 2026-08-22

First release. Full coverage of the GravixLayer API.

### Added

- **Client.** `GravixLayer`, configured from options or the environment, with
  per-request timeouts, cancellation through `AbortSignal`, and automatic
  retries with exponential backoff and jitter for connection failures and 429,
  502, 503, and 504 responses. `warmup()` opens the connection ahead of the
  first request that matters.
- **Runtimes.** Create, list, retrieve, connect, pause, resume, and stop.
  Execute code and shell commands, with results returned whole or streamed.
  Code contexts for state that survives between executions. Resource metrics,
  timeout management, and SSH access.
- **Guest filesystem.** Read, write, upload, download, batch write, list,
  metadata, permissions, ownership, move, copy, delete, search, replace across
  files, and live change watching.
- **Terminals.** Interactive sessions that outlive the client that opened them,
  with streamed output, input, resizing, signals, and reattachment.
- **Git.** Clone, status, branches, checkout, fetch, pull, push, add, and
  commit, run inside a runtime.
- **Published services.** Expose a guest port on a public HTTPS URL, with a
  small authenticated client for calling it.
- **Templates.** A fluent `TemplateBuilder` covering base images, Dockerfiles,
  package installation, files, git clones, start and readiness commands, plus
  build, poll, list, inspect, and delete.
- **Snapshots.** Capture a runtime's filesystem, or its memory as well, and
  start new runtimes from it. Activate, deactivate, list, and delete.
- **Agents.** Build from a source directory with framework, interpreter
  version, ports, and environment inferred from the project. Deploy, invoke,
  stream, inspect, and destroy. Publishes an agent card for discovery.
- **Network policies.** Egress modes and rules, attachment to runtimes, and
  the fail-closed baseline every runtime starts with.
- **Secret providers.** Write-only credentials injected into a runtime's
  environment at execution time.
- **Errors.** One base class with a subclass per failure category, carrying the
  status, response headers, parsed body, and request id. `Retry-After` is
  surfaced on rate-limit errors.
- **Observability.** Optional OpenTelemetry spans for every request, plus the
  `trace`, `traced`, and `runtimeSpan` helpers, active only when
  `@opentelemetry/api` is installed and telemetry is enabled.

[Unreleased]: https://github.com/gravixlayer/gravixlayer-ts/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.6
[0.1.5]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.5
[0.1.4]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.4
[0.1.3]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.3
[0.1.0]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.0
