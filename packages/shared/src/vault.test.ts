import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  envVault,
  isSecretRef,
  mapVault,
  resolveSecrets,
  secretName,
  secretRef,
} from './vault.ts';

describe('secretRef', () => {
  it('mints vault:NAME keywords and validates the name', () => {
    assert.equal(secretRef('GH_AGENT_PAT'), 'vault:GH_AGENT_PAT');
    assert.ok(isSecretRef(secretRef('GH_AGENT_PAT')));
    assert.ok(!isSecretRef('GH_AGENT_PAT'));
    assert.ok(!isSecretRef('sk-abc123'));
    assert.throws(() => secretRef('vault:NESTED'), /bad secret name/);
    assert.throws(() => secretRef('not a name'), /bad secret name/);
  });

  it('secretName extracts the keyword and rejects raw values', () => {
    assert.equal(secretName(secretRef('X')), 'X');
    assert.throws(() => secretName('ghp_rawtoken' as never), /keywords, never passed as values/);
    assert.throws(() => secretName('' as never), /vault reference/);
  });
});

describe('envVault', () => {
  it('resolves refs against the backing env', () => {
    const v = envVault({ GH_AGENT_PAT: 'tok123' });
    assert.equal(v.resolve(secretRef('GH_AGENT_PAT')), 'tok123');
  });

  it('throws on unset names and empty values', () => {
    const v = envVault({ EMPTY: '' });
    assert.throws(() => v.resolve(secretRef('MISSING')), /no value for MISSING/);
    assert.throws(() => v.resolve(secretRef('EMPTY')), /no value for EMPTY/);
  });

  it('scoped vaults refuse names outside the allowlist', () => {
    const v = envVault({ GH_AGENT_PAT: 't', OTHER_SECRET: 'x' }, ['GH_AGENT_PAT']);
    assert.equal(v.resolve(secretRef('GH_AGENT_PAT')), 't');
    assert.throws(() => v.resolve(secretRef('OTHER_SECRET')), /outside this vault's scope/);
    assert.equal(v.has('OTHER_SECRET'), false);
    assert.deepEqual(v.names(), ['GH_AGENT_PAT']);
  });

  it('a raw value passed where a ref is expected throws, never resolves', () => {
    const v = envVault({ GH_AGENT_PAT: 'ghp_leakme' });
    assert.throws(() => v.resolve('ghp_leakme' as never), /keywords/);
  });
});

describe('mapVault + resolveSecrets', () => {
  it('is scoped to exactly its keys', () => {
    const v = mapVault({ POSTHOG_API_KEY: 'phx_1' });
    assert.equal(v.resolve(secretRef('POSTHOG_API_KEY')), 'phx_1');
    assert.throws(() => v.resolve(secretRef('GH_AGENT_PAT')), /scope/);
  });

  it('resolveSecrets maps target env names through refs', () => {
    const v = mapVault({ PI_API_KEY: 'sk-pi' });
    assert.deepEqual(
      resolveSecrets({ ANTHROPIC_API_KEY: secretRef('PI_API_KEY') }, v),
      { ANTHROPIC_API_KEY: 'sk-pi' },
    );
  });
});
