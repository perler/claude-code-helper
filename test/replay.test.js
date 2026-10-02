#!/usr/bin/env node
// Tests lib/replay.js: the filter that keeps terminal QUERIES out of a scrollback replay
// (the terminal would answer them into the shell / Claude's prompt), the clean-boundary
// tail cut, and the tail the tab gets (reset + one newline per row).
// Run: node test/replay.test.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { stripQueries, readTail, buildReplay } = require('../lib/replay');

const E = '\x1b';
const queries = {
  'DA1 bare': `${E}[c`, 'DA1 0': `${E}[0c`, 'DA2': `${E}[>c`, 'DA2 0': `${E}[>0c`, 'DA3': `${E}[=0c`,
  'DECID': `${E}Z`, 'XTVERSION 0': `${E}[>0q`, 'XTVERSION': `${E}[>q`,
  'DSR 5': `${E}[5n`, 'CPR 6': `${E}[6n`, 'DECXCPR ?6': `${E}[?6n`, 'DSR ?996': `${E}[?996n`,
  'DECRQM private': `${E}[?2026$p`, 'DECRQM ansi': `${E}[4$p`, 'kitty kbd': `${E}[?u`,
  'XTQMODKEYS': `${E}[?4m`, 'winop 14t': `${E}[14t`, 'winop 18t': `${E}[18t`, 'winop 22;0t not a query': null,
  'OSC 10 BEL': `${E}]10;?\x07`, 'OSC 11 ST': `${E}]11;?${E}\\`, 'OSC 4 BEL': `${E}]4;5;?\x07`, 'OSC 4 ST': `${E}]4;12;?${E}\\`,
  'OSC 52 read': `${E}]52;c;?\x07`, 'XTGETTCAP': `${E}P+q544e${E}\\`, 'DECRQSS': `${E}P$qm${E}\\`, 'ENQ': '\x05',
};
for (const [name, q] of Object.entries(queries)) {
  if (q === null) continue;
  assert.strictEqual(stripQueries(`a${q}b`), 'ab', `${name} must be stripped`);
}

// Ordinary output, colours, cursor moves, mode SETs, OSC titles/hyperlinks and the
// OSC set-colour forms (no `?`) survive untouched.
const keep = [
  `${E}[31mred${E}[0m`, `${E}[2K${E}[1A${E}[G`, `${E}[?2004h${E}[?25l${E}[?2026h`, `${E}[>1u`, `${E}[22;0t`,
  `${E}]0;title\x07`, `${E}]8;;https://x.y${E}\\link${E}]8;;${E}\\`, `${E}]11;rgb:00/00/00\x07`,
  `${E}[1;5H`, `${E}[38;5;12m`, 'plain text with ? and n and c', `${E}[10;20r`,
];
for (const k of keep) assert.strictEqual(stripQueries(k), k, `must survive: ${JSON.stringify(k)}`);

// Several queries in a row, mixed with text.
assert.strictEqual(stripQueries(`x${E}[c${E}[>0q${E}[6n${E}]11;?\x07y`), 'xy');
// script's own bookkeeping lines.
assert.strictEqual(stripQueries('Script started on 2026-10-02 08:29:05+02:00 [COMMAND="bash r.sh"]\nhi\r\n'), 'hi\r\n');
assert.strictEqual(stripQueries('hi\r\n\nScript done on 2026-10-02 08:29:28+02:00 [COMMAND_EXIT_CODE="0"]\n'), 'hi\r\n\n');
// Non-ASCII bytes survive the latin1 round trip.
const utf8 = Buffer.from('✻ Cogitating… ü\r\n');
assert.ok(Buffer.from(stripQueries(utf8.toString('latin1')), 'latin1').equals(utf8));

// Tail cut: starts after the first newline of the tail, never inside a line.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-replay-'));
const log = path.join(tmp, 'x.log');
const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(3, '0')}\r\n`);
fs.writeFileSync(log, lines.join(''));
assert.strictEqual(readTail(log, 1e6).toString(), lines.join(''), 'short file: whole file');
const cut = readTail(log, 50).toString();
assert.ok(/^line \d{3}\r\n/.test(cut) && lines.join('').endsWith(cut), 'cut tail starts on a line boundary: ' + JSON.stringify(cut));
assert.strictEqual(readTail(log, 5).length, 0, 'no newline in the tail: nothing');
assert.strictEqual(readTail(path.join(tmp, 'missing.log'), 100).length, 0);

// What the tab gets.
fs.writeFileSync(log, `Script started on 2026-10-02 08:29:05+02:00 []\nhello${E}[c\r\nworld\r\n`);
const out = buildReplay(log, 1e6, 7).toString();
assert.strictEqual(out, `hello\r\nworld\r\n${E}[0m${'\r\n'.repeat(7)}`);
assert.strictEqual(buildReplay(path.join(tmp, 'missing.log'), 100, 7).length, 0);

fs.rmSync(tmp, { recursive: true });
console.log('replay: ok');
