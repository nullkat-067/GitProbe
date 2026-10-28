#!/usr/bin/env node
'use strict';
/*
 * GitProbe - GitHub Intelligence CLI
 * Made by: NullKat (NullKat Development)
 *
 * Single-file, zero-dependency Node.js program (built-in modules only).
 * Run:  node probe.js
 * Optional: export GITHUB_TOKEN=xxxx  (raises the API rate limit; never printed or saved)
 */

const https = require('https');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');

const NAME = 'GitProbe';
const VERSION = '1.1.0';
const API_HOST = 'api.github.com';
const PER_PAGE = 100;
const INITIAL_PAGES = 3;
const MORE_PAGES = 5;
const HARD_CAP_PAGES = 30;
const LIST_PAGE_SIZE = 8;
const REQUEST_TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_BYTES = 25 * 1024 * 1024;

process.stdout.on('error', () => {});
const argv = process.argv.slice(2);
const env = process.env;
const IS_TTY = Boolean(process.stdout.isTTY);
const DEBUG = env.GITPROBE_DEBUG === '1';
const FAST = argv.includes('--fast') || env.GITPROBE_FAST === '1';

/* ------------------------------------------------------------------ */
/* Terminal capabilities, colors, glyphs                               */
/* ------------------------------------------------------------------ */

function detectColor() {
  if (argv.includes('--no-color')) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false') return true;
  return IS_TTY && env.TERM !== 'dumb';
}

function detectDepth() {
  const ct = String(env.COLORTERM || '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit') || env.FORCE_COLOR === '3' || /com\.termux/.test(env.PREFIX || '')) return 24;
  if (String(env.TERM || '').includes('256') || env.TERM_PROGRAM) return 8;
  return 4;
}

const DEPTH = detectDepth();
const settings = { color: detectColor(), rgb: true, anim: true };
const UNICODE = !argv.includes('--ascii') && env.TERM !== 'dumb' && env.TERM !== 'linux';
const G = UNICODE
  ? { ok: '\u2714', bad: '\u2716', warn: '!', dot: '\u2022', star: '\u2605', h: '\u2500', v: '\u2502', bar: '\u2588', bar0: '\u2591', arrow: '\u203a', ell: '\u2026', dia: '\u25c6', tl: '\u256d', tr: '\u256e', bl: '\u2570', br: '\u256f', lt: '\u251c', rt: '\u2524', mid: '\u00b7' }
  : { ok: '+', bad: 'x', warn: '!', dot: '-', star: '*', h: '-', v: '|', bar: '#', bar0: '.', arrow: '>', ell: '~', dia: '*', tl: '+', tr: '+', bl: '+', br: '+', lt: '+', rt: '+', mid: '-' };

const ESC = '\x1b[';
const RESET = ESC + '0m';

function to256(r, g, b) {
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    const v = Math.round(((r - 8) / 247) * 24) + 232;
    return Math.min(255, Math.max(232, v));
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

function fgCode(r, g, b) {
  if (DEPTH === 24) return '38;2;' + r + ';' + g + ';' + b;
  if (DEPTH === 8) return '38;5;' + to256(r, g, b);
  return String(30 + (r > 127 ? 1 : 0) + (g > 127 ? 2 : 0) + (b > 127 ? 4 : 0));
}

function paint(codes, text) {
  return settings.color ? ESC + codes + 'm' + text + RESET : String(text);
}

const C = {
  red: fgCode(255, 45, 70),
  white: fgCode(245, 245, 245),
  gray: fgCode(125, 130, 140),
  green: fgCode(80, 220, 130),
  yellow: fgCode(255, 200, 70),
  cyan: fgCode(90, 200, 255),
};

const st = {
  red: (t) => paint(C.red, t),
  rb: (t) => paint('1;' + C.red, t),
  white: (t) => paint(C.white, t),
  wb: (t) => paint('1;' + C.white, t),
  gray: (t) => paint(C.gray, t),
  green: (t) => paint(C.green, t),
  yellow: (t) => paint(C.yellow, t),
  cyan: (t) => paint(C.cyan, t),
  bold: (t) => paint('1', t),
  ital: (t) => paint('3', t),
};

function hsv(h) {
  h = ((h % 360) + 360) % 360;
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return 1 - Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [Math.round(255 * f(5)), Math.round(255 * f(3)), Math.round(255 * f(1))];
}

function rainbow(text, phase) {
  phase = phase || 0;
  if (!settings.color) return text;
  if (!settings.rgb) return st.rb(text);
  let s = '';
  let i = 0;
  for (const ch of String(text)) {
    const c = hsv(phase + i * 50);
    s += ESC + '1;' + fgCode(c[0], c[1], c[2]) + 'm' + ch;
    i++;
  }
  return s + RESET;
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

const RED = [255, 45, 70];
const DEEP = [150, 20, 40];
const SOFT = [255, 225, 228];

function mix(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function gradText(text, a, b, bold) {
  if (!settings.color) return String(text);
  const chars = Array.from(String(text));
  let r = '';
  chars.forEach((ch, i) => {
    if (ch === ' ') { r += ch; return; }
    const c = mix(a, b, chars.length > 1 ? i / (chars.length - 1) : 0);
    r += ESC + (bold ? '1;' : '') + fgCode(c[0], c[1], c[2]) + 'm' + ch;
  });
  return r + RESET;
}

function gradientLine(text, rowT) {
  if (!settings.color) return text;
  const A = [255, 40, 60];
  const B = [245, 245, 245];
  const chars = Array.from(text);
  let s = '';
  chars.forEach((ch, x) => {
    if (ch === ' ') { s += ch; return; }
    const t = Math.min(1, (x / Math.max(1, chars.length)) * 0.55 + rowT * 0.45);
    s += ESC + '1;' + fgCode(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)) + 'm' + ch;
  });
  return s + RESET;
}

/* cursor helper: write `text` on a line `up` rows above the cursor, then come back */
function at(up, col, text) {
  return '\x1b[' + up + 'A\r' + (col > 0 ? '\x1b[' + col + 'C' : '') + text + '\x1b[' + up + 'B';
}

function box(rows, opts) {
  opts = opts || {};
  const total = opts.width || Math.max(20, W() - 2);
  const inner = total - 4;
  const side = st.red(G.v);
  const res = [gradText(G.tl + G.h.repeat(total - 2) + G.tr, RED, DEEP)];
  rows.forEach((r) => {
    if (r === '---') { res.push(gradText(G.lt + G.h.repeat(total - 2) + G.rt, RED, DEEP)); return; }
    res.push(side + ' ' + r + ' '.repeat(Math.max(0, inner - visLen(r))) + ' ' + side);
  });
  res.push(gradText(G.bl + G.h.repeat(total - 2) + G.br, DEEP, RED));
  return res;
}

function tiles(items) {
  const avail = Math.max(20, W() - 2);
  let per = items.length;
  while (per > 1 && Math.floor((avail - (per - 1)) / per) < 11) per = per > 2 ? Math.ceil(per / 2) : 1;
  const tw = Math.min(22, Math.floor((avail - (per - 1)) / per));
  const inner = tw - 2;
  const lines = [];
  for (let i = 0; i < items.length; i += per) {
    const l1 = [];
    const l2 = [];
    const l3 = [];
    const l4 = [];
    items.slice(i, i + per).forEach((it) => {
      const center = (t, color) => {
        const len = visLen(t);
        const left = Math.floor((inner - len) / 2);
        return ' '.repeat(left) + color(t) + ' '.repeat(inner - len - left);
      };
      l1.push(gradText(G.tl + G.h.repeat(inner) + G.tr, RED, DEEP));
      l2.push(st.red(G.v) + center(trunc(String(it.value), inner), st.wb) + st.red(G.v));
      l3.push(st.red(G.v) + center(trunc(it.label, inner), st.red) + st.red(G.v));
      l4.push(gradText(G.bl + G.h.repeat(inner) + G.br, DEEP, RED));
    });
    [l1, l2, l3, l4].forEach((l) => lines.push(l.join(' ')));
  }
  return lines;
}

const LANG_COLORS = {
  JavaScript: [241, 224, 90], TypeScript: [49, 120, 198], Python: [70, 130, 200], Go: [0, 173, 216], Rust: [222, 165, 132],
  Java: [200, 130, 40], 'C++': [243, 75, 125], C: [150, 150, 150], 'C#': [23, 134, 0], Shell: [137, 224, 81], HTML: [227, 76, 38],
  CSS: [120, 90, 190], PHP: [110, 125, 190], Ruby: [200, 40, 50], Kotlin: [169, 123, 255], Swift: [240, 81, 56], Dart: [0, 180, 171],
  Lua: [60, 60, 200], Vue: [65, 184, 131], Jupyter: [218, 91, 11],
};

function langDot(name) {
  const c = LANG_COLORS[name] || [170, 175, 185];
  return paint(fgCode(c[0], c[1], c[2]), G.dot === '-' ? '*' : '\u25cf') + ' ' + safe(name || 'No language');
}

function lr(left, right, iw) {
  const gap = iw - visLen(left) - visLen(right);
  return gap >= 2 ? left + ' '.repeat(gap) + right : left;
}

const out = (s) => { try { process.stdout.write(s); } catch (e) { /* ignore */ } };
const println = (s) => out((s === undefined ? '' : s) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const canAnimate = () => IS_TTY && settings.anim && env.TERM !== 'dumb';
const W = () => Math.max(30, Math.min(process.stdout.columns || 70, 78));

/* ------------------------------------------------------------------ */
/* Text utilities                                                      */
/* ------------------------------------------------------------------ */

function safe(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const stripAnsi = (s) => String(s).replace(ANSI_RE, '');
const visLen = (s) => Array.from(stripAnsi(s)).length;

function trunc(s, n) {
  const a = Array.from(safe(s).replace(/\s+/g, ' '));
  if (a.length <= n) return a.join('');
  return a.slice(0, Math.max(1, n - 1)).join('') + G.ell;
}

function wrapLine(s, width, first, next) {
  first = first === undefined ? '' : first;
  next = next === undefined ? first : next;
  const words = String(s).split(/ +/).filter((w) => w.length);
  const lines = [];
  let cur = first;
  let curLen = visLen(first);
  let empty = true;
  for (const w of words) {
    const wl = visLen(w);
    if (!empty && curLen + 1 + wl > width) {
      lines.push(cur);
      cur = next;
      curLen = visLen(next);
      empty = true;
    }
    if (!empty) { cur += ' '; curLen += 1; }
    cur += w;
    curLen += wl;
    empty = false;
  }
  lines.push(cur);
  return lines;
}

function fmtNum(n) {
  if (n === undefined || n === null || n === '' || isNaN(Number(n))) return null;
  return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtSize(kb) {
  if (kb === undefined || kb === null || isNaN(Number(kb))) return null;
  kb = Number(kb);
  if (kb < 1024) return fmtNum(kb) + ' KB';
  if (kb < 1024 * 1024) return (kb / 1024).toFixed(1) + ' MB';
  return (kb / 1024 / 1024).toFixed(2) + ' GB';
}

function ago(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const days = Math.floor(h / 24);
  if (days < 30) return days + 'd ago';
  const months = Math.floor(days / 30);
  if (months < 12) return months + 'mo ago';
  return Math.floor(days / 365) + 'y ago';
}

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return iso.slice(0, 10) + ' ' + iso.slice(11, 16) + ' UTC (' + ago(d) + ')';
}

const pad2 = (n) => String(n).padStart(2, '0');

function stamp() {
  const d = new Date();
  return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

function slug(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_').slice(0, 80) || 'report';
}

function clockTime(epochSec) {
  const d = new Date(epochSec * 1000);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* ------------------------------------------------------------------ */
/* Printing helpers                                                    */
/* ------------------------------------------------------------------ */

function hr() {
  println('  ' + gradText(G.h.repeat(Math.max(10, W() - 4)), RED, DEEP));
}

function section(title) {
  const t = safe(title);
  const fill = Math.max(2, W() - 8 - visLen(t));
  println();
  println('  ' + st.rb(G.dia) + ' ' + st.wb(t) + ' ' + gradText(G.h.repeat(fill), RED, DEEP));
}

function kv(label, value, opts) {
  opts = opts || {};
  const lw = 15;
  let text = '';
  let has = !(value === undefined || value === null || (typeof value === 'number' && isNaN(value)));
  if (has) {
    text = safe(String(value)).replace(/\s*\n\s*/g, ' ').trim();
    if (text === '') has = false;
  }
  if (!has) text = 'Not available';
  const color = !has ? st.gray : opts.color || st.white;
  const lines = wrapLine(text, Math.max(16, W() - 4 - lw));
  lines.forEach((l, i) => {
    println('  ' + (i === 0 ? st.gray(label.padEnd(lw)) : ' '.repeat(lw)) + ' ' + color(l));
  });
}

function note(text) {
  wrapLine(safe(text), W() - 4).forEach((l) => println('  ' + st.gray(l)));
}

function menuLine(key, label, extra) {
  println('  ' + st.rb('[' + key + ']') + ' ' + st.white(label) + (extra ? ' ' + st.gray(extra) : ''));
}

const onoff = (b) => (b ? st.green('ON') : st.gray('OFF'));

/* ------------------------------------------------------------------ */
/* Spinner (real work only: it runs while a request is in flight)      */
/* ------------------------------------------------------------------ */

const FRAMES = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];
const ASCII_FRAMES = ['|', '/', '-', '\\'];
let activeSpinner = null;

class Spinner {
  constructor() {
    this.timer = null;
    this.text = '';
    this.i = 0;
    this.live = false;
    this.on = false;
  }
  start(text) {
    this.text = text;
    this.on = true;
    activeSpinner = this;
    this.live = canAnimate();
    if (this.live) {
      out('\x1b[?25l');
      this.draw();
      this.timer = setInterval(() => this.draw(), 80);
    } else {
      println('  ' + G.dot + ' ' + text + '...');
    }
    return this;
  }
  update(text) {
    this.text = text;
    if (!this.live) println('  ' + G.dot + ' ' + text + '...');
  }
  draw() {
    const frames = UNICODE ? FRAMES : ASCII_FRAMES;
    const f = frames[this.i++ % frames.length];
    let mark;
    if (settings.color && settings.rgb) {
      const c = hsv(Date.now() / 6);
      mark = paint(fgCode(c[0], c[1], c[2]), f);
    } else {
      mark = st.red(f);
    }
    out('\r\x1b[2K  ' + mark + ' ' + st.white(trunc(this.text, W() - 6)));
  }
  halt() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.live && this.on) out('\r\x1b[2K\x1b[?25h');
    this.on = false;
    if (activeSpinner === this) activeSpinner = null;
  }
  end(mark, msg) {
    const was = this.on;
    this.halt();
    if (msg && was) println('  ' + mark + ' ' + st.white(msg));
  }
  succeed(m) { this.end(st.green(G.ok), m); }
  fail(m) { this.end(st.red(G.bad), m); }
  warn(m) { this.end(st.yellow(G.warn), m); }
  stop() { this.end('', ''); }
}

async function withSpinner(text, fn, okText) {
  const sp = new Spinner().start(text);
  try {
    const v = await fn(sp);
    sp.succeed(typeof okText === 'function' ? okText(v) : okText || text);
    return v;
  } catch (e) {
    sp.fail(text + ' - failed');
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Shutdown / signals / input                                          */
/* ------------------------------------------------------------------ */

let rl = null;
let shuttingDown = false;
let inputClosed = false;
let waiter = null;
const lineQueue = [];
const activeReqs = new Set();

function restoreTerminal() {
  if (IS_TTY) out('\x1b[?25h' + (settings.color ? RESET : ''));
}

function finish(code, msg) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { stopLive(); } catch (e) { /* ignore */ }
  try { if (activeSpinner) activeSpinner.halt(); } catch (e) { /* ignore */ }
  activeReqs.forEach((r) => { try { r.destroy(); } catch (e) { /* ignore */ } });
  restoreTerminal();
  if (msg) println(msg);
  try { if (rl) rl.close(); } catch (e) { /* ignore */ }
  process.exit(code || 0);
}

function setupSignals() {
  const bye = () => finish(130, '\n  Interrupted. Bye - GitProbe by NullKat.');
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  process.on('SIGHUP', bye);
  process.on('exit', restoreTerminal);
  process.stdout.on('error', () => {});
  process.on('uncaughtException', (e) => {
    try { if (activeSpinner) activeSpinner.halt(); } catch (x) { /* ignore */ }
    println('\n  ' + st.red(G.bad) + ' Unexpected error: ' + safe((e && e.message) || e));
    if (DEBUG && e && e.stack) println(e.stack);
    finish(1);
  });
  process.on('unhandledRejection', (e) => {
    try { if (activeSpinner) activeSpinner.halt(); } catch (x) { /* ignore */ }
    println('\n  ' + st.red(G.bad) + ' Unexpected error: ' + safe((e && e.message) || e));
    if (DEBUG && e && e.stack) println(e.stack);
    finish(1);
  });
}

function ask(prompt, live) {
  stopLive();
  return new Promise((resolve) => {
    if (lineQueue.length) {
      const l = lineQueue.shift();
      out(prompt + l + '\n');
      resolve(l.trim());
      return;
    }
    if (inputClosed) { finish(0, '\n  Input closed. Bye.'); return; }
    waiter = (v) => resolve(String(v).trim());
    rl.setPrompt(prompt);
    rl.prompt();
    if (live) startLive(live.fn, live.ms);
  });
}

const PROMPT = () => '  ' + st.rb(G.arrow) + ' ';

/* live animation that keeps running while the program waits for input */
let liveTimer = null;

function stopLive() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}

function startLive(fn, ms) {
  stopLive();
  if (!canAnimate() || !settings.color) return;
  let tick = 0;
  liveTimer = setInterval(() => {
    if (!waiter || shuttingDown) return;
    let used = 0;
    try { used = visLen(rl.getPrompt()) + String(rl.line || '').length; } catch (e) { used = 0; }
    if (used >= (process.stdout.columns || 80) - 2) return;
    let frame = '';
    try { frame = fn(tick++); } catch (e) { return; }
    if (frame) out('\x1b7' + frame + '\x1b8');
  }, ms || 70);
}

/* ------------------------------------------------------------------ */
/* GitHub API layer                                                    */
/* ------------------------------------------------------------------ */

class GhError extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.kind = kind;
    if (extra) Object.assign(this, extra);
  }
}

let tokenWarned = false;
function getToken() {
  const t = String(env.GITHUB_TOKEN || env.GH_TOKEN || '').trim();
  if (!t) return '';
  if (!/^[A-Za-z0-9_\-.~+\/=]+$/.test(t)) {
    if (!tokenWarned) {
      tokenWarned = true;
      process.stderr.write('Warning: GITHUB_TOKEN contains unexpected characters and was ignored.\n');
    }
    return '';
  }
  return t;
}

const rate = { limit: null, remaining: null, reset: null };
const cache = new Map();

function updateRate(h) {
  const l = parseInt(h['x-ratelimit-limit'], 10);
  const r = parseInt(h['x-ratelimit-remaining'], 10);
  const t = parseInt(h['x-ratelimit-reset'], 10);
  if (!isNaN(l)) rate.limit = l;
  if (!isNaN(r)) rate.remaining = r;
  if (!isNaN(t)) rate.reset = t;
}

function netError(e) {
  if (e instanceof GhError) return e;
  const code = e && e.code;
  const msg = (e && e.message) || '';
  if (code === 'GP_TIMEOUT' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return new GhError('timeout', 'The request to GitHub timed out. Check your connection and try again.');
  }
  if (/certificate|CERT_|SSL|TLS/i.test(String(code) + ' ' + msg)) {
    return new GhError('network', 'TLS/certificate problem while contacting GitHub. Check your device date/time and CA certificates.');
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ECONNABORTED'].indexOf(code) !== -1) {
    return new GhError('network', 'Cannot reach ' + API_HOST + '. Check your internet connection (DNS, VPN or firewall) and try again.');
  }
  return new GhError('network', 'Network error: ' + safe(msg || 'unknown'));
}

function rateLimitError(headers) {
  let m = 'GitHub API rate limit reached.';
  const reset = parseInt(headers['x-ratelimit-reset'], 10);
  const retry = parseInt(headers['retry-after'], 10);
  if (!isNaN(retry)) {
    m += ' Try again in about ' + Math.max(1, Math.ceil(retry / 60)) + ' min.';
  } else if (!isNaN(reset)) {
    const mins = Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60000));
    m += ' It resets at ' + clockTime(reset) + ' (in ~' + mins + ' min).';
  }
  if (!getToken()) m += ' Tip: set the GITHUB_TOKEN environment variable to raise the limit (5,000 requests/hour).';
  return new GhError('ratelimit', m);
}

