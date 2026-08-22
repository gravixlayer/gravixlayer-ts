# Contributing

Thanks for taking the time. Bug reports, fixes, and documentation improvements
are all welcome.

## Getting set up

```bash
git clone https://github.com/gravixlayer/gravixlayer-ts.git
cd gravixlayer-ts
npm install
```

Node 18 or newer. There are no other prerequisites; the SDK itself has no
runtime dependencies.

## The loop

```bash
npm run test:watch     # tests, re-run on save
npm run check          # everything CI runs: format, lint, types, tests, build
```

Individually:

| | |
| --- | --- |
| `npm test` | Run the suite once. |
| `npm run test:coverage` | With a coverage report. |
| `npm run typecheck` | `tsc --noEmit` over sources, tests, and examples. |
| `npm run lint` | ESLint. `npm run lint:fix` for the automatic fixes. |
| `npm run format` | Prettier. |
| `npm run build` | Bundle to `dist/`, ESM and CommonJS with types. |

Run `npm run check` before opening a pull request. It is exactly what CI runs,
so a green result locally means a green result there.

## Tests

Tests never reach the network. `tests/helpers.ts` builds a client backed by a
scripted `fetch`, which makes it straightforward to assert the request that
went out as well as the value that came back:

```ts
const { client, http } = testClient([jsonResponse(runtimePayload())]);

const sandbox = await client.runtime.create({ template: 'base-small' });

expect(http.last().method).toBe('POST');
expect(http.jsonBody()).toMatchObject({ template: 'base-small' });
expect(sandbox.runtimeId).toBe(RUNTIME_ID);
```

A change to a request body, a URL, or a parsed field should come with a test
that would have caught it.

## Style

The linter and formatter settle the mechanics. Beyond them:

- **Mirror the API, but read like TypeScript.** The wire is snake_case; the
  public surface is camelCase. Translation belongs in the serializers and
  parsers under `src/types/`, not in resource methods.
- **No runtime dependencies.** Web standards only — `fetch`, streams,
  `TextEncoder`, `CompressionStream` — so the package runs on Node, Deno, Bun,
  and edge runtimes alike. Node built-ins are imported dynamically and only
  where a filesystem is genuinely required.
- **Validate before sending.** A mistake the SDK can catch locally should cost
  no round trip, and should raise `GravixLayerInvalidArgumentError`.
- **Reject, do not throw.** A method returning a promise should return a
  rejected promise on bad input rather than throwing synchronously, so a single
  `catch` covers it.
- **Comments explain why.** The code already says what it does. A comment earns
  its place by capturing a constraint or a trade-off that the code cannot.

## Adding an endpoint

1. Types and wire serializers in `src/types/`.
2. The method on the resource in `src/resources/`.
3. Tests covering the request that goes out and the value that comes back,
   including the failure path.
4. An export from `src/index.ts` if it is part of the public surface.
5. An example, if the capability is one a user would look for.

## Examples

Examples are documentation that runs. Each is standalone, imports the package
by name, and cleans up whatever it created — including in the failure path.
Keep the commentary to what the reader needs in order to follow along.

They are typechecked by `npm run typecheck` but not executed by CI, since they
create real infrastructure. Run the ones you touched against a real key before
submitting.

## Pull requests

- One concern per pull request.
- Explain the why in the description; the diff covers the what.
- Note any change to the public surface, and whether it is breaking.

## Reporting a vulnerability

Please do not open a public issue. See [SECURITY.md](SECURITY.md).
