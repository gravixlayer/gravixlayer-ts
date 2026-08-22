import { describe, expect, it } from 'vitest';

import { GravixLayerInvalidArgumentError } from '../src/index.js';
import { expectRejection, jsonResponse, RUNTIME_ID, testClient } from './helpers.js';

const PROVIDER = {
  id: 'prov-1',
  name: 'Model API',
  provider_type: 'api_key',
  is_active: true,
  secret_count: 1,
};

const SECRET = { id: 'sec-1', key: 'MODEL_API_KEY', masked: 'sk-…abcd', value_set: true };

describe('secret providers', () => {
  it('creates a provider with its secrets in one call', async () => {
    const { client, http } = testClient([jsonResponse({ provider: PROVIDER })]);
    const provider = await client.identity.providers.create('Model API', {
      secrets: [{ key: 'MODEL_API_KEY', value: 'sk-live-value' }],
    });

    expect(http.last().url).toContain('/v1/identity/providers');
    expect(http.jsonBody()).toEqual({
      name: 'Model API',
      provider_type: 'api_key',
      secrets: [{ key: 'MODEL_API_KEY', value: 'sk-live-value' }],
    });
    expect(provider.id).toBe('prov-1');
    expect(provider.isActive).toBe(true);
  });

  it('scopes a write to a project', async () => {
    const { client, http } = testClient([jsonResponse({ provider: PROVIDER })]);
    await client.identity.providers.create('Model API', { projectId: 'proj-1' });
    expect(http.query().get('project_id')).toBe('proj-1');
  });

  it('lists and filters providers', async () => {
    const { client, http } = testClient([jsonResponse({ providers: [PROVIDER], total: 1 })]);
    const result = await client.identity.providers.list({
      limit: 25,
      search: 'model',
      projectId: 'proj-1',
    });

    expect(http.query().get('limit')).toBe('25');
    expect(http.query().get('search')).toBe('model');
    expect(http.query().get('project_id')).toBe('proj-1');
    expect(result.total).toBe(1);
  });

  it('reads a provider and its masked secrets', async () => {
    const { client, http } = testClient([
      jsonResponse({ provider: { ...PROVIDER, secrets: [SECRET] } }),
      jsonResponse({ secrets: [SECRET] }),
    ]);

    const provider = await client.identity.providers.get('prov-1');
    expect(provider.secrets?.[0]?.key).toBe('MODEL_API_KEY');
    expect(provider.secrets?.[0]?.masked).toBe('sk-…abcd');
    expect(provider.secrets?.[0]?.valueSet).toBe(true);

    const { secrets } = await client.identity.providers.listSecrets('prov-1');
    expect(http.last().url).toContain('/providers/prov-1/secrets');
    expect(secrets).toHaveLength(1);
  });

  it('updates a provider', async () => {
    const { client, http } = testClient([jsonResponse({ provider: PROVIDER })]);
    await client.identity.providers.update('prov-1', {
      name: 'Renamed',
      providerType: 'oauth',
      isActive: false,
    });

    expect(http.last().method).toBe('PATCH');
    expect(http.jsonBody()).toEqual({
      name: 'Renamed',
      provider_type: 'oauth',
      is_active: false,
    });
  });

  it('adds, updates, and deletes a secret', async () => {
    const { client, http } = testClient([
      jsonResponse({ secret: SECRET }),
      jsonResponse({ secret: { ...SECRET, key: 'RENAMED' } }),
      jsonResponse({ success: true }),
    ]);

    await client.identity.providers.addSecret('prov-1', 'MODEL_API_KEY', 'sk-live');
    expect(http.jsonBody()).toEqual({ key: 'MODEL_API_KEY', value: 'sk-live' });

    const updated = await client.identity.providers.updateSecret('prov-1', 'sec-1', {
      key: 'RENAMED',
      value: 'sk-new',
    });
    expect(updated.key).toBe('RENAMED');

    const deleted = await client.identity.providers.deleteSecret('prov-1', 'sec-1');
    expect(http.last().method).toBe('DELETE');
    expect(deleted.success).toBe(true);
  });

  it('attaches and detaches a runtime', async () => {
    const { client, http } = testClient([
      jsonResponse({ success: true }),
      jsonResponse({ success: true }),
      jsonResponse({ providers: [PROVIDER] }),
    ]);

    await client.identity.providers.attach('prov-1', RUNTIME_ID);
    expect(http.last().url).toContain('/providers/prov-1/attach');
    expect(http.jsonBody()).toEqual({ runtime_id: RUNTIME_ID });

    await client.identity.providers.detach('prov-1', RUNTIME_ID);
    expect(http.last().method).toBe('DELETE');
    expect(http.last().url).toContain(`/providers/prov-1/attach/${RUNTIME_ID}`);

    const attached = await client.identity.providers.listForRuntime(RUNTIME_ID);
    expect(http.last().url).toContain(`/runtimes/${RUNTIME_ID}/providers`);
    expect(attached.total).toBe(1);
  });

  it('deletes a provider', async () => {
    const { client, http } = testClient([jsonResponse({ success: true })]);
    expect(await client.identity.providers.delete('prov-1')).toEqual({ success: true });
    expect(http.last().method).toBe('DELETE');
  });

  it('keeps an identifier inside its own path segment', async () => {
    const { client, http } = testClient([jsonResponse({ provider: PROVIDER })]);
    await client.identity.providers.get('../../runtimes/all');

    expect(http.last().url).toBe(
      'https://api.test.invalid/v1/identity/providers/..%2F..%2Fruntimes%2Fall',
    );
  });

  it('validates identifiers before sending anything', async () => {
    const { client, http } = testClient([jsonResponse({})]);

    await expectRejection(client.identity.providers.create(''), GravixLayerInvalidArgumentError);
    await expectRejection(
      client.identity.providers.addSecret('prov-1', '', 'v'),
      GravixLayerInvalidArgumentError,
    );
    await expectRejection(
      client.identity.providers.attach('prov-1', 'not-a-uuid'),
      GravixLayerInvalidArgumentError,
    );
    expect(http.requests).toHaveLength(0);
  });
});

