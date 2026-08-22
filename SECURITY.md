# Security policy

## Reporting a vulnerability

Please do not open a public issue.

Email **security@gravixlayer.ai** with enough detail to reproduce the problem:
affected version, the steps, and what an attacker could achieve. If you have a
proof of concept, include it.

We acknowledge reports within two business days and will keep you updated as we
investigate. Once a fix ships we are glad to credit you, unless you would
rather we did not.

## Supported versions

Security fixes land on the latest minor release. Please upgrade before
reporting an issue against an older version.

## Handling your API key

An API key grants full access to the account it belongs to. The SDK is built so
that the safe path is the easy one:

- **Never ship a key to a browser.** The client refuses to construct in one for
  this reason. Call the API from your own server, which holds the key, and give
  the browser a session of your own.
- **Keep it out of source control.** Read it from the environment, which is
  what the SDK does by default.
- **Rotate a key you have exposed.** Anything committed to a repository,
  written to a log, or pasted into a chat should be treated as public.

The SDK never writes your key to a log or attaches it to an error. An
authentication failure reports a fixed message rather than echoing the
response, so a key in a diagnostic body cannot escape that way.

## Secrets inside a runtime

Use a secret provider rather than baking credentials into a template or passing
them as plain environment variables. Values are write-only: they are injected
into the guest at execution time, and everything the API returns is masked.

## Network access from a runtime

A runtime starts fail-closed. Nothing leaves the guest until a network policy
allows it, and the baseline policy that enforces this cannot be detached.
Attaching several policies applies the most restrictive of them, so a policy
can only ever narrow access.

Grant the narrowest egress the workload needs — an allowlist of the hosts it
must reach, not `allow_all` — particularly when the runtime executes code you
did not write.