function statusError(s, headers, apiMsg) {
  const remaining = headers['x-ratelimit-remaining'];
  const msg = safe(apiMsg).slice(0, 200);
  if (s === 401) return new GhError('auth', 'GitHub rejected the access token (GITHUB_TOKEN). Remove it or set a valid one.');
  if (s === 404) return new GhError('notfound', 'Not found on GitHub.');
  if (s === 403 || s === 429) {
    if (remaining === '0' || /rate limit/i.test(apiMsg) || headers['retry-after'] || s === 429) return rateLimitError(headers);
    return new GhError('forbidden', 'Access denied by GitHub' + (msg ? ': ' + msg : '') + '.');
  }
  if (s === 451) return new GhError('blocked', 'This resource is unavailable for legal reasons (HTTP 451).');
  if (s >= 500) return new GhError('server', 'GitHub server error (HTTP ' + s + '). Try again in a moment.');
  return new GhError('http', 'Unexpected response from GitHub (HTTP ' + s + ')' + (msg ? ': ' + msg : '') + '.');
}

function httpGet(pathname, opts, redirects) {
  opts = opts || {};
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': NAME + '/' + VERSION + ' (NullKat Development)',
      Accept: opts.accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    let finished = false;
    let req = null;
    let timer = null;
    const done = (fn, v) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (req) activeReqs.delete(req);
      fn(v);
    };
    const onTimeout = () => {
      const e = new Error('timeout');
      e.code = 'GP_TIMEOUT';
      try { req.destroy(e); } catch (x) { /* ignore */ }
      done(reject, netError(e));
    };
    timer = setTimeout(onTimeout, REQUEST_TIMEOUT_MS);
    req = https.request({ hostname: API_HOST, path: pathname, method: 'GET', headers: headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          try { req.destroy(); } catch (x) { /* ignore */ }
          done(reject, new GhError('invalid', 'GitHub response was too large to handle.'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const status = res.statusCode;
        if ([301, 302, 307, 308].indexOf(status) !== -1 && res.headers.location && redirects < 3) {
          let loc = null;
          try { loc = new URL(res.headers.location, 'https://' + API_HOST); } catch (x) { loc = null; }
          if (loc && loc.hostname === API_HOST && loc.protocol === 'https:') {
            done(resolve, httpGet(loc.pathname + loc.search, opts, redirects + 1));
            return;
          }
        }
        done(resolve, { status: status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', (e) => done(reject, netError(e)));
      res.on('close', () => {
        if (!res.complete) done(reject, netError({ code: 'ECONNRESET' }));
      });
    });
    req.on('timeout', onTimeout);
    req.on('error', (e) => done(reject, netError(e)));
    activeReqs.add(req);
    req.end();
  });
}

async function gh(pathname, opts) {
  opts = opts || {};
  const key = (opts.accept || 'json') + ' ' + pathname;
  if (!opts.fresh) {
    const c = cache.get(key);
    if (c && Date.now() - c.t < CACHE_TTL_MS) return c.v;
  }
  const res = await httpGet(pathname, opts);
  updateRate(res.headers);
  let parsed = null;
  let apiMsg = '';
  if (!opts.raw || res.status !== 200) {
    try { parsed = JSON.parse(res.body); } catch (e) { parsed = null; }
    if (parsed && typeof parsed.message === 'string') apiMsg = parsed.message;
  }
  if (res.status === 200) {
    let value;
    if (opts.raw) {
      value = res.body;
    } else {
      const bad = new GhError('invalid', 'GitHub returned an unreadable or unexpected response. Try again later.');
      if (parsed === null) throw bad;
      if (opts.expect === 'array' && !Array.isArray(parsed)) throw bad;
      if (opts.expect === 'object' && (typeof parsed !== 'object' || Array.isArray(parsed))) throw bad;
      value = parsed;
    }
    cache.set(key, { t: Date.now(), v: value });
    return value;
  }
  throw statusError(res.status, res.headers, apiMsg);
}

function showError(e) {
  if (e && e.kind === 'aborted') return;
  if (e instanceof GhError) {
    println('  ' + st.red(G.bad) + ' ' + st.white(safe(e.message)));
    if (e.kind === 'network' || e.kind === 'timeout') println('    ' + st.gray('Tip: check your connection, then try again.'));
  } else {
    println('  ' + st.red(G.bad) + ' ' + st.white('Unexpected error: ' + safe((e && e.message) || String(e))));
    if (DEBUG && e && e.stack) println(st.gray(e.stack));
  }
}

/* ------------------------------------------------------------------ */
/* Input parsing                                                       */
/* ------------------------------------------------------------------ */

const USER_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

function parseUsername(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/?#\s]+)(?:[\/?#].*)?$/i);
  const name = m ? m[1] : s.replace(/^@/, '');
  return USER_RE.test(name) ? name : null;
}

function parseRepo(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  s = s.replace(/^git@github\.com:/i, '');
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '');
  s = s.split(/[?#]/)[0].replace(/^\/+/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!USER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null;
  return { owner: owner, repo: repo };
}

/* ------------------------------------------------------------------ */
/* Session state and data loading                                      */
/* ------------------------------------------------------------------ */

const state = { profiles: new Map(), repos: new Map(), lastProfile: null };

async function fetchReadmeAt(pathname, fresh) {
  try {
    const j = await gh(pathname, { expect: 'object', fresh: fresh });
    let text;
    if (j.encoding === 'base64' && typeof j.content === 'string' && j.content.length) {
      text = Buffer.from(j.content, 'base64').toString('utf8');
    } else {
      text = await gh(pathname, { raw: true, accept: 'application/vnd.github.raw+json', fresh: fresh });
    }
    text = String(text).replace(/^\uFEFF/, '');
    return { found: true, name: j.name || 'README', path: j.path || null, url: j.html_url || null, size: j.size || text.length, text: text };
  } catch (e) {
    if (e instanceof GhError && e.kind === 'notfound') return { found: false };
    throw e;
  }
}

async function loadRepoPages(p, pages, fresh) {
  if (p.reposComplete || p.capped) return;
  const sp = new Spinner().start('Loading repositories');
  let done = 0;
  try {
    while (done < pages && !p.reposComplete) {
      if (p.nextPage > HARD_CAP_PAGES) { p.capped = true; break; }
      sp.update('Loading repositories (page ' + p.nextPage + ')');
      const list = await gh('/users/' + enc(p.login) + '/repos?per_page=' + PER_PAGE + '&page=' + p.nextPage + '&sort=updated&direction=desc', { expect: 'array', fresh: fresh });
      const seen = new Set(p.repos.map((r) => r.id));
      list.forEach((r) => {
        if (r && typeof r === 'object' && r.name && !seen.has(r.id)) { p.repos.push(r); seen.add(r.id); }
      });
      p.nextPage += 1;
      done += 1;
      if (list.length < PER_PAGE || p.repos.length >= (p.user.public_repos || 0)) p.reposComplete = true;
    }
    if (!p.reposComplete && p.nextPage > HARD_CAP_PAGES) p.capped = true;
    p.reposError = null;
    sp.succeed(fmtNum(p.repos.length) + ' repositories loaded' + (p.reposComplete ? '' : ' (more available)'));
  } catch (e) {
    p.reposError = e.message;
    sp.warn('Repository loading stopped: ' + e.message);
  }
}

async function loadProfileReadme(p, fresh) {
  const sp = new Spinner().start('Checking profile README');
  try {
    const r = await fetchReadmeAt('/repos/' + enc(p.login) + '/' + enc(p.login) + '/readme', fresh);
    p.readme = r;
    p.readmeError = null;
    sp.succeed(r.found ? 'Profile README found' : 'No profile README');
  } catch (e) {
    p.readme = undefined;
    p.readmeError = e.message;
    sp.warn('Profile README check failed: ' + e.message);
  }
}

async function loadEvents(p) {
  const sp = new Spinner().start('Fetching public activity');
  try {
    const base = p.user.type === 'Organization' ? '/orgs/' + enc(p.login) + '/events' : '/users/' + enc(p.login) + '/events/public';
    const list = await gh(base + '?per_page=100', { expect: 'array' });
    p.events = list;
    p.eventsError = null;
    sp.succeed('Public activity: ' + list.length + ' recent events');
  } catch (e) {
    p.eventsError = e.message;
    sp.warn('Public activity unavailable: ' + e.message);
  }
}

async function loadProfile(username, opts) {
  const fresh = Boolean(opts && opts.fresh);
  const cached = state.profiles.get(username.toLowerCase());
  if (cached && !fresh) return cached;
  const user = await withSpinner('Fetching profile @' + username, async () => {
    try {
      return await gh('/users/' + enc(username), { expect: 'object', fresh: fresh });
    } catch (e) {
      if (e instanceof GhError && e.kind === 'notfound') throw new GhError('notfound', 'User "' + username + '" was not found on GitHub.');
      throw e;
    }
  });
  if (!user.login) throw new GhError('invalid', 'GitHub returned an unexpected profile response.');
  const p = {
    login: user.login, user: user, repos: [], nextPage: 1, reposComplete: !(user.public_repos > 0), reposError: null, capped: false,
    events: null, eventsError: null, readme: undefined, readmeError: null, fetchedAt: new Date().toISOString(),
  };
  await loadRepoPages(p, INITIAL_PAGES, fresh);
  await loadProfileReadme(p, fresh);
  state.profiles.delete(user.login.toLowerCase());
  state.profiles.set(user.login.toLowerCase(), p);
  state.lastProfile = user.login.toLowerCase();
  return p;
}

async function loadRepoReadme(b, fresh) {
  const r = b.repo;
  const sp = new Spinner().start('Fetching README');
  try {
    b.readme = await fetchReadmeAt('/repos/' + enc(r.owner.login) + '/' + enc(r.name) + '/readme', fresh);
    b.readmeError = null;
    sp.succeed(b.readme.found ? 'README found' : 'No README in this repository');
  } catch (e) {
    b.readme = undefined;
    b.readmeError = e.message;
    sp.warn('README fetch failed: ' + e.message);
  }
}

async function loadRepoLanguages(b) {
  const r = b.repo;
  const sp = new Spinner().start('Fetching language breakdown');
  try {
    b.languages = await gh('/repos/' + enc(r.owner.login) + '/' + enc(r.name) + '/languages', { expect: 'object' });
    b.langError = null;
    sp.succeed('Language breakdown loaded');
  } catch (e) {
    b.languages = undefined;
    b.langError = e.message;
    sp.warn('Language breakdown unavailable: ' + e.message);
  }
}

async function loadRepoBundle(owner, name, fresh) {
  const cached = state.repos.get((owner + '/' + name).toLowerCase());
  if (cached && !fresh) return cached;
  const repo = await withSpinner('Fetching ' + owner + '/' + name, async () => {
    try {
      return await gh('/repos/' + enc(owner) + '/' + enc(name), { expect: 'object', fresh: fresh });
    } catch (e) {
      if (e instanceof GhError && e.kind === 'notfound') {
        throw new GhError('notfound', 'Repository "' + owner + '/' + name + '" was not found (it may be private, renamed or misspelled).');
      }
      throw e;
    }
  });
  if (!repo.full_name || !repo.owner || !repo.owner.login) throw new GhError('invalid', 'GitHub returned an unexpected repository response.');
  const b = { repo: repo, readme: undefined, readmeError: null, languages: undefined, langError: null, fetchedAt: new Date().toISOString() };
  await loadRepoReadme(b, fresh);
  state.repos.delete(repo.full_name.toLowerCase());
  state.repos.set(repo.full_name.toLowerCase(), b);
  return b;
}

/* ------------------------------------------------------------------ */
/* Statistics (calculated by GitProbe from loaded data)                */
/* ------------------------------------------------------------------ */

function briefRepo(r) {
  if (!r) return null;
  return {
    name: r.name, full_name: r.full_name, description: r.description || null, language: r.language || null,
    stars: r.stargazers_count, forks: r.forks_count, created_at: r.created_at, updated_at: r.updated_at,
    pushed_at: r.pushed_at, html_url: r.html_url, fork: Boolean(r.fork), archived: Boolean(r.archived),
  };
}

function sortRepos(list, key) {
  const a = list.slice();
  if (key === 'stars') a.sort((x, y) => (y.stargazers_count || 0) - (x.stargazers_count || 0) || x.name.localeCompare(y.name));
  else if (key === 'name') a.sort((x, y) => x.name.localeCompare(y.name));
  else a.sort((x, y) => String(y.updated_at || '').localeCompare(String(x.updated_at || '')));
  return a;
}

function computeStats(p) {
  const repos = p.repos;
  const sum = (k) => repos.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const byStars = sortRepos(repos, 'stars');
  const langMap = new Map();
  repos.forEach((r) => {
    const l = r.language || 'Unspecified';
    langMap.set(l, (langMap.get(l) || 0) + 1);
  });
  const languages = Array.from(langMap.entries()).map((e) => ({ name: e[0], count: e[1] })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const latestBy = (key) => repos.reduce((m, r) => (!m || String(r[key] || '') > String(m[key] || '') ? r : m), null);
  return {
    loadedRepositories: repos.length,
    totalStars: sum('stargazers_count'),
    totalForks: sum('forks_count'),
    ownRepos: repos.filter((r) => !r.fork).length,
    forkedRepos: repos.filter((r) => r.fork).length,
    archivedRepos: repos.filter((r) => r.archived).length,
    mostStarred: byStars[0] && (byStars[0].stargazers_count || 0) > 0 ? briefRepo(byStars[0]) : null,
    topStarred: byStars.slice(0, 10).map(briefRepo),
    languages: languages,
    newestRepo: briefRepo(latestBy('created_at')),
    lastUpdatedRepo: briefRepo(latestBy('updated_at')),
    lastPushedRepo: briefRepo(latestBy('pushed_at')),
    recentlyUpdated: sortRepos(repos, 'updated').slice(0, 10).map(briefRepo),
  };
}

function eventLabel(t) {
  const map = {
    PushEvent: 'Push', WatchEvent: 'Starred a repo', CreateEvent: 'Create', DeleteEvent: 'Delete', PullRequestEvent: 'Pull request',
    PullRequestReviewEvent: 'PR review', PullRequestReviewCommentEvent: 'PR review comment', IssuesEvent: 'Issue',
    IssueCommentEvent: 'Issue comment', ForkEvent: 'Fork', ReleaseEvent: 'Release', PublicEvent: 'Made public',
    MemberEvent: 'Member change', CommitCommentEvent: 'Commit comment', GollumEvent: 'Wiki edit',
  };
  return map[t] || String(t || 'Unknown').replace(/Event$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

function summarizeEvents(list) {
  if (!Array.isArray(list)) return null;
  const counts = new Map();
  let latest = null;
  let oldest = null;
  list.forEach((e) => {
    const l = eventLabel(e && e.type);
    counts.set(l, (counts.get(l) || 0) + 1);
    const t = e && e.created_at;
    if (t) {
      if (!latest || t > latest) latest = t;
      if (!oldest || t < oldest) oldest = t;
    }
  });
  return {
    count: list.length, latest: latest, oldest: oldest,
    byType: Array.from(counts.entries()).map((e) => ({ type: e[0], count: e[1] })).sort((a, b) => b.count - a.count),
  };
}

function isPartial(p) {
  return !p.reposComplete || Boolean(p.reposError);
}

function barStr(frac, width) {
  const n = Math.max(frac > 0 ? 1 : 0, Math.min(width, Math.round(frac * width)));
  let r = '';
  for (let i = 0; i < width; i++) {
    if (i < n) {
      const c = mix(RED, SOFT, width > 1 ? i / (width - 1) : 0);
      r += settings.color ? ESC + fgCode(c[0], c[1], c[2]) + 'm' + G.bar : G.bar;
    } else {
      r += settings.color ? ESC + C.gray + 'm' + G.bar0 : G.bar0;
    }
  }
  return settings.color ? r + RESET : r;
}

function langBars(items, total, maxRows) {
  const top = items.slice(0, maxRows || 8);
  if (!top.length) return;
  const maxc = top[0].count || 1;
  top.forEach((it) => {
    const pct = total ? (it.count / total) * 100 : 0;
    println('  ' + st.white(trunc(it.name, 14).padEnd(14)) + ' ' + barStr(it.count / maxc, 14) + ' ' + String(it.count).padStart(3) + ' ' + st.gray((pct.toFixed(0) + '%').padStart(4)));
  });
}

/* ------------------------------------------------------------------ */
/* Markdown (lite) renderer for the terminal                           */
/* ------------------------------------------------------------------ */

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => { const c = parseInt(n, 10); return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => { const c = parseInt(n, 16); return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&amp;/gi, '&');
}

function htmlToText(s) {
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, '$1');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<img\s[^>]*>/gi, (m) => {
    const a = m.match(/alt=["']([^"']*)["']/i);
    return a && a[1].trim() ? '![' + a[1].trim() + '](x)' : '';
  });
  s = s.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, u, t) => {
    const tt = t.replace(/<[^>]+>/g, '').trim();
    return tt ? '[' + tt + '](' + u + ')' : u;
  });
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  return safe(decodeEntities(s));
}

function inlineFmt(text, styled) {
  const codes = [];
  let s = String(text);
  s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return '\u0001' + (codes.length - 1) + '\u0002'; });
  s = s.replace(/!\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, (m, alt) => (alt.trim() ? '{img: ' + alt.trim() + '}' : ''));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, t, u) => {
    if (t.indexOf('{img:') === 0) return t;
    if (/^(https?:|mailto:)/i.test(u) && t !== u) return t + ' (' + u + ')';
    return t;
  });
  s = s.replace(/\*\*([^*]+?)\*\*/g, (m, t) => (styled ? st.bold(t) : t));
  s = s.replace(/__([^_]+?)__/g, (m, t) => (styled ? st.bold(t) : t));
  s = s.replace(/~~([^~]+?)~~/g, '$1');
  s = s.replace(/(^|[\s(])\*([^\s*][^*]*?)\*(?=[\s).,;:!?]|$)/g, (m, pre, t) => pre + (styled ? st.ital(t) : t));
  s = s.replace(/\u0001(\d+)\u0002/g, (m, i) => (styled ? st.cyan(codes[Number(i)]) : codes[Number(i)]));
  return s;
}

