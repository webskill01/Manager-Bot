import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPublicHost } from '../core/globalConfig.js';

// The bug this guards: a hand-maintained PUBLIC_HOST printed a scan link to the wrong VPS.
const ifaces = {
  lo:   [{ family: 'IPv4', address: '127.0.0.1',      internal: true  }],
  eth0: [{ family: 'IPv4', address: '161.118.166.229', internal: false }],
};

test('picks the public IPv4 bound to the box', () => {
  assert.equal(detectPublicHost(ifaces), '161.118.166.229');
});

test('skips loopback, link-local and every private range', () => {
  for (const addr of ['10.0.0.5', '172.16.0.9', '172.31.255.1', '192.168.1.7', '169.254.1.1']) {
    const only = { eth0: [{ family: 'IPv4', address: addr, internal: false }] };
    assert.equal(detectPublicHost(only), 'localhost', `${addr} must not be offered as public`);
  }
  // 172.32.x is OUTSIDE the private block — the range ends at 172.31.
  assert.equal(detectPublicHost({ eth0: [{ family: 'IPv4', address: '172.32.0.1', internal: false }] }), '172.32.0.1');
});

test('behind NAT: falls back to PUBLIC_HOST, then localhost', () => {
  const nat = { eth0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }] };
  process.env.PUBLIC_HOST = '203.0.113.7';
  assert.equal(detectPublicHost(nat), '203.0.113.7');
  delete process.env.PUBLIC_HOST;
  assert.equal(detectPublicHost(nat), 'localhost');
});

test('ignores IPv6 and tolerates the numeric family older runtimes report', () => {
  assert.equal(detectPublicHost({
    eth0: [{ family: 'IPv6', address: '2a02:c207::1', internal: false },
           { family: 4,      address: '161.118.166.229', internal: false }],
  }), '161.118.166.229');
});
