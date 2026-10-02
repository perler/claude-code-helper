#!/usr/bin/env node
// Scrollback replay for dtach sessions — dependency-free, no `vscode`, so it runs both
// as the CLI the attach line calls and as a module the tests require.
//
//   node replay.js <log> [max-bytes]     print the filtered tail of <log> to stdout
//
// Why it exists: dtach keeps no history. A tab only has scrollback for output that
// arrived while it was attached; a fresh `dtach -a` gets just Claude's SIGWINCH repaint,
// one screenful (measured 2026-10-02: a tab attached from the start held all 150 lines /
// 31 KB, a fresh same-size attach 313 bytes). The master therefore runs under util-linux
// `script`, which logs everything to <socket dir>/<id>.log (see recorderArgs in
// launch.js), and the attach line prints the tail of that log before `dtach -a`.
// Node rather than python3: the extension is node, the filter is unit-tested by requiring
// this very file, and the extension host's own node binary is always there.
//
// The log is a raw terminal stream, so replaying it blindly would be hazardous in two
// ways, both handled here:
//  1. It contains the QUERIES programs sent their terminal (device attributes, cursor
//     position, colour requests ...). Replayed into a live tab, the terminal answers
//     each one and the answer is typed into whatever reads the tab's stdin next — the
//     shell, then Claude's prompt. All of those are stripped (stripQueries).
//  2. A tail cut at a byte offset can begin inside an escape sequence or a UTF-8
//     character, so it is cut forward to just after the first newline.
// `script` also writes "Script started on ..." / "Script done on ..." lines into the log;
// those are dropped too.
const fs = require('fs');

const ESC = '\\x1b', BEL = '\\x07', ST = `(?:${BEL}|${ESC}\\\\)`;
const QUERY_PATTERNS = [
  `${ESC}\\[0?c`,                       // DA1
  `${ESC}\\[>0?c`,                      // DA2
  `${ESC}\\[=0?c`,                      // DA3
  `${ESC}Z`,                            // DECID (old DA1)
  `${ESC}\\[>0?q`,                      // XTVERSION
  `${ESC}\\[[56]n`,                     // DSR status / cursor position (CPR)
  `${ESC}\\[\\?[0-9;]*n`,               // DECXCPR ?6n, ?15n, ?996n colour scheme ...
  `${ESC}\\[\\??[0-9;]*\\$p`,           // DECRQM (mode query), ANSI and private
  `${ESC}\\[\\?u`,                      // kitty keyboard flags query
  `${ESC}\\[\\?[0-9;]*m`,               // XTQMODKEYS (query modifyOtherKeys)
  `${ESC}\\[(?:1[4-9]|2[0-1])(?:;[0-9]+)*t`, // window-size / title reports (14t 16t 18t 19t 20t 21t)
  `${ESC}\\][0-9;a-z]*;\\?${ST}`,       // OSC queries: 10;? 11;? 4;n;? 52;c;? ... BEL or ST terminated
  `${ESC}P[+$]q[^\\x1b\\x07]*${ST}`,    // XTGETTCAP (+q) and DECRQSS ($q), DCS ... ST
  '\\x05',                              // ENQ (answerback)
];
const QUERY_RE = new RegExp(QUERY_PATTERNS.join('|'), 'g');
const SCRIPT_LINE_RE = /^Script (?:started|done) on [^\n]*\n?/gm;

// Pure: bytes (as a latin1 string, so every byte survives a round trip) in, filtered out.
function stripQueries(s) {
  return s.replace(QUERY_RE, '').replace(SCRIPT_LINE_RE, '');
}

// The last `max` bytes of `file` as a Buffer, starting at a clean boundary: when the file
// is longer than `max`, everything up to and including the first newline of the tail is
// dropped. Empty Buffer for a missing/empty file.
function readTail(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    let out = buf.subarray(0, got);
    if (start > 0) {
      const nl = out.indexOf(0x0a);
      out = nl < 0 ? Buffer.alloc(0) : out.subarray(nl + 1);
    }
    return out;
  } catch { return Buffer.alloc(0); }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// What the tab receives: the filtered tail, attributes reset, then one newline per
// terminal row. dtach -a opens with ESC[H ESC[J, which clears the VISIBLE screen only
// and leaves scrollback alone; the newlines scroll the replayed tail up into scrollback
// first, so the clear lands on blank rows below it instead of wiping the history.
function buildReplay(file, max, rows) {
  const tail = readTail(file, max);
  if (!tail.length) return Buffer.alloc(0);
  const body = Buffer.from(stripQueries(tail.toString('latin1')), 'latin1');
  return Buffer.concat([body, Buffer.from('\x1b[0m' + '\r\n'.repeat(Math.max(1, rows || 50)), 'latin1')]);
}

function main() {
  const [file, maxArg] = process.argv.slice(2);
  if (!file) return;
  const max = parseInt(maxArg, 10) > 0 ? parseInt(maxArg, 10) : 4194304;
  const out = buildReplay(file, max, process.stdout.rows || parseInt(process.env.LINES, 10) || 50);
  if (!out.length) return;
  // Synchronous writes in a loop: a multi-MB write to a tty can be partial or hit EAGAIN.
  let i = 0;
  while (i < out.length) {
    try { i += fs.writeSync(1, out, i, Math.min(65536, out.length - i)); }
    catch (e) { if (e.code !== 'EAGAIN') return; }
  }
}

if (require.main === module) main();
module.exports = { stripQueries, readTail, buildReplay };
