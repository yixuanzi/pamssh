import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPolicy } from '../src/policy.js';
import { exampleConfig } from '../src/config.js';

test('deny rules win, allow rules are per layer', () => {
  const global = { allow: [], deny: ['\\bshutdown\\b'] };
  const target = { allow: ['^(ls|cat|grep)\\b'], deny: [] };
  assert.equal(checkPolicy('ls -la', [global, target]).allowed, true);
  assert.equal(checkPolicy('shutdown -h now', [global, target]).allowed, false);
  assert.match(checkPolicy('rm x', [global, target]).reason, /allow rule/);
  // multiline: ^ anchors at every line
  assert.equal(checkPolicy('echo hi\nls', [global, { allow: ['^ls$'], deny: [] }]).allowed, true);
});

test('example deny list blocks catastrophic commands only', () => {
  const layers = [exampleConfig({ authToken: 'x' }).policy];
  for (const bad of ['rm -rf /', 'sudo rm -rf / ', 'rm -fr /*', 'mkfs.ext4 /dev/sdb1', 'dd if=/dev/zero of=/dev/sda',
    'reboot', 'sudo reboot', 'echo x; shutdown -r now', 'systemctl reboot', ':(){ :|:& };:']) {
    assert.equal(checkPolicy(bad, layers).allowed, false, bad);
  }
  for (const ok of ['rm -rf ./build', 'rm -rf /tmp/cache', 'ls /', 'df -h', 'systemctl status nginx --no-pager',
    'grep reboot /var/log/syslog', 'last reboot']) {
    assert.equal(checkPolicy(ok, layers).allowed, true, ok);
  }
});
