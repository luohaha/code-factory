import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_AGENT_MANAGER_URL, defaultManagerUrlForLocation, normalizeManagerUrl } from './agent-manager-url.ts';

void test('remote dashboards connect to their own origin, including Tailscale HTTPS', () => {
  for (const address of [
    'https://dev-host.example-tailnet.ts.net/',
    'https://dev-host.example-tailnet.ts.net:8443/',
    'http://100.101.102.103:4310/',
    'http://dev-host:4310/',
    'http://192.168.1.10:3000/',
    'https://code-factory.example.com/requirements',
  ]) {
    const location = new URL(address);
    assert.equal(defaultManagerUrlForLocation(location), location.origin);
  }
});

void test('bundled local dashboards use the actual Manager port', () => {
  for (const address of [
    'http://localhost:4310/',
    'http://127.0.0.1:8080/',
    'http://[::1]:4310/',
  ]) {
    const location = new URL(address);
    assert.equal(defaultManagerUrlForLocation(location), location.origin);
  }
});

void test('standalone local development dashboards still connect to the default Manager', () => {
  for (const hostname of ['localhost', '127.0.0.1', '0.0.0.0', '[::1]']) {
    assert.equal(defaultManagerUrlForLocation(new URL(`http://${hostname}:3000/`)), DEFAULT_AGENT_MANAGER_URL);
  }
});

void test('Manager URLs accept HTTPS and custom ports and reject non-HTTP schemes', () => {
  assert.equal(normalizeManagerUrl(' https://dev-host.example-tailnet.ts.net/ '), 'https://dev-host.example-tailnet.ts.net');
  assert.equal(normalizeManagerUrl('https://dev-host.example-tailnet.ts.net:8443/'), 'https://dev-host.example-tailnet.ts.net:8443');
  assert.throws(() => normalizeManagerUrl('invalid url'), TypeError);
  assert.throws(() => normalizeManagerUrl('file:///tmp/factory'), /Only HTTP and HTTPS/);
});
