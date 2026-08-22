/**
 * Inject secrets into a runtime.
 *
 * A provider is a named bundle of key/value secrets. Attach one to a runtime
 * and its secrets appear as environment variables inside the guest, so
 * credentials stay out of your source and out of template images.
 *
 * Values are write-only: they go up once, and everything that comes back is
 * masked. To change one, replace it.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/secrets/01-secret-providers.ts
 *
 * Optional: DEMO_SECRET_VALUE, if you would rather inject a value of your own
 * than the throwaway one below.
 */

import { GravixLayer, type Runtime, type SecretProvider } from 'gravixlayer';

const client = new GravixLayer();
const providers = client.identity.providers;

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';
const SECRET_VALUE = process.env['DEMO_SECRET_VALUE'] ?? 'demo-value-not-a-real-key';
const NAME = `demo-provider-${Date.now()}`;

let provider: SecretProvider | undefined;
let runtime: Runtime | undefined;

try {
  // 1. Create the provider with a secret already on it.
  provider = await providers.create(NAME, {
    providerType: 'api_key',
    secrets: [{ key: 'MODEL_API_KEY', value: SECRET_VALUE }],
  });
  console.log(`Created    : ${provider.id} secrets=${provider.secretCount}`);

  // 2. Find it, then read it back. Only the mask comes back, never the value.
  const listed = await providers.list({ limit: 10, search: 'demo-provider' });
  console.log(`Listed     : ${listed.total} match(es)`);

  const detail = await providers.get(provider.id);
  console.log(`Fetched    : ${detail.name} active=${detail.isActive}`);
  for (const secret of detail.secrets ?? []) {
    console.log(
      `  ${secret.key.padEnd(16)} set=${secret.valueSet} masked=${secret.masked ?? 'n/a'}`,
    );
  }

  // 3. Rename it.
  provider = await providers.update(provider.id, { name: `${NAME}-renamed` });
  console.log(`\nRenamed    : ${provider.name}`);

  // 4. Secrets can be added, replaced, and removed independently.
  const extra = await providers.addSecret(provider.id, 'DEMO_TOKEN', 'token-v1');
  console.log(`Added      : ${extra.key}`);

  const rotated = await providers.updateSecret(provider.id, extra.id, { value: 'token-v2' });
  console.log(`Rotated    : ${rotated.key} set=${rotated.valueSet}`);

  await providers.deleteSecret(provider.id, extra.id);
  console.log(`Secrets now: ${(await providers.listSecrets(provider.id)).secrets.length}`);

  // 5. Attaching at creation means the secrets are present before the first
  //    line of your code runs.
  runtime = await client.runtimes.create({
    template: TEMPLATE,
    providers: [provider.id],
    timeoutSeconds: 600,
  });
  console.log(`\nRuntime    : ${runtime.runtimeId}`);

  // Print only a prefix: the whole point is not to move the value around.
  const seen = await runtime.runCode(
    "import os; print(os.environ.get('MODEL_API_KEY', '')[:6] or 'MISSING')",
  );
  console.log(`In guest   : MODEL_API_KEY starts with ${seen.stdout.trim()}`);

  // 6. Attachments can be listed, removed, and restored while it runs.
  const attached = await providers.listForRuntime(runtime.runtimeId);
  console.log(`Attached   : ${attached.providers.map((p) => p.name).join(', ')}`);

  await providers.detach(provider.id, runtime.runtimeId);
  console.log(`Detached   : ${(await providers.listForRuntime(runtime.runtimeId)).total} left`);

  await providers.attach(provider.id, runtime.runtimeId);
  console.log(`Re-attached: ${(await providers.listForRuntime(runtime.runtimeId)).total} attached`);
} finally {
  await runtime?.kill();
  if (provider) await providers.delete(provider.id);
  console.log('\nRuntime terminated and provider deleted.');
}
