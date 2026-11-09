import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  MarkerParser, wrapCommand, validateCommand, buildPrelude, shellQuote, syncLine,
} from '../src/ssh/shell-session.js';
import { OutputCollector, TextNormalizer, stripAnsi } from '../src/ssh/output.js';

const NONCE = 'abc123';

function runParser(stream, chunkSize) {
  const p = new MarkerParser(NONCE);
  const c = new OutputCollector(100_000);
  p.expectCommand(1, c);
  const events = [];
  for (let i = 0; i < stream.length; i += chunkSize) events.push(...p.feed(stream.slice(i, i + chunkSize)));
  return { events, output: c.finish() };
}

test('parser extracts output between markers at any chunk boundary', () => {
  const stream = 'echoed junk __PAMSSH_abc123_1 _B__\n'
    + '__PAMSSH_abc123_1_B__\nline1\nline2 with __PAMSSH_ lookalike\n'
    + '\n__PAMSSH_abc123_1_E__:3:/var/tmp:with:colons\nprompt$ ';
  for (const size of [1, 2, 3, 7, 13, 64, stream.length]) {
    const { events, output } = runParser(stream, size);
    assert.deepEqual(events, [{ type: 'end', seq: 1, exitCode: 3, cwd: '/var/tmp:with:colons' }], `chunk ${size}`);
    assert.equal(output, 'line1\nline2 with __PAMSSH_ lookalike\n', `chunk ${size}`);
  }
});

test('output without trailing newline and empty output', () => {
  assert.equal(runParser('__PAMSSH_abc123_1_B__\nabc\n__PAMSSH_abc123_1_E__:0:/\n', 5).output, 'abc');
  assert.equal(runParser('__PAMSSH_abc123_1_B__\n\n__PAMSSH_abc123_1_E__:0:/\n', 5).output, '');
});

test('END without BEGIN (interrupted early) and stale markers are handled', () => {
  const p = new MarkerParser(NONCE);
  p.expectCommand(2, new OutputCollector(1000));
  // stale END of seq 1 must be ignored
  assert.deepEqual(p.feed('\n__PAMSSH_abc123_1_E__:0:/\n'), []);
  assert.deepEqual(p.feed('^C\n__PAMSSH_abc123_2_E__:130:/root\n'),
    [{ type: 'end', seq: 2, exitCode: 130, cwd: '/root' }]);
});

test('drain discards output after interrupt but still finds END', () => {
  const p = new MarkerParser(NONCE);
  const c = new OutputCollector(1000);
  p.expectCommand(5, c);
  p.feed('__PAMSSH_abc123_5_B__\nbefore\n');
  p.drain();
  const ev = p.feed('^Cstty -echo; printf junk\n\n__PAMSSH_abc123_5_E__:130:/\n');
  assert.equal(ev[0].exitCode, 130);
  assert.equal(c.finish(), 'before\n');
});

test('ready marker', () => {
  const p = new MarkerParser(NONCE);
  p.expectReady();
  assert.deepEqual(p.feed("banner\nprintf '%s%s\\n' '__PAMSSH_abc123' '_READY__'\n__PAMSSH_abc1"), []);
  assert.deepEqual(p.feed('23_READY__\n'), [{ type: 'ready' }]);
});

test('wire format survives quotes, $, backslashes and syntax errors in a real sh', () => {
  const cases = [
    { cmd: `echo 'single' "double" \\$HOME back\\\\slash`, out: 'single double $HOME back\\slash\n', code: 0 },
    { cmd: "printf '%s\\n' \"it's\"", out: "it's\n", code: 0 },
    { cmd: 'echo "unterminated', code: 2 },
    { cmd: 'cd / && x=1\necho "$x $PWD"', out: '1 /\n', code: 0 },
    { cmd: 'exit_code() { return 42; }; exit_code', out: '', code: 42 },
    { cmd: 'cat; echo after-cat', out: 'after-cat\n', code: 0 },
  ];
  for (const [i, c] of cases.entries()) {
    const wire = wrapCommand(NONCE, i + 1, validateCommand(c.cmd));
    const r = spawnSync('/bin/sh', ['-i'], { input: wire, encoding: 'utf8' }); // interactive like a PAM login
    const p = new MarkerParser(NONCE);
    const col = new OutputCollector(10_000);
    p.expectCommand(i + 1, col);
    const [ev] = p.feed(r.stdout);
    assert.ok(ev, `no END marker for ${c.cmd}: ${r.stdout} ${r.stderr}`);
    if (c.code === 2) assert.notEqual(ev.exitCode, 0, c.cmd);
    else assert.equal(ev.exitCode, c.code, c.cmd);
    if (c.out !== undefined) assert.equal(col.finish(), c.out, c.cmd);
  }
});

test('prelude and sync line are valid sh', () => {
  const r = spawnSync('/bin/sh', [], { input: buildPrelude(NONCE, ['export X=1']) + syncLine(NONCE, 9, 130), encoding: 'utf8' });
  assert.match(r.stdout, /__PAMSSH_abc123_READY__\n/);
  assert.match(r.stdout, /__PAMSSH_abc123_9_E__:130:/);
});

test('validateCommand rejects control chars and long lines', () => {
  assert.throws(() => validateCommand(''), /non-empty/);
  assert.throws(() => validateCommand('echo \x03'), /control characters/);
  assert.throws(() => validateCommand('echo ' + 'x'.repeat(5000)), /exceeds/);
  assert.equal(validateCommand('a\r\nb\tc'), 'a\nb\tc');
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('OutputCollector keeps head and tail', () => {
  const c = new OutputCollector(1000);
  for (let i = 0; i < 1000; i++) c.push(`line ${i}\n`);
  const out = c.finish();
  assert.ok(c.truncated);
  assert.ok(out.startsWith('line 0\n'));
  assert.ok(out.endsWith('line 999\n'));
  assert.match(out, /characters truncated/);
  assert.ok(out.length < 1100);
});

test('carriage-return progress output collapses to what a terminal shows', () => {
  const c = new OutputCollector(1000);
  c.push('progress:10%\r50%\r100%\nplain\n\rtrailing-cr-line\r\n');
  assert.equal(c.finish(), '100%\nplain\ntrailing-cr-line\n');
});

test('TextNormalizer handles CRLF and UTF-8 split across chunks', () => {
  const n = new TextNormalizer();
  const bytes = Buffer.from('a\r\n你好\r\n');
  let s = '';
  for (const b of bytes) s += n.push(Buffer.from([b]));
  assert.equal(s, 'a\n你好\n');
  assert.equal(stripAnsi('\x1b[?2004h\x1b[31mred\x1b[0m\x1b]0;title\x07'), 'red');
});
