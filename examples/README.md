# Examples

Every example is a standalone script. Set an API key and run one:

```bash
export GRAVIXLAYER_API_KEY="your-api-key"
npx tsx examples/runtimes/01-create-runtime.ts
```

They import the package by name, exactly as your own code would.

## Environment

| Variable | Purpose |
| --- | --- |
| `GRAVIXLAYER_API_KEY` | Required. |
| `GRAVIXLAYER_TEMPLATE` | Template to boot. Defaults to `base-small`. |
| `GRAVIXLAYER_CLOUD` | Cloud for runtimes and template builds. Defaults to `aws`. |
| `GRAVIXLAYER_REGION` | Region for runtimes and template builds. Defaults to `us-east-1`. |

A guest cannot reach the internet unless a network policy allows it. Examples
that install a package or clone a repository attach a temporary allow-all
policy and remove it on the way out.

## Runtimes

| | |
| --- | --- |
| [01-create-runtime](runtimes/01-create-runtime.ts) | Create, inspect, and stop a sandbox. |
| [02-node-runtime](runtimes/02-node-runtime.ts) | Run JavaScript instead of Python. |
| [03-env-and-metadata](runtimes/03-env-and-metadata.ts) | Environment variables and metadata. |
| [04-run-python-code](runtimes/04-run-python-code.ts) | Execute code and read the result. |
| [05-run-shell-commands](runtimes/05-run-shell-commands.ts) | Shell commands, arguments, working directories. |
| [06-file-operations](runtimes/06-file-operations.ts) | The guest filesystem, end to end. |
| [07-code-contexts](runtimes/07-code-contexts.ts) | Keep interpreter state between calls. |
| [08-metrics](runtimes/08-metrics.ts) | CPU, memory, disk, and network usage. |
| [09-timeouts](runtimes/09-timeouts.ts) | Expire a sandbox automatically. |
| [10-list-and-inspect](runtimes/10-list-and-inspect.ts) | List templates and runtimes. |
| [11-automatic-cleanup](runtimes/11-automatic-cleanup.ts) | `await using`, and the `try`/`finally` equivalent. |
| [12-ssh-access](runtimes/12-ssh-access.ts) | Enable, use, revoke, and rotate SSH. |
| [13-reconnect](runtimes/13-reconnect.ts) | Attach to a sandbox another process created. |
| [14-git-operations](runtimes/14-git-operations.ts) | Clone, branch, commit, push. |
| [15-stream-output](runtimes/15-stream-output.ts) | Watch output arrive as it is produced. |
| [16-lifecycle](runtimes/16-lifecycle.ts) | Pause, resume, and stop. |
| [17-web-service](runtimes/17-web-service.ts) | Publish a guest port to a public HTTPS URL. |
| [18-terminal-sessions](runtimes/18-terminal-sessions.ts) | Drive an interactive shell. |
| [19-snapshots](runtimes/19-snapshots.ts) | Capture a sandbox and restore it. |
| [20-error-handling](runtimes/20-error-handling.ts) | Errors, timeouts, cancellation, retries. |
| [21-tracing](runtimes/21-tracing.ts) | OpenTelemetry spans for SDK calls. |

## Templates

| | |
| --- | --- |
| [01-python-image](templates/01-python-image.ts) | Build a Python template from a container image. |
| [02-node-image](templates/02-node-image.ts) | Build a Node template and run a server from it. |
| [03-git-clone](templates/03-git-clone.ts) | Bake a git repository into the image. |
| [04-dockerfile](templates/04-dockerfile.ts) | Build from a Dockerfile. |
| [05-list-and-delete](templates/05-list-and-delete.ts) | List, inspect, and delete templates. |

## Agents

| | |
| --- | --- |
| [hello-agent/](agents/hello-agent) | A minimal agent. It is an ordinary HTTP service. |
| [01-deploy](agents/01-deploy.ts) | Build and deploy from a source directory. |
| [02-invoke](agents/02-invoke.ts) | Call a deployed agent, whole or streamed. |
| [03-manage](agents/03-manage.ts) | Inspect images and deployments, and tear one down. |
| [04-agent-card](agents/04-agent-card.ts) | Publish a discovery card and an agent-to-agent endpoint. |

## Access control

| | |
| --- | --- |
| [network-policies/01-egress-control](network-policies/01-egress-control.ts) | Decide what a sandbox can reach. |
| [secrets/01-secret-providers](secrets/01-secret-providers.ts) | Inject credentials without putting them in code. |