const POLICY = {
  id: 'pol-1',
  name: 'model-access',
  egress_mode: 'allowlist',
  is_default: false,
  is_system: false,
  is_active: true,
  rule_count: 0,
};

const RULE = {
  id: 'rule-1',
  policy_id: 'pol-1',
  destination: 'api.example.test',
  port: 443,
  protocol: 'tcp',
};

describe('network policies', () => {
  it('creates a policy', async () => {
    const { client, http } = testClient([jsonResponse({ policy: POLICY })]);
    const policy = await client.networkPolicies.create('model-access', {
      description: 'outbound model calls',
    });

    expect(http.last().url).toBe('https://api.test.invalid/v1/network-policies');
    expect(http.jsonBody()).toEqual({
      name: 'model-access',
      egress_mode: 'allowlist',
      is_default: false,
      description: 'outbound model calls',
    });
    expect(policy.egressMode).toBe('allowlist');
  });

  it('adds the rules it was given after creating the policy', async () => {
    const { client, http } = testClient([
      jsonResponse({ policy: POLICY }),
      jsonResponse({ rule: RULE }),
      jsonResponse({ rule: { ...RULE, id: 'rule-2', destination: 'cdn.example.test' } }),
    ]);

    const policy = await client.networkPolicies.create('model-access', {
      rules: [
        { destination: 'api.example.test', port: 443 },
        { destination: 'cdn.example.test', port: 443, protocol: 'TCP' },
      ],
    });

    expect(http.requests).toHaveLength(3);
    expect(http.jsonBody(1)).toEqual({
      destination: 'api.example.test',
      port: 443,
      protocol: 'tcp',
    });
    expect(policy.rules).toHaveLength(2);
    expect(policy.ruleCount).toBe(2);
  });

  it('rolls the policy back when a rule cannot be added', async () => {
    const { client, http } = testClient([
      jsonResponse({ policy: POLICY }),
      new Response(JSON.stringify({ error: 'invalid destination' }), { status: 400 }),
      jsonResponse({ success: true }),
    ]);

    await expect(
      client.networkPolicies.create('model-access', {
        rules: [{ destination: 'api.example.test' }],
      }),
    ).rejects.toThrow('invalid destination');

    expect(http.requests).toHaveLength(3);
    expect(http.last().method).toBe('DELETE');
    expect(http.last().url).toContain('/pol-1');
  });

  it('says so when the rollback also fails', async () => {
    const { client } = testClient([
      jsonResponse({ policy: POLICY }),
      new Response(JSON.stringify({ error: 'invalid destination' }), { status: 400 }),
      new Response(JSON.stringify({ error: 'gone' }), { status: 500 }),
    ]);

    const error = await expectRejection(
      client.networkPolicies.create('p', { rules: [{ destination: 'x' }] }),
      GravixLayerInvalidArgumentError,
    );
    expect(error.message).toMatch(/could not be rolled back/);
  });

  it('rejects an unknown egress mode or protocol', async () => {
    const { client, http } = testClient([jsonResponse({ policy: POLICY })]);

    await expectRejection(
      client.networkPolicies.create('p', { egressMode: 'permit_all' }),
      GravixLayerInvalidArgumentError,
    );
    await expectRejection(
      client.networkPolicies.addRule('pol-1', 'example.test', { protocol: 'sctp' }),
      GravixLayerInvalidArgumentError,
    );
    expect(http.requests).toHaveLength(0);
  });

  it('accepts port 0 as any port but rejects one out of range', async () => {
    const { client, http } = testClient([jsonResponse({ rule: { ...RULE, port: 0 } })]);

    const rule = await client.networkPolicies.addRule('pol-1', 'example.test', { port: 0 });
    expect(http.jsonBody()).toEqual({ destination: 'example.test', port: 0, protocol: 'tcp' });
    expect(rule.port).toBe(0);

    await expectRejection(
      client.networkPolicies.addRule('pol-1', 'example.test', { port: 70000 }),
      GravixLayerInvalidArgumentError,
    );
  });

  it('validates pagination bounds', async () => {
    const { client, http } = testClient([jsonResponse({ policies: [] })]);

    await expectRejection(
      client.networkPolicies.list({ limit: 500 }),
      GravixLayerInvalidArgumentError,
    );
    await expectRejection(
      client.networkPolicies.list({ offset: -1 }),
      GravixLayerInvalidArgumentError,
    );
    expect(http.requests).toHaveLength(0);
  });

  it('fetches a policy with its rules when asked', async () => {
    const { client, http } = testClient([
      jsonResponse({ policy: POLICY }),
      jsonResponse({ rules: [RULE] }),
    ]);

    const withoutRules = await client.networkPolicies.get('pol-1');
    expect(withoutRules.rules).toBeUndefined();
    expect(http.requests).toHaveLength(1);

    const { client: client2, http: http2 } = testClient([
      jsonResponse({ policy: POLICY }),
      jsonResponse({ rules: [RULE] }),
    ]);
    const withRules = await client2.networkPolicies.get('pol-1', { includeRules: true });
    expect(http2.requests).toHaveLength(2);
    expect(withRules.rules).toHaveLength(1);
    expect(withRules.ruleCount).toBe(1);
  });

  it('updates a policy and a rule', async () => {
    const { client, http } = testClient([
      jsonResponse({ policy: { ...POLICY, egress_mode: 'deny_all' } }),
      jsonResponse({ rule: { ...RULE, port: 8443 } }),
    ]);

    const policy = await client.networkPolicies.update('pol-1', {
      egressMode: 'DENY_ALL',
      isActive: false,
    });
    expect(http.jsonBody()).toEqual({ egress_mode: 'deny_all', is_active: false });
    expect(policy.egressMode).toBe('deny_all');

    const rule = await client.networkPolicies.updateRule('pol-1', 'rule-1', { port: 8443 });
    expect(http.last().url).toContain('/pol-1/rules/rule-1');
    expect(rule.port).toBe(8443);
  });

  it('lists and deletes rules', async () => {
    const { client, http } = testClient([
      jsonResponse({ rules: [RULE] }),
      jsonResponse({ success: true }),
    ]);

    expect((await client.networkPolicies.listRules('pol-1')).rules).toHaveLength(1);
    expect(await client.networkPolicies.deleteRule('pol-1', 'rule-1')).toEqual({ success: true });
    expect(http.last().method).toBe('DELETE');
  });

  it('attaches and detaches a runtime', async () => {
    const { client, http } = testClient([
      jsonResponse({ success: true }),
      jsonResponse({ success: true }),
    ]);

    await client.networkPolicies.attach('pol-1', RUNTIME_ID);
    expect(http.last().url).toContain('/pol-1/attach');
    expect(http.jsonBody()).toEqual({ runtime_id: RUNTIME_ID });

    await client.networkPolicies.detach('pol-1', RUNTIME_ID);
    expect(http.last().url).toContain(`/pol-1/attach/${RUNTIME_ID}`);
  });

  it('hides the built-in baseline policy unless it is asked for', async () => {
    const policies = [
      POLICY,
      { id: 'sys-1', name: 'System Default', is_system: true, is_default: true },
    ];

    const { client } = testClient([jsonResponse({ policies })]);
    const visible = await client.networkPolicies.listForRuntime(RUNTIME_ID);
    expect(visible.policies.map((p) => p.id)).toEqual(['pol-1']);

    const { client: client2 } = testClient([jsonResponse({ policies })]);
    const all = await client2.networkPolicies.listForRuntime(RUNTIME_ID, { includeSystem: true });
    expect(all.total).toBe(2);
  });
});
