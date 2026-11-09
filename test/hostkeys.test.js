import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HostKeyStore } from '../src/hostkeys.js';
import { fingerprintOfBlob } from '../src/agent.js';
import { tmpDir } from './helpers.js';

const keyA = Buffer.from('host-key-A');
const keyB = Buffer.from('host-key-B');

test('trust on first use, then pin', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'known.json');
  const store = new HostKeyStore(file);
  assert.equal(store.verify('pam:22', keyA).reason, 'first-use');
  assert.equal(store.verify('pam:22', keyA).reason, 'known');
  const changed = store.verify('pam:22', keyB);
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /HOST KEY CHANGED/);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  fs.rmSync(dir, { recursive: true });
});

test('pinned fingerprints and TOFU disabled', () => {
  const dir = tmpDir();
  const store = new HostKeyStore(path.join(dir, 'k.json'), { trustOnFirstUse: false });
  assert.equal(store.verify('pam:22', keyA).ok, false);
  assert.equal(store.verify('pam:22', keyA, [fingerprintOfBlob(keyA)]).ok, true);
  assert.equal(store.verify('pam:22', keyA, [`${fingerprintOfBlob(keyA)}=`]).ok, true);
  assert.equal(store.verify('pam:22', keyB, [fingerprintOfBlob(keyA)]).ok, false);
  fs.rmSync(dir, { recursive: true });
});
