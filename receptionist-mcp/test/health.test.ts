import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Standalone test for MCP health logic — does not start the Express server.
function secretPresent(name: string): boolean {
  const v = process.env[name];
  return v !== undefined && v !== '';
}

function buildHealth() {
  return {
    status: 'ok',
    version: process.env.VERSION || 'dev',
    secrets: {
      SHARED_SECRET: secretPresent('SHARED_SECRET'),
      ACTOR_PROXY_SECRET: secretPresent('ACTOR_PROXY_SECRET'),
      ACTOR_PROXY_URL: secretPresent('ACTOR_PROXY_URL'),
    },
  };
}

describe('MCP /health logic', () => {
  const orig = { ...process.env };

  it('reports all secrets present when set', () => {
    process.env.SHARED_SECRET = 's3cret';
    process.env.ACTOR_PROXY_SECRET = 'actor-secret';
    process.env.ACTOR_PROXY_URL = 'https://actor.test';
    const body = buildHealth();
    assert.equal(body.status, 'ok');
    assert.ok(typeof body.version === 'string');
    assert.deepEqual(body.secrets, {
      SHARED_SECRET: true,
      ACTOR_PROXY_SECRET: true,
      ACTOR_PROXY_URL: true,
    });
  });

  it('reports false for missing or empty secrets', () => {
    delete process.env.SHARED_SECRET;
    delete process.env.ACTOR_PROXY_SECRET;
    delete process.env.ACTOR_PROXY_URL;
    const body = buildHealth();
    assert.deepEqual(body.secrets, {
      SHARED_SECRET: false,
      ACTOR_PROXY_SECRET: false,
      ACTOR_PROXY_URL: false,
    });
  });

  it('reports false for empty-string secrets', () => {
    process.env.SHARED_SECRET = '';
    process.env.ACTOR_PROXY_SECRET = '';
    process.env.ACTOR_PROXY_URL = '';
    const body = buildHealth();
    assert.deepEqual(body.secrets, {
      SHARED_SECRET: false,
      ACTOR_PROXY_SECRET: false,
      ACTOR_PROXY_URL: false,
    });
  });
});
