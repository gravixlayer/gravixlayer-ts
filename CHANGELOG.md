# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
## [0.1.24] - 2026-09-26
### Changed
- `runCmd` and `streamCmd` accept `timeoutSeconds: 0`. That sends `timeout: 0`, which is the server default: 300 seconds in the foreground and no deadline in the background. The HTTP timeout stays the client default.

### Fixed
- A streamed command keeps `error` from the `end` event. A unary command already did. `streamCmd` includes it on the end event, and `runCmd` puts it on the result.
- A background command that exits before it has a pid returns a handle with `pid: null`. `wait()`, `refresh()`, and `kill()` return that result and do not call the command routes. Before, the handle stored pid `0` and those calls failed before the exit code could be read.
- The package no longer depends on an older published copy of itself. That dependency had come back in the working tree and would have installed a second copy of the SDK.
- An agent source archive leaves out `.env`, `.env.*`, and `.envrc`. `.env` and `gravixlayer/.env.local` are still loaded as the build environment.

## [0.1.23] - 2026-09-26
### Fixed
- `CommandHandle.disconnect()` stops every open `wait()` on the handle. Before, it stopped only the most recent one, and never a wait that was given its own `signal`. A caller's `signal` still stops only its own wait.
- The package no longer depends on an older published copy of itself, so an install pulls in one copy of the SDK.
- `VERSION` and the `user-agent` header report the installed version. They were stuck at 0.1.13.
- A response body is read under the call's `timeout` and `signal`. Before, a server that sent headers and then stalled could hang the call forever. A stalled, aborted, or broken body now throws `GravixLayerTimeoutError`, `GravixLayerAbortError`, or `GravixLayerConnectionError`.
- A stream that breaks partway through throws `GravixLayerConnectionError`, `GravixLayerAbortError`, or `GravixLayerTimeoutError` instead of a raw `TypeError`.
- `streamCmd`, `runCode`, and `streamCode` throw `GravixLayerConnectionError` when the stream closes before its final event. Before, they returned as if the run had finished.
- The Node HTTP client resolves a hostname again every 30 seconds and moves off an address that refuses or times out on connect. Before, it kept the first answer for the life of the client.
- A connect failure no longer turns HTTP/2 off for an origin for the life of the client. Only a server that does not offer HTTP/2 moves the origin to HTTP/1.1.
- `ServiceHandle.request` rejects a path that resolves to another origin, so the service's access token is never sent there.
- `TemplateBuilder.waitForUrl`, `waitForFile`, and `waitForProcess` quote their arguments, so a value with spaces or shell characters reaches the command unchanged.
- Building an agent from a project directory reads `.env` lines written as `export KEY=value`.
- An archive entry path with a `..` segment is rejected, and a path that starts with a backslash stays relative.
- An error event from `file.watch` throws `GravixLayerError`. It was `GravixLayerInvalidArgumentError`, which reads as a caller mistake.
- A command result's `durationMs` falls back to a monotonic clock, so a system clock change can't make it negative.
- `command.get`, `command.kill`, and `command.connect` reject a `pid` that isn't a positive integer before sending a request.
- Aborting an HTTP/2 call after its headers arrive cancels the stream on the server and fails the body read with an abort error. Before, the stream stayed open and the body ended as if complete.

### Changed
- A background `runCmd` with output callbacks no longer drops a failure while following the output. A broken stream or a callback that throws goes to the new `onError` option and stays on `handle.error`. Stopping the follow with `disconnect()` or `signal` is not a failure.
- The API key is sent only to the API's origin. A request to another origin, such as `agents.invoke` and `agents.stream` calling an agent's endpoint, does not carry it. Pass an `authorization` header on the request if that endpoint needs one.
- `agents.invoke` and `agents.stream` remember each agent's endpoint instead of looking it up on every call. A failed call or `agents.destroy` forgets it.
- `FormData` bodies sent by the Node HTTP client stream with an exact `content-length` instead of being buffered in memory first.
- Telemetry spans leave the query string out of `url.full`.
- Reading a project directory for an agent build lists and reads files in parallel.
- `agents.stream<T>()` yields `T | RawStreamEvent`. An event whose data is not JSON already arrived as `{ raw }`; the type now says so. Check `'raw' in event` before reading your own fields.

### Added
- `onError` on `runCmd` options, `CommandHandle.error`, and `CommandHandle.follow()`, which follows output in the background with the same callbacks. New `CommandFollowOptions` type.
- `RawStreamEvent` type for a streamed event whose data is not JSON.

## [0.1.22] - 2026-09-24
### Fixed
- POST and PATCH are no longer retried after a connection failure or a 502, 503, or 504. A retry could repeat work the server had already done. A 429 is still retried, because the server refused the call. GET, PUT, and DELETE keep their retries.

### Added
- `runCmd(..., { background: true })` returns a `CommandHandle` (`wait`, `kill`,
  `refresh`, `disconnect`). `client.runtime.command` and `sandbox.command` list,
  inspect, attach to, and stop those commands. Command results include
  `timedOut`, and a live stream uses the server's `duration_ms`.
- `wait()` and `command.connect()` throw `GravixLayerConnectionError` when the
  stream breaks before the command ends, because a background command may
  still be running. A broken `runCmd` stream still returns a failed result
  with the message on stderr, and one that closes without an `end` throws.

## [0.1.21] - 2026-08-29

## Fixed
- Fixed template build pipeline bug

## [0.1.20] - 2026-08-29
### Changed
- API errors prefer the product `message` over the short `error` label, and
  expose `code` on every `GravixLayerError`. `print`/`message` is one line.

## [0.1.19] - 2026-08-29
### Changed
- Occupancy quota is HTTP 403 and is not retried. 429 is only the create-rate
  window and still retries with backoff.

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

[Unreleased]: https://github.com/gravixlayer/gravixlayer-ts/compare/v0.1.24...HEAD
[0.1.24]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.24
[0.1.23]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.23
[0.1.22]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.22
[0.1.21]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.21
[0.1.20]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.20
[0.1.19]: https://github.com/gravixlayer/gravixlayer-ts/releases/tag/v0.1.19
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
