# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
## [0.1.18] - 2026-08-29
### Fixed
- Fixed run code context bug

## [0.1.17] - 2026-08-26
### Fixed

- Fixed Template build pipeline bug

## [0.1.16] - 2026-08-26
### Changed

- `templates.buildAndWait` and `agents.waitForBuild` print BUILDING and
  VERIFYING with elapsed times on a TTY (no percents). Pass `onPhase` to
  keep driving progress yourself.

## [0.1.15] - 2026-08-25
### Changed

- fixed the template default build timeout 

## [0.1.14] - 2026-08-25

### Changed

- `waitForPort` sends `ready_port` so the platform probes the published TCP
  port from the host. Custom `readyCmd` strings are unchanged.
- `TemplateBuilder.readyCmd` sends a ready timeout of at least 300 seconds.

## [0.1.13] - 2026-08-25

### Fixed

- Node processes exit after the last request. Closing the client destroys
  keep-alive sockets and HTTP/2 sessions immediately. Idle pooled sockets are
  also unref'd so they cannot hold the event loop open.

### Changed

- Node HTTPS uses an HTTP/1.1 keep-alive pool by default. Pass `http2: true` on
  the client to multiplex on one HTTP/2 session per origin.

## [0.1.12] - 2026-08-25

### Changed

- Node HTTPS defaults to HTTP/2 multiplexing (one session per origin). Origins
  that do not speak HTTP/2 fall back to an HTTP/1.1 keep-alive pool. Closing
  the client still destroys sockets immediately so the process can exit.

## [0.1.11] - 2026-08-25

### Fixed

- Node processes exit after the last request. Closing the client destroys
  pooled sockets instead of waiting on a graceful HTTP/2 shutdown.

### Changed

- Node HTTPS uses an HTTP/1.1 keep-alive pool by default.

## [0.1.10] - 2026-08-25

### Changed

- Node HTTPS defaults to HTTP/2 (one session per origin). Origins that do not
  speak HTTP/2 fall back to an HTTP/1.1 keep-alive pool.

## [0.1.9] - 2026-08-25

### Fixed

- Faster connection setup and reuse on Node for consecutive and concurrent
  requests.

## [0.1.8] - 2026-08-25

### Fixed

- More reliable connection setup on Node.

## [0.1.7] - 2026-08-25

### Changed

- Node HTTP defaults to an HTTP/1.1 keep-alive pool.

## [0.1.6] - 2026-08-25

### Changed

- On Node 20+, the client reuses HTTP connections across requests. Public
  endpoints and method signatures are unchanged.
- Streaming requests (`runCmd` / `runCode` callbacks, `streamCmd`, PTY, file
  watch, agent stream) keep event-stream output unbuffered.
- `runCmd` / `runCode` stay open for the guest deadline plus 30s, so a long
  command is not cut off by the default request timeout.

### Added

- `client.close()` drains the connection pool. Safe to call more than once.
  A no-op when a custom `fetch` was supplied.

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

[Unreleased]: https://github.com/gravixlayer/gravixlayer-ts/compare/v0.1.18...HEAD
[0.1.18]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.18
[0.1.17]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.17
[0.1.16]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.16
[0.1.15]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.15
[0.1.14]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.14
[0.1.13]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.13
[0.1.12]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.12
[0.1.11]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.11
[0.1.10]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.10
[0.1.9]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.9
[0.1.8]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.8
[0.1.7]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.7
[0.1.6]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.6
[0.1.5]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.5
[0.1.4]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.4
[0.1.3]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.3
[0.1.0]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.0