function renderMarkdown(md, width) {
  width = Math.max(24, width || 60);
  const src = safe(md)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[a-zA-Z][^<>]*>/g, (m) => m.replace(/\s*\n\s*/g, ' '));
  const lines = [];
  const pushBlank = () => { if (lines.length && lines[lines.length - 1] !== '') lines.push(''); };
  let inCode = false;
  let fence = '';

  const renderLine = (l) => {
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { lines.push(st.gray(G.h.repeat(Math.min(width, 40)))); return; }
    let m = l.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) {
      const text = inlineFmt(m[2], false);
      const level = m[1].length;
      pushBlank();
      if (level === 1) {
        wrapLine(text, width).forEach((x) => lines.push(st.rb(x)));
        lines.push(st.red(G.h.repeat(Math.min(visLen(text), width))));
      } else if (level === 2) {
        wrapLine(text, width).forEach((x) => lines.push(st.wb(x)));
        lines.push(st.gray(G.h.repeat(Math.min(visLen(text), width))));
      } else {
        wrapLine(text, width - 2).forEach((x, i) => lines.push((i === 0 ? st.rb(G.arrow) + ' ' : '  ') + st.wb(x)));
      }
      return;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)) {
        lines.push(st.gray(G.h.repeat(Math.min(width, 30))));
      } else {
        const cells = l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inlineFmt(c.trim(), true));
        lines.push(cells.join(' ' + st.gray(G.v) + ' '));
      }
      return;
    }
    m = l.match(/^\s*>+\s?(.*)$/);
    if (m) {
      wrapLine(inlineFmt(m[1], true), width - 2).forEach((x) => lines.push(st.gray(G.v) + ' ' + x));
      return;
    }
    m = l.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/);
    if (m) {
      const indent = ' '.repeat(Math.min(m[1].length, 8));
      const bullet = /\d/.test(m[2]) ? m[2] : G.dot;
      let body = m[3].replace(/^\[ \]\s+/, '[ ] ').replace(/^\[[xX]\]\s+/, '[x] ');
      body = inlineFmt(body, true);
      const prefix = indent + st.red(bullet) + ' ';
      wrapLine(body, width, prefix, ' '.repeat(visLen(prefix))).forEach((x) => lines.push(x));
      return;
    }
    wrapLine(inlineFmt(l.trim(), true), width).forEach((x) => lines.push(x));
  };

  for (const raw of src.split('\n')) {
    const line = raw.replace(/\t/g, '    ').replace(/\s+$/, '');
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fm && !inCode) {
      inCode = true;
      fence = fm[1][0];
      const lang = line.replace(/^\s*[`~]+/, '').trim();
      if (lang) lines.push(st.gray('  ' + G.v + ' ' + lang));
      continue;
    }
    if (fm && inCode && fm[1][0] === fence) { inCode = false; continue; }
    if (inCode) { lines.push('  ' + st.gray(G.v) + ' ' + st.white(line)); continue; }
    if (!line.trim()) { pushBlank(); continue; }
    const expanded = htmlToText(line).split('\n');
    for (const l0 of expanded) {
      if (!l0.trim()) continue;
      renderLine(l0);
    }
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/* ------------------------------------------------------------------ */
/* Files: save reports / README                                        */
/* ------------------------------------------------------------------ */

function outDir() {
  return env.GITPROBE_OUT_DIR ? path.resolve(env.GITPROBE_OUT_DIR) : process.cwd();
}

function saveFile(base, ext, content) {
  const dir = outDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  const b = slug(base);
  for (let i = 0; i < 50; i++) {
    const file = path.join(dir, i ? b + '_' + i + '.' + ext : b + '.' + ext);
    try {
      fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
      return file;
    } catch (e) {
      if (e && e.code === 'EEXIST') continue;
      throw e;
    }
  }
  throw new Error('Could not find a free file name.');
}

function trySave(base, ext, content) {
  try {
    const f = saveFile(base, ext, content);
    println('  ' + st.green(G.ok) + ' ' + st.white('Saved: ') + st.cyan(f));
    return f;
  } catch (e) {
    println('  ' + st.red(G.bad) + ' ' + st.white('Could not save file: ' + safe((e && (e.code || e.message)) || 'unknown error')));
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Reports (JSON / TXT)                                                */
/* ------------------------------------------------------------------ */

function buildProfileReport(p) {
  const u = p.user;
  const stats = computeStats(p);
  const notes = [];
  if (!p.reposComplete) notes.push('Repository list incomplete: ' + p.repos.length + ' of ' + (u.public_repos || 0) + ' loaded.');
  if (p.reposError) notes.push('Repository loading stopped: ' + p.reposError);
  if (p.readmeError) notes.push('Profile README check failed: ' + p.readmeError);
  if (p.eventsError) notes.push('Public activity unavailable: ' + p.eventsError);
  if (p.events === null && !p.eventsError) notes.push('Public activity not included (open Statistics & Insights first to fetch it).');
  const partial = !p.reposComplete || Boolean(p.reposError) || Boolean(p.readmeError) || Boolean(p.eventsError);
  const ev = summarizeEvents(p.events);
  const featured = stats.topStarred.slice(0, 5);
  return {
    tool: { name: NAME, version: VERSION, by: 'NullKat Development' },
    type: 'github-profile',
    generatedAt: new Date().toISOString(),
    dataFetchedAt: p.fetchedAt,
    source: 'GitHub REST API (' + API_HOST + ')',
    completeness: { status: partial ? 'partial' : 'complete', notes: notes },
    profile: {
      login: u.login, type: u.type || null, name: u.name || null, bio: u.bio || null, html_url: u.html_url || null,
      avatar_url: u.avatar_url || null, location: u.location || null, blog: u.blog || null, company: u.company || null,
      followers: u.followers, following: u.following, public_repos: u.public_repos, created_at: u.created_at || null, updated_at: u.updated_at || null,
    },
    calculatedByGitProbe: {
      note: 'Computed by GitProbe from the repositories that were actually loaded.',
      loadedRepositories: stats.loadedRepositories, totalStars: stats.totalStars, totalForks: stats.totalForks,
      ownRepos: stats.ownRepos, forkedRepos: stats.forkedRepos, archivedRepos: stats.archivedRepos,
      mostStarred: stats.mostStarred, newestRepo: stats.newestRepo, lastUpdatedRepo: stats.lastUpdatedRepo, lastPushedRepo: stats.lastPushedRepo,
      languagesByRepoCount: stats.languages,
      featuredByStars: featured,
    },
    publicActivity: ev
      ? {
        source: 'GitHub public events feed (latest page, up to 100 events)', summary: ev,
        recent: (p.events || []).slice(0, 20).map((e) => ({ type: e.type, repo: e.repo && e.repo.name, created_at: e.created_at })),
      }
      : { included: false, reason: p.eventsError || 'Not fetched in this session.' },
    repositories: p.repos.map(briefRepo),
    profileReadme: p.readme && p.readme.found
      ? { available: true, name: p.readme.name, url: p.readme.url, characters: p.readme.text.length, text: p.readme.text }
      : { available: false, reason: p.readme ? 'No profile README found.' : p.readmeError || 'Not checked.' },
  };
}

function buildRepoReport(b) {
  const r = b.repo;
  const notes = [];
  if (b.readmeError) notes.push('README fetch failed: ' + b.readmeError);
  if (b.languages === undefined) notes.push('Language breakdown not included (open Extra metadata first to fetch it).');
  const partial = Boolean(b.readmeError) || Boolean(b.langError);
  return {
    tool: { name: NAME, version: VERSION, by: 'NullKat Development' },
    type: 'github-repository',
    generatedAt: new Date().toISOString(),
    dataFetchedAt: b.fetchedAt,
    source: 'GitHub REST API (' + API_HOST + ')',
    completeness: { status: partial ? 'partial' : 'complete', notes: notes },
    repository: {
      name: r.name, full_name: r.full_name, owner: r.owner && r.owner.login, owner_type: r.owner && r.owner.type, description: r.description || null,
      html_url: r.html_url, stars: r.stargazers_count, forks: r.forks_count,
      watchers_subscribers: r.subscribers_count !== undefined ? r.subscribers_count : null,
      open_issues_including_prs: r.open_issues_count, language: r.language || null, default_branch: r.default_branch, size_kb: r.size,
      license: r.license ? { name: r.license.name, spdx_id: r.license.spdx_id } : null, topics: Array.isArray(r.topics) ? r.topics : null,
      fork: Boolean(r.fork), parent: r.parent ? r.parent.full_name : null, archived: Boolean(r.archived),
      homepage: r.homepage || null, visibility: r.visibility || null, created_at: r.created_at, updated_at: r.updated_at, pushed_at: r.pushed_at,
    },
    languagesBytes: b.languages || null,
    readme: b.readme && b.readme.found
      ? { available: true, name: b.readme.name, url: b.readme.url, characters: b.readme.text.length, text: b.readme.text }
      : { available: false, reason: b.readme ? 'No README found.' : b.readmeError || 'Not checked.' },
  };
}

function txtField(lines, label, value) {
  let t = value === undefined || value === null || value === '' ? 'Not available' : safe(String(value)).replace(/\s*\n\s*/g, ' ').trim();
  if (t === '') t = 'Not available';
  lines.push(label.padEnd(22) + ': ' + t);
}

function profileReportToText(rep) {
  const L = [];
  const pr = rep.profile;
  const c = rep.calculatedByGitProbe;
  L.push('GitProbe Report - GitHub Profile', '=================================');
  txtField(L, 'Generated at', rep.generatedAt);
  txtField(L, 'Data fetched at', rep.dataFetchedAt);
  txtField(L, 'Source', rep.source);
  txtField(L, 'Completeness', rep.completeness.status.toUpperCase());
  rep.completeness.notes.forEach((n) => L.push('  - ' + safe(n)));
  L.push('', 'PROFILE (as provided by GitHub)', '-------------------------------');
  ['login', 'type', 'name', 'bio', 'html_url', 'avatar_url', 'location', 'blog', 'company', 'followers', 'following', 'public_repos', 'created_at', 'updated_at']
    .forEach((k) => txtField(L, k, pr[k]));
  L.push('', 'CALCULATED BY GITPROBE (' + c.loadedRepositories + ' repositories loaded)', '-----------------------------------------------');
  txtField(L, 'Total stars', c.totalStars);
  txtField(L, 'Total forks', c.totalForks);
  txtField(L, 'Own / forked / archived', c.ownRepos + ' / ' + c.forkedRepos + ' / ' + c.archivedRepos);
  txtField(L, 'Most starred', c.mostStarred ? c.mostStarred.name + ' (' + c.mostStarred.stars + ' stars)' : 'None (no stars)');
  txtField(L, 'Newest repository', c.newestRepo ? c.newestRepo.name + ' (' + c.newestRepo.created_at + ')' : null);
  txtField(L, 'Last updated', c.lastUpdatedRepo ? c.lastUpdatedRepo.name + ' (' + c.lastUpdatedRepo.updated_at + ')' : null);
  L.push('', 'Top languages (by repository count):');
  c.languagesByRepoCount.slice(0, 10).forEach((l) => L.push('  - ' + l.name + ': ' + l.count));
  L.push('', 'Featured repositories (top by stars; GitHub REST API does not expose pinned repos):');
  c.featuredByStars.forEach((r, i) => L.push('  ' + (i + 1) + '. ' + r.name + ' - ' + (r.language || 'No language') + ' - ' + r.stars + ' stars'));
  L.push('', 'PUBLIC ACTIVITY', '---------------');
  if (rep.publicActivity.summary) {
    const s = rep.publicActivity.summary;
    txtField(L, 'Events (latest page)', s.count);
    txtField(L, 'Latest event', s.latest);
    txtField(L, 'Oldest in window', s.oldest);
    s.byType.slice(0, 8).forEach((t) => L.push('  - ' + t.type + ': ' + t.count));
  } else {
    L.push('Not included: ' + safe(rep.publicActivity.reason));
  }
  L.push('', 'REPOSITORIES (' + rep.repositories.length + ' loaded)', '-----------------------');
  rep.repositories.forEach((r, i) => {
    L.push((i + 1) + '. ' + r.name + ' | ' + (r.language || 'No language') + ' | stars ' + r.stars + ' | forks ' + r.forks + ' | updated ' + (r.updated_at || 'n/a') + (r.fork ? ' | fork' : '') + (r.archived ? ' | archived' : ''));
  });
  L.push('', 'PROFILE README', '--------------');
  L.push(rep.profileReadme.available ? safe(rep.profileReadme.text) : 'Not available: ' + safe(rep.profileReadme.reason));
  L.push('', 'Generated by ' + NAME + ' v' + VERSION + ' - Made by: NullKat (NullKat Development)');
  return L.join('\n') + '\n';
}

function repoReportToText(rep) {
  const L = [];
  const r = rep.repository;
  L.push('GitProbe Report - GitHub Repository', '===================================');
  txtField(L, 'Generated at', rep.generatedAt);
  txtField(L, 'Data fetched at', rep.dataFetchedAt);
  txtField(L, 'Source', rep.source);
  txtField(L, 'Completeness', rep.completeness.status.toUpperCase());
  rep.completeness.notes.forEach((n) => L.push('  - ' + safe(n)));
  L.push('', 'REPOSITORY (as provided by GitHub)', '----------------------------------');
  txtField(L, 'Name', r.name);
  txtField(L, 'Owner', r.owner);
  txtField(L, 'Description', r.description);
  txtField(L, 'URL', r.html_url);
  txtField(L, 'Stars', r.stars);
  txtField(L, 'Forks', r.forks);
  txtField(L, 'Watchers (subscribers)', r.watchers_subscribers);
  txtField(L, 'Open issues (incl. PRs)', r.open_issues_including_prs);
  txtField(L, 'Language', r.language);
  txtField(L, 'Default branch', r.default_branch);
  txtField(L, 'Size (KB)', r.size_kb);
  txtField(L, 'License', r.license ? r.license.name + (r.license.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? ' (' + r.license.spdx_id + ')' : '') : 'None detected');
  txtField(L, 'Topics', Array.isArray(r.topics) ? (r.topics.length ? r.topics.join(', ') : 'None') : null);
  txtField(L, 'Fork', r.fork ? 'Yes' + (r.parent ? ' (from ' + r.parent + ')' : '') : 'No');
  txtField(L, 'Archived', r.archived ? 'Yes' : 'No');
  txtField(L, 'Created', r.created_at);
  txtField(L, 'Updated', r.updated_at);
  txtField(L, 'Last push', r.pushed_at);
  if (rep.languagesBytes) {
    const total = Object.keys(rep.languagesBytes).reduce((s, k) => s + rep.languagesBytes[k], 0);
    L.push('', 'LANGUAGES (bytes from GitHub; percentages computed by GitProbe)');
    Object.keys(rep.languagesBytes).sort((a, b) => rep.languagesBytes[b] - rep.languagesBytes[a]).forEach((k) => {
      L.push('  - ' + k + ': ' + rep.languagesBytes[k] + ' bytes (' + (total ? ((rep.languagesBytes[k] / total) * 100).toFixed(1) : '0.0') + '%)');
    });
  }
  L.push('', 'README', '------');
  L.push(rep.readme.available ? safe(rep.readme.text) : 'Not available: ' + safe(rep.readme.reason));
  L.push('', 'Generated by ' + NAME + ' v' + VERSION + ' - Made by: NullKat (NullKat Development)');
  return L.join('\n') + '\n';
}

async function exportFlow(kind, obj) {
  while (true) {
    println();
    menuLine('1', 'Save as JSON');
    menuLine('2', 'Save as TXT');
    menuLine('3', 'Save both');
    menuLine('0', 'Cancel');
    const c = await ask(PROMPT() + 'Format: ');
    if (c === '0') return;
    if (['1', '2', '3'].indexOf(c) === -1) { println('  ' + st.yellow(G.warn) + ' Invalid choice. Enter 1, 2, 3 or 0.'); continue; }
    const rep = kind === 'profile' ? buildProfileReport(obj) : buildRepoReport(obj);
    const base = 'gitprobe_' + kind + '_' + (kind === 'profile' ? obj.login : obj.repo.full_name.replace('/', '_')) + '_' + stamp();
    if (c === '1' || c === '3') trySave(base, 'json', JSON.stringify(rep, null, 2) + '\n');
    if (c === '2' || c === '3') trySave(base, 'txt', kind === 'profile' ? profileReportToText(rep) : repoReportToText(rep));
    note('Reports contain only public GitHub data. Nothing was uploaded anywhere, and no token is ever included.');
    return;
  }
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function cardRows(title, subtitle, text, emptyLabel) {
  const iw = Math.max(20, W() - 2) - 4;
  const rows = [];
  rows.push(title ? st.wb(trunc(title, iw)) : st.gray(emptyLabel[0]));
  rows.push(subtitle);
  if (text) {
    const all = wrapLine(safe(text).replace(/\s*\n\s*/g, ' ').trim(), iw);
    const shown = all.slice(0, 3);
    if (all.length > 3) shown[2] = trunc(shown[2], iw - 1) + G.ell;
    shown.forEach((l) => rows.push(st.white(l)));
  } else {
    rows.push(st.gray(emptyLabel[1]));
  }
  return rows;
}

function printProfileSummary(p) {
  const u = p.user;
  const s = computeStats(p);
  const partial = isPartial(p);
  section('Profile @' + u.login);
  const sub = st.rb('@' + trunc(u.login, 30)) + st.gray('  ' + G.mid + '  ' + (u.type || 'Account'));
  box(cardRows(u.name ? safe(u.name) : '', sub, u.bio, ['Display name: Not available', 'Bio: Not available'])).forEach((l) => println('  ' + l));
  tiles([
    { label: 'FOLLOWERS', value: fmtNum(u.followers) || 'n/a' },
    { label: 'FOLLOWING', value: fmtNum(u.following) || 'n/a' },
    { label: 'REPOS', value: fmtNum(u.public_repos) || 'n/a' },
    { label: 'STARS', value: (fmtNum(s.totalStars) || '0') + (partial ? '*' : '') },
  ]).forEach((l) => println('  ' + l));
  if (partial) note('* partial: stars counted from ' + s.loadedRepositories + ' of ' + (u.public_repos || 0) + ' repos loaded.');
  println();
  kv('Username', u.login);
  kv('Profile URL', u.html_url);
  kv('Avatar URL', u.avatar_url);
  kv('Location', u.location);
  kv('Website', u.blog);
  kv('Joined', fmtDate(u.created_at));
  kv('Profile updated', fmtDate(u.updated_at));
  let rd = null;
  if (p.readme && p.readme.found) rd = 'Available (' + fmtNum(p.readme.text.length) + ' chars)';
  else if (p.readme) rd = 'Not found (no ' + u.login + '/' + u.login + ' README)';
  else if (p.readmeError) rd = 'Could not check: ' + p.readmeError;
  kv('Profile README', rd);
  kv('Data status', partial ? 'Partial - ' + s.loadedRepositories + ' of ' + (u.public_repos || 0) + ' repos loaded' + (p.reposError ? ' (' + p.reposError + ')' : '') : 'Complete', { color: partial ? st.yellow : st.green });

  println();
  println('  ' + st.rb('Top languages'));
  const langs = s.languages.filter((l) => l.name !== 'Unspecified');
  if (langs.length) langBars(langs, langs.reduce((n, l) => n + l.count, 0), 5);
  else println('  ' + st.gray('Not available'));

  println();
  println('  ' + st.rb('Featured repositories') + ' ' + st.gray('(top by stars)'));
  if (!s.topStarred.length) {
    println('  ' + st.gray('No public repositories loaded.'));
  } else if (!s.mostStarred) {
    println('  ' + st.gray('No repository has stars yet.'));
  } else {
    s.topStarred.slice(0, 5).forEach((r, i) => {
      println('  ' + st.red(String(i + 1) + '.') + ' ' + st.wb(G.star + ' ' + String(fmtNum(r.stars)).padEnd(5)) + ' ' + st.white(trunc(r.name, Math.max(8, W() - 30))) + ' ' + st.gray(G.mid) + ' ' + langDot(r.language));
    });
  }
  note("GitHub's REST API does not expose pinned repositories, so featured = most starred.");
}

function printRepoSummary(b) {
  const r = b.repo;
  section('Repository ' + r.full_name);
  const flags = [r.language || 'No language'];
  if (r.license && r.license.spdx_id && r.license.spdx_id !== 'NOASSERTION') flags.push(r.license.spdx_id);
  if (r.fork) flags.push('fork');
  if (r.archived) flags.push('archived');
  const sub = st.rb(trunc(flags.join('  ' + G.mid + '  '), Math.max(16, W() - 2) - 4));
  box(cardRows(r.full_name, sub, r.description, ['Name: Not available', 'Description: Not available'])).forEach((l) => println('  ' + l));
  tiles([
    { label: 'STARS', value: fmtNum(r.stargazers_count) || 'n/a' },
    { label: 'FORKS', value: fmtNum(r.forks_count) || 'n/a' },
    { label: 'WATCHERS', value: r.subscribers_count !== undefined ? fmtNum(r.subscribers_count) || 'n/a' : 'n/a' },
    { label: 'ISSUES', value: fmtNum(r.open_issues_count) || 'n/a' },
  ]).forEach((l) => println('  ' + l));
  println();
  kv('Name', r.name);
  kv('Owner', r.owner && r.owner.login ? r.owner.login + (r.owner.type ? ' (' + r.owner.type + ')' : '') : null);
  kv('URL', r.html_url);
  kv('Language', r.language);
  kv('Default branch', r.default_branch);
  kv('Size', fmtSize(r.size));
  kv('License', r.license ? r.license.name + (r.license.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? ' (' + r.license.spdx_id + ')' : '') : 'None detected');
  kv('Topics', Array.isArray(r.topics) ? (r.topics.length ? r.topics.join(', ') : 'None') : null);
  kv('Fork', r.fork ? 'Yes' + (r.parent ? ' - forked from ' + r.parent.full_name : '') : 'No');
  kv('Status', r.archived ? 'Archived (read-only)' : r.disabled ? 'Disabled' : 'Active');
  kv('Created', fmtDate(r.created_at));
  kv('Updated', fmtDate(r.updated_at));
  kv('Last push', fmtDate(r.pushed_at));
  let rd = null;
  if (b.readme && b.readme.found) rd = 'Available (' + b.readme.name + ', ' + fmtNum(b.readme.text.length) + ' chars)';
  else if (b.readme) rd = 'Not found';
  else if (b.readmeError) rd = 'Could not fetch: ' + b.readmeError;
  kv('README', rd);
  println();
  note("Stars = stargazers. Watchers = subscribers (GitHub's legacy watchers_count equals stars, so it is not used). Issues = open issues + open PRs, as GitHub counts them.");
  if (r.subscribers_count === undefined) note('Watchers were not provided by the API response.');
}

async function showRepoMeta(b) {
  const r = b.repo;
  if (b.languages === undefined) await loadRepoLanguages(b);
  section('Extra metadata - ' + r.full_name);
  kv('Repo ID', r.id);
  kv('Visibility', r.visibility || (r.private ? 'private' : 'public'));
  kv('Homepage', r.homepage || null);
  kv('Clone (HTTPS)', r.clone_url);
  kv('Clone (SSH)', r.ssh_url);
  kv('Template', r.is_template ? 'Yes' : 'No');
  const feats = [];
  if (r.has_issues) feats.push('Issues');
  if (r.has_wiki) feats.push('Wiki');
  if (r.has_pages) feats.push('Pages');
  if (r.has_discussions) feats.push('Discussions');
  if (r.has_projects) feats.push('Projects');
  kv('Features', feats.length ? feats.join(', ') : 'None enabled');
  kv('Network forks', fmtNum(r.network_count));
  kv('Subscribers', fmtNum(r.subscribers_count));
  kv('Pushed at', fmtDate(r.pushed_at));
  kv('Updated at', fmtDate(r.updated_at));
  println();
  println('  ' + st.rb('Languages'));
  if (b.languages && Object.keys(b.languages).length) {
    const keys = Object.keys(b.languages).sort((a, c) => b.languages[c] - b.languages[a]);
    const total = keys.reduce((s, k) => s + b.languages[k], 0);
    keys.slice(0, 8).forEach((k) => {
      const pct = total ? (b.languages[k] / total) * 100 : 0;
      println('  ' + st.white(trunc(k, 14).padEnd(14)) + ' ' + barStr(pct / 100, 14) + ' ' + st.gray((pct.toFixed(1) + '%').padStart(6)));
    });
    note('Bytes per language come from GitHub; percentages are calculated by GitProbe.');
  } else if (b.langError) {
    println('  ' + st.gray('Not available: ' + safe(b.langError)));
  } else {
    println('  ' + st.gray('No language data reported for this repository.'));
  }
}

function pageRows() {
  const r = process.stdout.rows;
  return IS_TTY && r ? Math.max(8, Math.min(r - 7, 40)) : 40;
}

async function viewReadme(label, readme) {
  if (!readme || !readme.found) {
    println('  ' + st.yellow(G.warn) + ' ' + st.white('No README found for ' + label + '.'));
    return;
  }
  const lines = renderMarkdown(readme.text, W() - 2);
  if (!lines.length) {
    println('  ' + st.yellow(G.warn) + ' ' + st.white('The README is empty.'));
    return;
  }
  const size = pageRows();
  const pages = Math.max(1, Math.ceil(lines.length / size));
  let page = 0;
  while (true) {
    out(settings.color ? RESET : '');
    section('README - ' + trunc(label, W() - 20) + '  ' + (page + 1) + '/' + pages);
    lines.slice(page * size, page * size + size).forEach((l) => println('  ' + l));
    out(settings.color ? RESET : '');
    println();
    if (page < pages - 1) println('  ' + st.gray('[Enter/N] next  [P] prev  [#] jump  [S] save TXT  [0] back'));
    else println('  ' + st.gray('End of README. [P] prev  [#] jump  [S] save TXT  [Enter/0] back'));
    const c = (await ask(PROMPT())).toLowerCase();
    if (c === '0') return;
    if (c === '' || c === 'n') {
      if (page < pages - 1) page++;
      else return;
    } else if (c === 'p') {
      if (page > 0) page--;
      else println('  ' + st.gray('Already at the first page.'));
    } else if (c === 's') {
      trySave('readme_' + slug(label) + '_' + stamp(), 'txt', safe(readme.text) + '\n');
    } else if (/^\d+$/.test(c)) {
      const n = parseInt(c, 10);
      if (n >= 1 && n <= pages) page = n - 1;
      else println('  ' + st.yellow(G.warn) + ' Page must be between 1 and ' + pages + '.');
    } else {
      println('  ' + st.yellow(G.warn) + ' Unknown command.');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Pickers                                                             */
/* ------------------------------------------------------------------ */

async function pickProfile(label) {
  const last = state.lastProfile && state.profiles.get(state.lastProfile);
  section(label);
  println('  ' + st.white('Enter a GitHub username or profile URL.'));
  println('  ' + st.gray('e.g. nullkat-067  |  https://github.com/nullkat-067'));
  while (true) {
    const a = await ask(PROMPT() + (last ? '[Enter = @' + last.login + ', 0 = back] ' : '[0 = back] '));
    if (a === '0') return null;
    if (a === '') {
      if (last) return last;
      println('  ' + st.yellow(G.warn) + ' Please enter a username or 0 to go back.');
      continue;
    }
    const name = parseUsername(a);
    if (!name) {
      println('  ' + st.yellow(G.warn) + ' Invalid username or URL. Use letters, numbers and single hyphens (max 39 chars).');
      continue;
    }
    try {
      return await loadProfile(name);
    } catch (e) {
      showError(e);
    }
  }
}

async function pickRepo(label) {
  section(label);
  println('  ' + st.white('Enter owner/repository or a repository URL.'));
  println('  ' + st.gray('e.g. nullkat-067/TraceVoid  |  https://github.com/owner/repo'));
  while (true) {
    const a = await ask(PROMPT() + '[0 = back] ');
    if (a === '0') return null;
    if (a === '') { println('  ' + st.yellow(G.warn) + ' Please enter owner/repo or 0 to go back.'); continue; }
    const r = parseRepo(a);
    if (!r) {
      println('  ' + st.yellow(G.warn) + ' Invalid format. Use owner/repo or a full github.com URL.');
      continue;
    }
    try {
      return await loadRepoBundle(r.owner, r.repo);
    } catch (e) {
      showError(e);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Hubs and flows                                                      */
/* ------------------------------------------------------------------ */

async function showProfileReadme(p) {
  if (p.readme === undefined) await loadProfileReadme(p);
  if (p.readme === undefined) return;
  await viewReadme('profile @' + p.login, p.readme);
}

async function showRepoReadme(b) {
  if (b.readme === undefined) await loadRepoReadme(b);
  if (b.readme === undefined) return;
  await viewReadme(b.repo.full_name, b.readme);
}

async function repoHub(b) {
  printRepoSummary(b);
  while (true) {
    println();
    menuLine('1', 'View README');
    menuLine('2', 'Extra metadata');
    menuLine('3', 'Show summary again');
    menuLine('4', 'Export report');
    menuLine('0', 'Back');
    const c = await ask(PROMPT() + 'Select: ');
    try {
      if (c === '1') await showRepoReadme(b);
      else if (c === '2') await showRepoMeta(b);
      else if (c === '3') printRepoSummary(b);
      else if (c === '4') await exportFlow('repo', b);
      else if (c === '0') return;
      else println('  ' + st.yellow(G.warn) + ' Invalid choice. Enter 0-4.');
    } catch (e) { showError(e); }
  }
}

async function explorer(p) {
  let sortKey = 'updated';
  let query = '';
  let page = 0;
  const sortLabel = { updated: 'recently updated', stars: 'most stars', name: 'name A-Z' };
  while (true) {
    const filtered = query ? p.repos.filter((r) => r.name.toLowerCase().indexOf(query.toLowerCase()) !== -1) : p.repos;
    const list = sortRepos(filtered, sortKey);
    const pages = Math.max(1, Math.ceil(list.length / LIST_PAGE_SIZE));
    if (page >= pages) page = pages - 1;
    if (page < 0) page = 0;
    section('Repositories @' + p.login);
    println('  ' + st.gray('Sort: ' + sortLabel[sortKey] + ' | Filter: ' + (query ? '"' + trunc(query, 20) + '"' : 'none')));
    println('  ' + st.gray(list.length + ' shown | Page ' + (page + 1) + '/' + pages));
    if (!p.reposComplete) println('  ' + st.yellow(G.warn + ' Partial: ' + p.repos.length + ' of ' + (p.user.public_repos || 0) + ' loaded' + (p.capped ? ' (limit reached)' : ' - [L] loads more')));
    if (p.reposError) println('  ' + st.yellow(G.warn + ' ' + trunc(p.reposError, W() - 8)));
    println();
    if (!list.length) println('  ' + st.gray('No repositories to show.'));
    list.slice(page * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE + LIST_PAGE_SIZE).forEach((r, i) => {
      const n = page * LIST_PAGE_SIZE + i + 1;
      println('  ' + st.rb(String(n).padStart(3)) + '. ' + st.wb(trunc(r.name, W() - 14)) + (r.fork ? st.gray(' (fork)') : ''));
      println('       ' + langDot(r.language) + st.gray('  ' + G.star + ' ' + fmtNum(r.stargazers_count) + '  ' + G.mid + '  ' + (ago(r.updated_at) || 'n/a')));
    });
    println();
    println('  ' + st.gray('[#] open  [N] next  [P] prev'));
    println('  ' + st.gray('[S] sort  [F] find  [L] load more  [0] back'));
    const c = (await ask(PROMPT())).toLowerCase();
    try {
      if (/^\d+$/.test(c) && c !== '0') {
        const idx = parseInt(c, 10);
        if (idx >= 1 && idx <= list.length) {
          const r = list[idx - 1];
          const b = await loadRepoBundle(r.owner.login, r.name);
          await repoHub(b);
        } else {
          println('  ' + st.yellow(G.warn) + ' No repository with number ' + idx + '.');
        }
      } else if (c === 'n') {
        if (page < pages - 1) page++;
        else println('  ' + st.gray('Already at the last page.'));
      } else if (c === 'p') {
        if (page > 0) page--;
        else println('  ' + st.gray('Already at the first page.'));
      } else if (c === 's') {
        sortKey = sortKey === 'updated' ? 'stars' : sortKey === 'stars' ? 'name' : 'updated';
        page = 0;
      } else if (c === 'f') {
        const q = await ask(PROMPT() + 'Search name (empty = clear): ');
        query = safe(q).slice(0, 60);
        page = 0;
      } else if (c === 'l') {
        if (p.reposComplete) println('  ' + st.gray('All repositories are already loaded.'));
        else if (p.capped) println('  ' + st.gray('Safety limit reached (' + HARD_CAP_PAGES * PER_PAGE + ' repositories).'));
        else await loadRepoPages(p, MORE_PAGES);
      } else if (c === '0' || c === 'b') {
        return;
      } else {
        println('  ' + st.yellow(G.warn) + ' Unknown command.');
      }
    } catch (e) { showError(e); }
  }
}

function printStatsSummary(p) {
  const s = computeStats(p);
  const u = p.user;
  const partial = isPartial(p);
  section('Statistics @' + u.login + (partial ? ' [PARTIAL]' : ''));
  println('  ' + st.rb('From GitHub (as provided)'));
  kv('Followers', fmtNum(u.followers));
  kv('Following', fmtNum(u.following));
  kv('Public repos', fmtNum(u.public_repos));
  println();
  println('  ' + st.rb('Calculated by GitProbe') + ' ' + st.gray('(' + s.loadedRepositories + ' repos loaded)'));
  kv('Total stars', fmtNum(s.totalStars));
  kv('Total forks', fmtNum(s.totalForks));
  kv('Repo types', s.ownRepos + ' own | ' + s.forkedRepos + ' forked | ' + s.archivedRepos + ' archived');
  kv('Most starred', s.mostStarred ? s.mostStarred.name + ' (' + G.star + ' ' + fmtNum(s.mostStarred.stars) + ')' : 'None (no repo has stars)');
  kv('Newest repo', s.newestRepo ? s.newestRepo.name + ' - ' + (s.newestRepo.created_at || '').slice(0, 10) : null);
  kv('Last updated', s.lastUpdatedRepo ? s.lastUpdatedRepo.name + ' - ' + ago(s.lastUpdatedRepo.updated_at) : null);
  const langs = s.languages.filter((l) => l.name !== 'Unspecified').slice(0, 3).map((l) => l.name + ' (' + l.count + ')').join(', ');
  kv('Top languages', langs || null);
  println();
  println('  ' + st.rb('Public activity') + ' ' + st.gray('(GitHub events feed)'));
  const ev = summarizeEvents(p.events);
  if (ev) {
    kv('Events', ev.count + ' in latest page');
    kv('Latest event', fmtDate(ev.latest));
    kv('Top types', ev.byType.slice(0, 3).map((t) => t.type + ' x' + t.count).join(', ') || null);
  } else {
    kv('Events', p.eventsError ? 'Not available: ' + p.eventsError : null);
  }
  println();
  if (partial) note('PARTIAL: only ' + s.loadedRepositories + ' of ' + (u.public_repos || 0) + ' repositories were loaded, so calculated totals may be lower than reality.');
  note('GitProbe does not invent star history, contribution graphs or private activity.');
}

async function statsHub(p) {
  if (p.events === null && !p.eventsError) await loadEvents(p);
  printStatsSummary(p);
  while (true) {
    println();
    menuLine('1', 'Language breakdown');
    menuLine('2', 'Top repos by stars');
    menuLine('3', 'Recently updated repos');
    menuLine('4', 'Public activity details');
    menuLine('5', 'Load more repositories', isPartial(p) ? '' : '(all loaded)');
    menuLine('6', 'Export report');
    menuLine('7', 'Show summary again');
    menuLine('0', 'Back');
    const c = await ask(PROMPT() + 'Select: ');
    try {
      const s = computeStats(p);
      if (c === '1') {
        section('Languages by repo count');
        langBars(s.languages, s.loadedRepositories, 10);
        note('Counted by GitProbe from each repo\'s primary language.');
      } else if (c === '2') {
        section('Top repos by stars');
        if (!s.topStarred.length) println('  ' + st.gray('No repositories loaded.'));
        s.topStarred.forEach((r, i) => println('  ' + st.red(String(i + 1).padStart(2) + '.') + ' ' + st.white(G.star + ' ' + String(fmtNum(r.stars)).padEnd(5)) + ' ' + st.wb(trunc(r.name, W() - 14))));
      } else if (c === '3') {
        section('Recently updated repos');
        if (!s.recentlyUpdated.length) println('  ' + st.gray('No repositories loaded.'));
        s.recentlyUpdated.forEach((r, i) => println('  ' + st.red(String(i + 1).padStart(2) + '.') + ' ' + st.wb(trunc(r.name, W() - 20)) + ' ' + st.gray(ago(r.updated_at))));
        if (s.newestRepo) println('\n  ' + st.gray('Newest by creation date: ' + s.newestRepo.name + ' (' + (s.newestRepo.created_at || '').slice(0, 10) + ')'));
      } else if (c === '4') {
        if (p.events === null) await loadEvents(p);
        section('Public activity');
        const ev = summarizeEvents(p.events);
        if (!ev) {
          println('  ' + st.gray('Not available' + (p.eventsError ? ': ' + safe(p.eventsError) : '.')));
        } else if (!ev.count) {
          println('  ' + st.gray('No recent public events.'));
        } else {
          ev.byType.slice(0, 8).forEach((t) => println('  ' + st.white(t.type.padEnd(20)) + ' ' + st.red(String(t.count))));
          println();
          p.events.slice(0, 8).forEach((e) => println('  ' + st.gray(trunc(eventLabel(e.type), 14).padEnd(14)) + ' ' + st.white(trunc((e.repo && e.repo.name) || '', W() - 28)) + ' ' + st.gray(ago(e.created_at))));
          note('The feed only covers recent public events; GitProbe reads the latest page (up to 100 events).');
        }
      } else if (c === '5') {
        if (p.reposComplete) println('  ' + st.gray('All repositories are already loaded.'));
        else if (p.capped) println('  ' + st.gray('Safety limit reached (' + HARD_CAP_PAGES * PER_PAGE + ' repositories).'));
        else { await loadRepoPages(p, MORE_PAGES); printStatsSummary(p); }
      } else if (c === '6') {
        await exportFlow('profile', p);
      } else if (c === '7') {
        printStatsSummary(p);
      } else if (c === '0') {
        return;
      } else {
        println('  ' + st.yellow(G.warn) + ' Invalid choice. Enter 0-7.');
      }
    } catch (e) { showError(e); }
  }
}

async function profileHub(p) {
  printProfileSummary(p);
  while (true) {
    println();
    menuLine('1', 'Profile README');
    menuLine('2', 'Browse repositories');
    menuLine('3', 'Statistics & insights');
    menuLine('4', 'Export report');
    menuLine('5', 'Show summary again');
    menuLine('6', 'Refresh data');
    menuLine('0', 'Back to main menu');
    const c = await ask(PROMPT() + 'Select: ');
    try {
      if (c === '1') await showProfileReadme(p);
      else if (c === '2') await explorer(p);
      else if (c === '3') await statsHub(p);
      else if (c === '4') await exportFlow('profile', p);
      else if (c === '5') printProfileSummary(p);
      else if (c === '6') { p = await loadProfile(p.login, { fresh: true }); printProfileSummary(p); }
      else if (c === '0') return;
      else println('  ' + st.yellow(G.warn) + ' Invalid choice. Enter 0-6.');
    } catch (e) { showError(e); }
  }
}

async function flowAnalyzeProfile() {
  const p = await pickProfile('Analyze GitHub Profile');
  if (p) await profileHub(p);
}

async function flowAnalyzeRepo() {
  const b = await pickRepo('Analyze Repository');
  if (b) await repoHub(b);
}

async function flowExplorer() {
  const p = await pickProfile('Repository Explorer');
  if (p) await explorer(p);
}

async function flowReadme() {
  while (true) {
    section('README Viewer');
    menuLine('1', 'Profile README');
    menuLine('2', 'Repository README');
    menuLine('0', 'Back');
    const c = await ask(PROMPT() + 'Select: ');
    try {
      if (c === '1') {
        const p = await pickProfile('Profile README');
        if (p) await showProfileReadme(p);
      } else if (c === '2') {
        const b = await pickRepo('Repository README');
        if (b) await showRepoReadme(b);
      } else if (c === '0') {
        return;
      } else {
        println('  ' + st.yellow(G.warn) + ' Invalid choice. Enter 0-2.');
      }
    } catch (e) { showError(e); }
  }
}

async function flowStats() {
  const p = await pickProfile('Statistics & Insights');
  if (p) await statsHub(p);
}

async function flowExport() {
  const items = [];
  Array.from(state.profiles.values()).forEach((p) => items.push({ label: 'Profile @' + p.login, kind: 'profile', obj: p }));
  Array.from(state.repos.values()).forEach((b) => items.push({ label: 'Repository ' + b.repo.full_name, kind: 'repo', obj: b }));
  section('Export Report');
  if (!items.length) {
    println('  ' + st.yellow(G.warn) + ' ' + st.white('Nothing to export yet. Analyze a profile (1) or a repository (2) first.'));
    return;
  }
  const shown = items.slice(-9).reverse();
  shown.forEach((it, i) => menuLine(String(i + 1), it.label));
  menuLine('0', 'Back');
  while (true) {
    const c = await ask(PROMPT() + 'Select: ');
    if (c === '0') return;
    const n = parseInt(c, 10);
    if (/^\d+$/.test(c) && n >= 1 && n <= shown.length) {
      await exportFlow(shown[n - 1].kind, shown[n - 1].obj);
      return;
    }
    println('  ' + st.yellow(G.warn) + ' Invalid choice. Enter 0-' + shown.length + '.');
  }
}

/* ------------------------------------------------------------------ */
/* Settings & About                                                    */
/* ------------------------------------------------------------------ */

async function animateCredit(ms) {
  const label = '  Made by: ';
  if (!canAnimate() || !settings.color || !settings.rgb) {
    println(st.white(label) + rainbow('NullKat', 0));
    return;
  }
  out('\x1b[?25l');
  const start = Date.now();
  let phase = 0;
  while (Date.now() - start < ms && !shuttingDown) {
    out('\r' + st.white(label) + rainbow('NullKat', phase));
    phase += 35;
    await sleep(60);
  }
  out('\r' + st.white(label) + rainbow('NullKat', phase) + '\x1b[?25h\n');
}

async function showApiStatus() {
  const r = await withSpinner('Checking API rate limit', () => gh('/rate_limit', { expect: 'object', fresh: true }), 'Rate limit checked');
  const core = (r.resources && r.resources.core) || r.rate || {};
  section('GitHub API status');
  kv('Auth', getToken() ? 'Token detected (value hidden)' : 'Anonymous (no token)');
  kv('Limit / hour', fmtNum(core.limit));
  kv('Remaining', fmtNum(core.remaining));
  kv('Resets at', core.reset ? clockTime(core.reset) + ' (local time)' : null);
}

/* ------------------------------------------------------------------ */
/* 'probe' command installer                                           */
/* ------------------------------------------------------------------ */

const LAUNCHER_MARK = '# GitProbe launcher (NullKat Development)';

function launcherDirs() {
  const prefix = env.PREFIX || '';
  const termux = /com\.termux/.test(prefix);
  const dirs = [];
  if (termux) {
    dirs.push(path.join(prefix, 'bin'));
  } else {
    if (typeof process.getuid === 'function' && process.getuid() === 0) dirs.push('/usr/local/bin');
    dirs.push(path.join(os.homedir(), '.local', 'bin'));
  }
  return { termux: termux, prefix: prefix, dirs: dirs };
}

const shQuote = (t) => "'" + String(t).replace(/'/g, "'\\''") + "'";

function installLauncher() {
  const info = launcherDirs();
  let script;
  try { script = fs.realpathSync(__filename); } catch (e) { script = path.resolve(__filename); }
  const shell = info.termux ? path.join(info.prefix, 'bin', 'sh') : '/bin/sh';
  const body = '#!' + shell + '\n' + LAUNCHER_MARK + '\nexec node ' + shQuote(script) + ' "$@"\n';
  let lastErr = null;
  for (const dir of info.dirs) {
    const target = path.join(dir, 'probe');
    try {
      fs.mkdirSync(dir, { recursive: true });
      let existing = null;
      try { existing = fs.readFileSync(target, 'utf8'); } catch (e) { existing = null; }
      if (existing !== null && existing.indexOf(LAUNCHER_MARK) === -1) {
        lastErr = 'A different "probe" command already exists at ' + target + ' (not overwritten).';
        continue;
      }
      fs.writeFileSync(target, body, { mode: 0o755 });
      try { fs.chmodSync(target, 0o755); } catch (e) { /* ignore */ }
      const inPath = String(env.PATH || '').split(path.delimiter).indexOf(dir) !== -1;
      return { ok: true, target: target, dir: dir, script: script, inPath: inPath };
    } catch (e) {
      lastErr = 'Cannot write to ' + dir + ' (' + (e.code || e.message) + ').';
    }
  }
  return { ok: false, error: lastErr || 'No writable install location found.' };
}

function uninstallLauncher() {
  const removed = [];
  launcherDirs().dirs.forEach((dir) => {
    const t = path.join(dir, 'probe');
    try {
      if (fs.readFileSync(t, 'utf8').indexOf(LAUNCHER_MARK) !== -1) { fs.unlinkSync(t); removed.push(t); }
    } catch (e) { /* not installed here */ }
  });
  return removed;
}

function launcherStatus() {
  const dirs = launcherDirs().dirs;
  for (const dir of dirs) {
    const t = path.join(dir, 'probe');
    try {
      if (fs.readFileSync(t, 'utf8').indexOf(LAUNCHER_MARK) !== -1) return t;
    } catch (e) { /* keep looking */ }
  }
  return null;
}

function pathLine(dir) {
  const home = os.homedir();
  const shown = dir.indexOf(home) === 0 ? '$HOME' + dir.slice(home.length) : dir;
  return 'export PATH="' + shown + ':$PATH"';
}

function addPathToRc(dir) {
  const home = os.homedir();
  const line = pathLine(dir);
  const files = ['.bashrc'];
  if (fs.existsSync(path.join(home, '.zshrc'))) files.push('.zshrc');
  const done = [];
  files.forEach((f) => {
    const p = path.join(home, f);
    let cur = '';
    try { cur = fs.readFileSync(p, 'utf8'); } catch (e) { cur = ''; }
    if (cur.indexOf(line) !== -1) return;
    try {
      fs.appendFileSync(p, (cur && !cur.endsWith('\n') ? '\n' : '') + '\n# Added by GitProbe (NullKat Development)\n' + line + '\n');
      done.push(f);
    } catch (e) { /* ignore */ }
  });
  return { line: line, done: done };
}

async function installFlow() {
  section("Install the 'probe' command");
  const res = installLauncher();
  if (!res.ok) {
    println('  ' + st.red(G.bad) + ' ' + st.white(res.error));
    return;
  }
  println('  ' + st.green(G.ok) + ' ' + st.white('Installed: ') + st.cyan(res.target));
  kv('Runs', res.script);
  if (!res.inPath) {
    println('  ' + st.yellow(G.warn) + ' ' + st.white(res.dir + ' is not in your PATH yet.'));
    const a = (await ask(PROMPT() + 'Add it to ~/.bashrc now? [Y/n] ')).toLowerCase();
    if (a === '' || a === 'y' || a === 'yes') {
      const r = addPathToRc(res.dir);
      if (r.done.length) println('  ' + st.green(G.ok) + ' ' + st.white('Added to ' + r.done.map((f) => '~/' + f).join(', ')));
      else println('  ' + st.gray('Already present in your shell config (or it could not be written).'));
      note('Then run: source ~/.bashrc   (or close and reopen the terminal).');
    } else {
      note('Add this line to your shell config yourself: ' + r0(res.dir));
    }
  }
  println();
  println('  ' + st.white('Now just type ') + st.rb('probe') + st.white(' in any folder to start.'));
  note('If you move probe.js to another folder, run the install again. If the shell says "command not found", run: hash -r');
}

function r0(dir) { return pathLine(dir); }

function uninstallFlow() {
  section("Remove the 'probe' command");
  const removed = uninstallLauncher();
  if (removed.length) removed.forEach((t) => println('  ' + st.green(G.ok) + ' ' + st.white('Removed: ') + st.cyan(t)));
  else println('  ' + st.gray('No GitProbe launcher found. Nothing to remove.'));
}

function cliInstall() {
  const res = installLauncher();
  if (!res.ok) { println('Install failed: ' + res.error); return 1; }
  println('Installed: ' + res.target + '  ->  ' + res.script);
  if (!res.inPath) {
    println('Note: ' + res.dir + ' is not in your PATH. Add this line to ~/.bashrc, then run "source ~/.bashrc":');
    println('  ' + pathLine(res.dir));
  }
  println('Done. Type "probe" to start GitProbe.');
  return 0;
}

function cliUninstall() {
  const removed = uninstallLauncher();
  if (removed.length) removed.forEach((t) => println('Removed: ' + t));
  else println('No GitProbe launcher found.');
  return 0;
}

/* ------------------------------------------------------------------ */
/* Usage, About, Settings                                              */
/* ------------------------------------------------------------------ */

function showUsage() {
  section('Usage guide');
  [
    'Pick a menu number, then follow the prompts. 0 goes back.',
    'Profiles: type a username or a github.com profile URL.',
    'Repositories: type owner/repo or a full repository URL.',
    'Explorer: [#] opens a repo, [N]/[P] page, [S] sort, [F] search, [L] load more.',
    'README viewer: Enter = next page, [S] saves the README as TXT.',
    'Reports are saved to the current folder (or GITPROBE_OUT_DIR).',
    'Start with just "probe": Settings > Install, or run: node probe.js --install',
    'Optional token: export GITHUB_TOKEN=... (raises the rate limit; never printed or saved).',
    'Flags: --no-color, --ascii, --fast (skip splash), --install, --uninstall, --help, --version.',
  ].forEach((l) => wrapLine(l, W() - 4, '  ' + st.red(G.dot) + ' ', '    ').forEach((x) => println(x)));
}

async function showAbout() {
  section('About ' + NAME);
  kv('Name', NAME + ' v' + VERSION);
  kv('Description', 'GitHub Intelligence CLI - analyze public GitHub profiles and repositories from your terminal.');
  kv('Developer', 'NullKat Development');
  kv('Dependencies', 'None (Node.js built-ins: https, readline, fs, path, os)');
  kv('Runtime', 'Node ' + process.versions.node + ' on ' + process.platform);
  kv('Data source', 'GitHub REST API (public data only)');
  kv('Auth', getToken() ? 'GITHUB_TOKEN detected (value hidden)' : 'None (anonymous: 60 requests/hour)');
  const lp = launcherStatus();
  kv('probe command', lp ? 'Installed at ' + lp : 'Not installed (Settings > Install)');
  kv('Output folder', outDir());
  println();
  await animateCredit(2200);
}

async function settingsMenu() {
  while (true) {
    section('Settings & About');
    menuLine('1', 'Colors', '[' + (settings.color ? 'ON' : 'OFF') + ']');
    menuLine('2', 'RGB effect', '[' + (settings.rgb ? 'ON' : 'OFF') + ']');
    menuLine('3', 'Animations', '[' + (settings.anim ? 'ON' : 'OFF') + ']');
    menuLine('4', 'About GitProbe');
    menuLine('5', 'Usage guide');
    menuLine('6', 'API rate limit status');
    menuLine('7', "Install 'probe' command", launcherStatus() ? '(installed)' : '');
    menuLine('8', "Remove 'probe' command");
    menuLine('0', 'Back');
    const c = await ask(PROMPT() + 'Select: ');
    try {
      if (c === '1') {
        settings.color = !settings.color;
        println('  Colors: ' + onoff(settings.color));
        if (settings.color && !detectColor()) note('Your terminal may not support colors; if you see raw codes, turn this off again.');
      } else if (c === '2') {
        settings.rgb = !settings.rgb;
        println('  RGB effect: ' + onoff(settings.rgb));
        if (!settings.color) note('RGB needs colors ON; the effect is inactive while colors are off.');
      } else if (c === '3') {
        settings.anim = !settings.anim;
        println('  Animations: ' + onoff(settings.anim));
        if (!IS_TTY) note('Output is not a terminal, so animations are inactive anyway.');
      } else if (c === '4') {
        await showAbout();
      } else if (c === '5') {
        showUsage();
      } else if (c === '6') {
        await showApiStatus();
      } else if (c === '7') {
        await installFlow();
      } else if (c === '8') {
        uninstallFlow();
      } else if (c === '0') {
        return;
      } else {
        println('  ' + st.yellow(G.warn) + ' Invalid choice. Enter 0-8.');
      }
    } catch (e) { showError(e); }
  }
}

/* ------------------------------------------------------------------ */
/* Logo, splash intro, main menu                                       */
/* ------------------------------------------------------------------ */

const BLOCK_FONT = {
  "p": [
    "\u2588\u2588\u2588\u2588\u2588\u2588\u2557 ",
    "\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557",
    "\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d",
    "\u2588\u2588\u2554\u2550\u2550\u2550\u255d ",
    "\u2588\u2588\u2551     ",
    "\u255a\u2550\u255d     "
  ],
  "r": [
    "\u2588\u2588\u2588\u2588\u2588\u2588\u2557 ",
    "\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557",
    "\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d",
    "\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557",
    "\u2588\u2588\u2551  \u2588\u2588\u2551",
    "\u255a\u2550\u255d  \u255a\u2550\u255d"
  ],
  "o": [
    " \u2588\u2588\u2588\u2588\u2588\u2588\u2557 ",
    "\u2588\u2588\u2554\u2550\u2550\u2550\u2588\u2588\u2557",
    "\u2588\u2588\u2551   \u2588\u2588\u2551",
    "\u2588\u2588\u2551   \u2588\u2588\u2551",
    "\u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d",
    " \u255a\u2550\u2550\u2550\u2550\u2550\u255d "
  ],
  "b": [
    "\u2588\u2588\u2588\u2588\u2588\u2588\u2557 ",
    "\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557",
    "\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d",
    "\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557",
    "\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d",
    "\u255a\u2550\u2550\u2550\u2550\u2550\u255d "
  ],
  "e": [
    "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557",
    "\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d",
    "\u2588\u2588\u2588\u2588\u2588\u2557  ",
    "\u2588\u2588\u2554\u2550\u2550\u255d  ",
    "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557",
    "\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u255d"
  ]
};
const STD_FONT = {
  "p": [
    "       ",
    " _ __  ",
    "| '_ \\ ",
    "| |_) |",
    "| .__/ ",
    "|_|    "
  ],
  "r": [
    "      ",
    " _ __ ",
    "| '__|",
    "| |   ",
    "|_|   ",
    "      "
  ],
  "o": [
    "       ",
    "  ___  ",
    " / _ \\ ",
    "| (_) |",
    " \\___/ ",
    "       "
  ],
  "b": [
    " _     ",
    "| |__  ",
    "| '_ \\ ",
    "| |_) |",
    "|_.__/ ",
    "       "
  ],
  "e": [
    "      ",
    "  ___ ",
    " / _ \\",
    "|  __/",
    " \\___|",
    "      "
  ]
};

function buildLogo() {
  const block = UNICODE && W() >= 43;
  const font = block ? BLOCK_FONT : STD_FONT;
  const rows = [];
  for (let y = 0; y < font.p.length; y++) rows.push(['p', 'r', 'o', 'b', 'e'].map((ch) => font[ch][y]).join(''));
  return { rows: rows, block: block };
}

function paintLogoRow(row, band, block) {
  if (!settings.color) return row;
  const chars = Array.from(row);
  const n = chars.length;
  let r = '';
  for (let x = 0; x < n; x++) {
    const ch = chars[x];
    if (ch === ' ') { r += ' '; continue; }
    const shadow = block && ch !== '\u2588';
    let c = shadow
      ? mix([105, 16, 32], [185, 55, 75], x / Math.max(1, n - 1))
      : mix(RED, SOFT, x / Math.max(1, n - 1));
    const d = Math.abs(x - band);
    if (d < 6) c = mix(c, [255, 255, 255], (1 - d / 6) * 0.9);
    r += ESC + '1;' + fgCode(c[0], c[1], c[2]) + 'm' + ch;
  }
  return r + RESET;
}

async function intro() {
  const live = canAnimate() && !FAST;
  const roomy = (process.stdout.rows || 24) >= 22;
  const logo = buildLogo();
  const pad = '  ';
  const h = logo.rows.length;
  const w = Array.from(logo.rows[0]).length;
  const maxw = Math.max(16, Math.min(process.stdout.columns || 80, 78) - 4);
  let lc = 0;
  const P = (t) => { println(t === undefined ? '' : t); lc++; };

  if (live) out('\x1b[2J\x1b[H\x1b[?25l');
  P();
  const logoTop = lc;
  for (let y = 0; y < h; y++) {
    P(pad + paintLogoRow(logo.rows[y], -99, logo.block));
    if (live) await sleep(80);
  }
  const drawLogo = (band) => {
    let r = '';
    for (let y = 0; y < h; y++) r += at(lc - (logoTop + y), 0, pad + paintLogoRow(logo.rows[y], band, logo.block) + '\x1b[K');
    return r;
  };
  if (live && roomy && settings.color) {
    for (let band = -6; band <= w + 6; band += 2) {
      out('\x1b7' + drawLogo(band) + '\x1b8');
      await sleep(30);
    }
  }

  P();
  const tag = 'GitHub Intelligence CLI';
  if (live) {
    out(pad);
    for (const ch of tag) { out(st.wb(ch)); await sleep(22); }
    out(' ' + st.gray('v' + VERSION) + '\n');
    lc++;
  } else {
    P(pad + st.wb(tag) + ' ' + st.gray('v' + VERSION));
  }
  P(pad + st.gray(trunc('Analyze GitHub profiles & public repositories.', maxw)));
  P(pad + st.gray('NullKat Development'));
  P();
  const creditIdx = lc;
  P(pad + st.white('Made by: ') + rainbow('NullKat', 0));
  P();

  const sp = new Spinner().start('Connecting to GitHub API');
  try {
    const r = await gh('/rate_limit', { expect: 'object', fresh: true });
    const core = (r.resources && r.resources.core) || r.rate || {};
    sp.succeed(trunc('GitHub API reachable - ' + (core.remaining !== undefined ? core.remaining + '/' + core.limit + ' requests left' : 'ready') + (getToken() ? ' (token in use)' : ' (anonymous)'), maxw - 2));
    lc++;
  } catch (e) {
    sp.warn(trunc('GitHub API check failed: ' + e.message, maxw - 2));
    lc++;
    P(pad + st.gray(trunc('You can still open the menu; each feature retries when used.', maxw)));
  }

  if (live) {
    P();
    out('\x1b[?25h');
    const anim = roomy && settings.color
      ? {
        ms: 60,
        fn: (t) => drawLogo(((t * 2) % (w + 44)) - 8) + at(lc - creditIdx, 0, pad + st.white('Made by: ') + rainbow('NullKat', t * 22)),
      }
      : null;
    await ask(PROMPT() + st.gray('Press Enter to start '), anim);
    out('\x1b[2J\x1b[H');
  }
}

const MENU = [
  ['1', 'Analyze GitHub Profile', 'user stats & README'],
  ['2', 'Analyze Repository', 'metadata & README'],
  ['3', 'Repository Explorer', 'browse, search, sort'],
  ['4', 'README Viewer', 'read in the terminal'],
  ['5', 'Statistics & Insights', 'stars, languages, activity'],
  ['6', 'Export Report', 'save as JSON / TXT'],
  ['7', 'Settings & About', 'theme, install, help'],
  ['8', 'Exit', 'quit GitProbe'],
];

function menuStatus() {
  const api = rate.remaining !== null && rate.limit !== null ? 'API ' + rate.remaining + '/' + rate.limit : 'API ready';
  return api + (getToken() ? ' ' + G.mid + ' token' : '');
}

function printMenu() {
  const iw = Math.max(20, W() - 2) - 4;
  const rows = [];
  rows.push(lr(st.wb(trunc('GitProbe ' + G.mid + ' GitHub Intelligence CLI', iw - 7)), st.gray('v' + VERSION), iw));
  rows.push(lr(st.white('Made by: ') + rainbow('NullKat', (Date.now() / 10) % 360), st.gray(menuStatus()), iw));
  rows.push('---');
  MENU.forEach((m) => {
    const lab = trunc(m[1], iw - 6);
    let row = st.rb('[' + m[0] + ']') + '  ' + st.wb(lab);
    if (iw >= 46) row += ' '.repeat(Math.max(1, 26 - visLen(lab))) + st.gray(trunc(m[2], iw - 6 - 26));
    rows.push(row);
  });
  const lines = box(rows);
  const logo = buildLogo();
  const h = logo.rows.length;
  const w = Array.from(logo.rows[0]).length;
  println();
  logo.rows.forEach((r) => println('  ' + paintLogoRow(r, -99, logo.block)));
  lines.forEach((l) => println('  ' + l));
  const creditUp = lines.length - 2;
  const frame = (t) => {
    const avail = process.stdout.rows || 24;
    let f = '';
    if (h + lines.length < avail - 2) {
      const band = ((t * 2) % (w + 44)) - 8;
      for (let y = 0; y < h; y++) f += at(h - y + lines.length, 0, '  ' + paintLogoRow(logo.rows[y], band, logo.block) + '\x1b[K');
    }
    if (creditUp < avail - 1) f += at(creditUp, 13, rainbow('NullKat', t * 22));
    return f;
  };
  return { up: creditUp, col: 13, frame: frame };
}

function printHelp() {
  println(NAME + ' v' + VERSION + ' - GitHub Intelligence CLI (Made by: NullKat)');
  println('');
  println('Usage: node probe.js [options]      (or just: probe, after --install)');
  println('  --install      install the "probe" command');
  println('  --uninstall    remove the "probe" command');
  println('  --fast         skip the animated splash');
  println('  --no-color     disable colors');
  println('  --ascii        use ASCII-only symbols');
  println('  -v, --version  show version');
  println('  -h, --help     show this help');
  println('');
  println('Environment: GITHUB_TOKEN (optional), GITPROBE_OUT_DIR (report folder), NO_COLOR');
}

async function main() {
  if (argv.includes('--version') || argv.includes('-v')) { println(NAME + ' v' + VERSION); return; }
  if (argv.includes('--help') || argv.includes('-h')) { printHelp(); return; }
  if (argv.includes('--install')) { process.exitCode = cliInstall(); return; }
  if (argv.includes('--uninstall')) { process.exitCode = cliUninstall(); return; }
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 14) {
    println('GitProbe needs Node.js 14 or newer (found ' + process.versions.node + ').');
    process.exit(1);
  }
  setupSignals();
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  rl.on('line', (line) => {
    stopLive();
    if (waiter) { const w = waiter; waiter = null; w(line); } else lineQueue.push(line);
  });
  rl.on('close', () => {
    inputClosed = true;
    if (waiter) finish(0, '\n  Input closed. Bye.');
  });
  rl.on('SIGINT', () => finish(130, '\n  Interrupted. Bye - GitProbe by NullKat.'));

  await intro();
  while (true) {
    const m = printMenu();
    const live = { ms: 70, fn: m.frame };
    const c = (await ask(PROMPT() + 'Select [1-8]: ', live)).toLowerCase();
    try {
      switch (c) {
        case '1': await flowAnalyzeProfile(); break;
        case '2': await flowAnalyzeRepo(); break;
        case '3': await flowExplorer(); break;
        case '4': await flowReadme(); break;
        case '5': await flowStats(); break;
        case '6': await flowExport(); break;
        case '7': await settingsMenu(); break;
        case '8': case 'q': case 'exit': case 'quit':
          finish(0, '\n  ' + st.white('Thanks for using ') + st.wb(NAME) + st.white(' - Made by: ') + rainbow('NullKat', 0) + '\n');
          return;
        default:
          println('  ' + st.yellow(G.warn) + ' Invalid choice "' + trunc(c, 20) + '". Enter a number from 1 to 8.');
      }
    } catch (e) {
      showError(e);
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    try { if (activeSpinner) activeSpinner.halt(); } catch (x) { /* ignore */ }
    println('\n  Fatal error: ' + safe((e && e.message) || e));
    if (DEBUG && e && e.stack) println(e.stack);
    finish(1);
  });
} else {
  module.exports = { parseUsername, parseRepo, renderMarkdown, computeStats, buildProfileReport, buildRepoReport, profileReportToText, repoReportToText, wrapLine, safe };
}
