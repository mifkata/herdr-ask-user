#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OTHER = 'Other (type, or "N + notes")';
const PAD = 1;
const SCRIPT = fileURLToPath(import.meta.url);

class Failure extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function loadQuestions(src) {
  let qs;
  try {
    qs = JSON.parse(fs.readFileSync(src === "-" ? 0 : src, "utf8"));
  } catch (e) {
    throw new Failure(`Cannot read questions: ${e.message}`, 2);
  }
  if (qs && !Array.isArray(qs) && typeof qs === "object") qs = [qs];
  if (!Array.isArray(qs) || !qs.length) throw new Failure("Questions must be a non-empty JSON list.", 2);
  qs.forEach((q, i) => {
    const opts = q && q.options;
    if (typeof q?.question !== "string" || !Array.isArray(opts) || !opts.length || !opts.every((o) => typeof o === "string")) {
      throw new Failure(`Question ${i + 1} needs "question" (string) and "options" (non-empty list of strings).`, 2);
    }
    const rec = q.recommended;
    if (rec !== undefined && rec !== null && !(Number.isInteger(rec) && rec >= 1 && rec <= opts.length)) {
      throw new Failure(`Question ${i + 1}: "recommended" must be an option number 1-${opts.length}.`, 2);
    }
  });
  return qs;
}

function herdr(...args) {
  const r = spawnSync("herdr", args, { encoding: "utf8" });
  return { status: r.error ? 1 : r.status, stdout: r.stdout || "", stderr: r.stderr || (r.error ? r.error.message : "") };
}

function checkEnv() {
  if (process.env.CLAUDECODE === "1") throw new Failure("Claude Code: use the built-in AskUserQuestion tool instead.", 3);
  const inHerdr = ["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"].every((v) => process.env[v]);
  if (!inHerdr || spawnSync("herdr", ["--version"]).error) {
    throw new Failure("Not running inside a herdr pane: ask the user in chat instead.", 3);
  }
}

function snapshot() {
  return JSON.parse(herdr("api", "snapshot").stdout).result.snapshot;
}

// The attached herdr client with the latest keyboard input (tty atime), and whether it runs over SSH.
function activeClient() {
  const ps = spawnSync("ps", ["-axo", "pid=,ppid=,tty=,command="], { encoding: "utf8" });
  if (ps.error || ps.status) return [null, false];
  const procs = new Map();
  for (const line of ps.stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), tty: m[3], cmd: m[4] });
  }
  const atime = (tty) => {
    try {
      return fs.statSync(`/dev/${tty}`).atimeMs;
    } catch {
      return -1;
    }
  };
  const clients = [...procs].filter(([, p]) => {
    const words = p.cmd.split(/\s+/);
    return !p.tty.startsWith("?") && path.basename(words[0]) === "herdr" && words[1] !== "server";
  });
  if (!clients.length) return [null, false];
  const [newest] = clients.reduce((a, b) => (atime(b[1].tty) > atime(a[1].tty) ? b : a));
  for (let pid = newest; procs.has(pid) && pid > 1; pid = procs.get(pid).ppid) {
    if (procs.get(pid).cmd.startsWith("sshd")) return [newest, true];
  }
  return [newest, false];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(qs) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-ask-user-"));
  const out = path.join(tmp, "answers.json");
  fs.writeFileSync(path.join(tmp, "questions.json"), JSON.stringify(qs));
  const workspace = process.env.HERDR_WORKSPACE_ID;
  const userWorkspace = snapshot().focused_workspace_id;
  const [client, overSsh] = activeClient();
  const env = ["--env", `HERDR_ASK_NODE=${process.execPath}`, "--env", `HERDR_ASK_SCRIPT=${SCRIPT}`, "--env", `HERDR_ASK_DIR=${tmp}`];
  const made = overSsh
    ? herdr("tab", "create", "--workspace", workspace, "--cwd", tmp, "--label", "Question", "--focus", ...env)
    : herdr("pane", "split", "--current", "--direction", "down", "--ratio", "0.6", "--cwd", tmp, ...env);
  if (made.status) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Failure(`herdr could not open the question: ${(made.stderr || made.stdout).trim()}`, 4);
  }
  const result = JSON.parse(made.stdout).result;
  const tabId = overSsh ? result.tab.tab_id : null;
  const pane = overSsh ? result.root_pane.pane_id : result.pane.pane_id;
  try {
    if (overSsh) {
      herdr("tab", "focus", tabId);
      try {
        process.kill(client, "SIGWINCH");
      } catch {}
    } else {
      herdr("pane", "focus", "--current", "--direction", "down");
    }
    if (userWorkspace !== workspace) {
      herdr("workspace", "focus", userWorkspace);
      const label = snapshot().workspaces.find((w) => w.workspace_id === workspace).label;
      herdr("notification", "show", `Question waiting in ${label}`, "--body", qs[0].question, "--sound", "request");
    }
    herdr("pane", "run", pane, ' clear; exec "$HERDR_ASK_NODE" "$HERDR_ASK_SCRIPT" --tui "$HERDR_ASK_DIR"');
    let checked = Date.now();
    let misses = 0;
    while (!fs.existsSync(out)) {
      await sleep(300);
      if (Date.now() - checked > 2000) {
        checked = Date.now();
        misses = herdr("pane", "get", pane).status ? misses + 1 : 0;
        if (misses === 3) return { cancelled: true, answers: [] };
      }
    }
    const res = JSON.parse(fs.readFileSync(out, "utf8"));
    if (res.error) throw new Failure(`Question screen crashed:\n${res.error}`, 4);
    return res;
  } finally {
    if (overSsh) {
      herdr("tab", "close", tabId);
      if (snapshot().focused_workspace_id === workspace) herdr("tab", "focus", process.env.HERDR_TAB_ID);
    } else {
      herdr("pane", "close", pane);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- question screen ----

const COLOR256 = /256|truecolor|24bit/.test(`${process.env.TERM} ${process.env.COLORTERM}`);
const ST = {
  title: "\x1b[1;36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  answer: "\x1b[32m",
  footer: "\x1b[33m",
  selected: COLOR256 ? "\x1b[1;38;5;156;48;5;237m" : "\x1b[1;32m",
};
const out = (s) => process.stdout.write(s);
const size = () => ({ rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 });
const chars = (s) => Array.from(s);

function wrap(text, width) {
  const lines = [];
  for (const para of text.split("\n")) {
    let line = [];
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = chars(word);
      while (w.length > width) {
        if (line.length) lines.push(line.join("")), (line = []);
        lines.push(w.slice(0, width).join(""));
        w = w.slice(width);
      }
      if (!w.length) continue;
      if (line.length && line.length + 1 + w.length > width) lines.push(line.join("")), (line = []);
      if (line.length) line.push(" ");
      line.push(...w);
    }
    lines.push(line.join(""));
  }
  return lines;
}

function chunk(text, width) {
  const lines = [];
  for (const para of text.split("\n")) {
    const c = chars(para);
    if (!c.length) lines.push("");
    for (let i = 0; i < c.length; i += width) lines.push(c.slice(i, i + width).join(""));
  }
  return lines;
}

class Screen {
  constructor() {
    this.lines = [];
  }
  width() {
    return Math.max(10, size().cols - 2 * PAD);
  }
  add(text, style = "", raw = false) {
    for (const ln of raw ? chunk(text, this.width()) : wrap(text, this.width())) this.lines.push([ln, style]);
  }
  addHanging(prefix, text, style = "") {
    const pad = " ".repeat(prefix.length);
    for (const ln of wrap(text, Math.max(10, this.width() - prefix.length))) {
      this.lines.push([prefix + ln, style]);
      prefix = pad;
    }
  }
  footerLines(footer) {
    return wrap(footer, this.width() - 3);
  }
  draw(footer, offset, cursor) {
    const { rows } = size();
    const flines = this.footerLines(footer);
    const body = Math.max(1, rows - flines.length);
    const top = Math.max(0, Math.min(this.lines.length - body, offset));
    let frame = "\x1b[?25l\x1b[H\x1b[2J";
    this.lines.slice(top, top + body).forEach(([ln, style], i) => {
      frame += `\x1b[${i + 1};${PAD + 1}H${style}${ln}\x1b[0m`;
    });
    const more = (top > 0 ? "▲" : "") + (top + body < this.lines.length ? "▼" : "");
    const prefix = more ? `${more.padEnd(2)} ` : "";
    flines.forEach((ln, i) => {
      frame += `\x1b[${body + i + 1};${PAD + 1}H${ST.footer}${i ? " ".repeat(prefix.length) : prefix}${ln}\x1b[0m`;
    });
    if (cursor && cursor.line >= top && cursor.line < top + body) {
      frame += `\x1b[${cursor.line - top + 1};${PAD + cursor.col + 1}H\x1b[?25h`;
    }
    out(frame);
    return { top, body };
  }
}

const keys = [];
let waiting = null;
let pending = "";
let escTimer = null;

function push(key) {
  if (waiting) {
    const w = waiting;
    waiting = null;
    w(key);
  } else keys.push(key);
}

function nextKey() {
  return keys.length ? Promise.resolve(keys.shift()) : new Promise((r) => (waiting = r));
}

const CSI_KEYS = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const TILDE_KEYS = { 1: "home", 7: "home", 4: "end", 8: "end", 3: "delete", 5: "pageup", 6: "pagedown" };

function tokenize(data) {
  clearTimeout(escTimer);
  let s = pending + data;
  pending = "";
  const tokens = [];
  while (s) {
    let m;
    if ((m = s.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/))) {
      tokens.push({ name: "mouse", button: Number(m[1]), y: Number(m[3]) - 1, press: m[4] === "M" });
    } else if ((m = s.match(/^\x1b\[([\d;]*)([A-Za-z~])/))) {
      const name = m[2] === "~" ? TILDE_KEYS[m[1].split(";")[0]] : CSI_KEYS[m[2]];
      if (name) tokens.push({ name });
    } else if ((m = s.match(/^\x1bO([A-Za-z])/))) {
      if (CSI_KEYS[m[1]]) tokens.push({ name: CSI_KEYS[m[1]] });
    } else if (s === "\x1b" || /^\x1b(\[[\d;<]*|O)?$/.test(s)) {
      pending = s;
      escTimer = setTimeout(() => {
        pending = "";
        push({ name: "esc" });
      }, 60);
      break;
    } else if ((m = s.match(/^\x1b./su))) {
      tokens.push({ name: "alt" });
    } else {
      m = [chars(s)[0]];
      const c = m[0];
      if (c === "\r" || c === "\n") tokens.push({ name: "enter" });
      else if (c === "\x7f" || c === "\b") tokens.push({ name: "backspace" });
      else if (c === "\x04") tokens.push({ name: "delete" });
      else if (c === "\x03") tokens.push({ name: "interrupt" });
      else if (c >= " ") tokens.push({ name: "char", ch: c });
    }
    s = s.slice(m[0].length);
  }
  tokens.forEach((t, i) => {
    if (t.name === "enter") t.pasted = i < tokens.length - 1;
    push(t);
  });
}

function header(s, head, title, context) {
  s.add(head, ST.title);
  s.add(title, ST.bold);
  if (Array.isArray(context)) {
    for (const [prefix, question, answer] of context) {
      s.add("");
      s.addHanging(prefix, question);
      s.addHanging(" ".repeat(prefix.length), answer, ST.answer);
    }
  } else if (context) {
    s.add("");
    s.add(context);
  }
  s.add("");
}

function cursorPos(buf, cur, width) {
  const text = buf.join("");
  const before = buf.slice(0, cur).join("").split("\n");
  let row = 0;
  for (const p of before.slice(0, -1)) row += Math.max(1, Math.ceil(chars(p).length / width));
  const line = chars(before[before.length - 1]).length;
  const atLineEnd = cur === buf.length || buf[cur] === "\n";
  if (line && line % width === 0 && atLineEnd) return [row + line / width - 1, width];
  return [row + Math.floor(line / width), line % width];
}

async function page(st, head, title, context, labels, other, canNext, footer) {
  const otherIdx = other ? labels.length : null;
  let follow = false;
  for (;;) {
    const { sel, buf } = st;
    const s = new Screen();
    header(s, head, title, context);
    const spans = [];
    const items = other ? [...labels, `${labels.length + 1}. ${OTHER}`] : labels;
    items.forEach((text, n) => {
      if (st.answer && st.picked === n) text += " ✓";
      const start = s.lines.length;
      s.add(text, n === sel ? ST.selected : "");
      spans.push([start, s.lines.length - 1]);
    });
    const editing = other && sel === otherIdx;
    st.cur = Math.min(st.cur, buf.length);
    const cur = st.cur;
    const bufStart = s.lines.length;
    if (other && (editing || buf.length)) {
      s.add(buf.length ? buf.join("") : "Type here…", buf.length ? "" : ST.dim, true);
      spans[otherIdx] = [spans[otherIdx][0], s.lines.length - 1];
    }
    const [row, col] = cursorPos(buf, cur, s.width());
    const cursorLine = bufStart + row;
    let [first, last] = spans[sel];
    if (editing) last = cursorLine;
    const foot = footer(editing);
    const fullBody = Math.max(1, size().rows - s.footerLines(foot).length);
    if (follow) {
      st.offset = Math.min(Math.max(st.offset, last - fullBody + 1), first);
      if (last >= st.offset + fullBody) st.offset = last - fullBody + 1;
      follow = false;
    }
    const { top, body } = s.draw(foot, st.offset, editing ? { line: cursorLine, col } : null);
    st.offset = top;
    const k = await nextKey();
    if (k.name === "resize") continue;
    if (k.name === "interrupt") return ["cancel"];
    if (k.name === "esc") {
      if (editing) continue;
      return ["cancel"];
    }
    if (k.name === "mouse") {
      if (k.button === 64) st.offset -= 3;
      else if (k.button === 65) st.offset += 3;
      else if (k.button === 0 && k.press) {
        const hit = spans.findIndex(([a, b]) => a <= top + k.y && top + k.y <= b);
        if (hit === otherIdx) st.sel = otherIdx;
        else if (hit >= 0) {
          st.sel = hit;
          return ["pick", hit];
        }
      }
      continue;
    }
    if (editing && ["left", "right", "home", "end"].includes(k.name)) {
      const text = buf.join("");
      const lineStart = text.lastIndexOf("\n", cur - 1) + 1;
      const nextBreak = text.indexOf("\n", cur);
      st.cur = {
        left: Math.max(0, cur - 1),
        right: Math.min(buf.length, cur + 1),
        home: chars(text.slice(0, lineStart)).length,
        end: nextBreak < 0 ? buf.length : chars(text.slice(0, nextBreak)).length,
      }[k.name];
      follow = true;
      continue;
    }
    if (k.name === "left") return ["prev"];
    if (k.name === "right") {
      if (canNext) return ["next"];
      out("\x07");
    } else if (k.name === "up" || (k.name === "char" && k.ch === "k" && !editing)) {
      if (first < top || sel === 0) st.offset -= 1;
      else (st.sel = sel - 1), (follow = true);
    } else if (k.name === "down" || (k.name === "char" && k.ch === "j" && !editing)) {
      if (last >= top + body || sel === spans.length - 1) st.offset += 1;
      else (st.sel = sel + 1), (follow = true);
    } else if (k.name === "pageup") st.offset -= body;
    else if (k.name === "pagedown") st.offset += body;
    else if (editing) {
      if (k.name === "enter" && !k.pasted) {
        if (buf.join("").trim()) return ["other"];
      } else if (k.name === "backspace") {
        if (cur) buf.splice(cur - 1, 1), (st.cur = cur - 1);
      } else if (k.name === "delete") buf.splice(cur, 1);
      else if (k.name === "enter") buf.splice(cur, 0, " "), (st.cur = cur + 1);
      else if (k.name === "char") buf.splice(cur, 0, k.ch), (st.cur = cur + 1);
      follow = true;
    } else if (k.name === "char" && /^[1-9]$/.test(k.ch) && Number(k.ch) <= spans.length) {
      st.sel = Number(k.ch) - 1;
      follow = true;
    } else if (k.name === "enter") return ["pick", sel];
  }
}

function label(q, n) {
  return `${n + 1}. ${q.options[n]}${q.recommended === n + 1 ? " (recommended)" : ""}`;
}

const questionFooter = (editing) =>
  editing
    ? "↑↓ move/scroll · ←→ cursor · Enter submit"
    : "←→ questions · ↑↓ move/scroll · 1-9 or tap choose · Enter confirm · Esc cancel";
const reviewFooter = () => "← back · Enter or tap submit · Esc cancel";

function summary(answers) {
  return answers.map((a, i) => [`Q${i + 1}. `, a.question, a.answer + (a.notes ? `\n${a.notes}` : "")]);
}

function parseOther(q, text) {
  const m = text.match(/^\s*(\d+)(?:\s*[+:.,)\-]\s*|\s+|$)([\s\S]*)$/);
  const n = m ? Number(m[1]) : 0;
  if (n >= 1 && n <= q.options.length) {
    const answer = { question: q.question, choice: n, answer: q.options[n - 1] };
    if (m[2].trim()) answer.notes = m[2].trim();
    return answer;
  }
  return { question: q.question, choice: null, answer: text.trim(), other: true };
}

async function tui(qs) {
  const fresh = () => ({ sel: 0, buf: [], cur: 0, offset: 0, answer: null, picked: null });
  const states = qs.map((q) => ({ ...fresh(), sel: (q.recommended || 1) - 1 }));
  const review = fresh();
  let qi = 0;
  for (;;) {
    let act;
    if (qi === qs.length) {
      const answers = states.map((st) => st.answer);
      act = await page(review, "Review", "Submit these answers?", summary(answers), ["1. Submit answers"], false, false, reviewFooter);
      if (act[0] === "pick") return { cancelled: false, answers };
    } else {
      const q = qs[qi];
      const st = states[qi];
      const labels = q.options.map((_, n) => label(q, n));
      act = await page(st, `Question ${qi + 1} of ${qs.length}`, q.question, q.context, labels, true, st.answer !== null, questionFooter);
      if (act[0] === "pick") {
        st.answer = { question: q.question, choice: act[1] + 1, answer: q.options[act[1]] };
        st.picked = act[1];
        qi += 1;
      } else if (act[0] === "other") {
        st.answer = parseOther(q, st.buf.join(""));
        st.picked = q.options.length;
        qi += 1;
      } else if (act[0] === "next") qi += 1;
      if (qs.length === 1 && st.answer !== null && ["pick", "other"].includes(act[0])) return { cancelled: false, answers: [st.answer] };
    }
    if (act[0] === "cancel") return { cancelled: true, answers: states.filter((st) => st.answer).map((st) => st.answer) };
    if (act[0] === "prev") qi = Math.max(0, qi - 1);
  }
}

async function runTui(dir) {
  const qs = JSON.parse(fs.readFileSync(path.join(dir, "questions.json"), "utf8"));
  const restore = () => out("\x1b[?1006l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l");
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", tokenize);
  process.stdout.on("resize", () => push({ name: "resize" }));
  out("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
  let res;
  try {
    res = await tui(qs);
  } catch (e) {
    res = { error: e.stack };
  } finally {
    restore();
  }
  const file = path.join(dir, "answers.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(res));
  fs.renameSync(`${file}.tmp`, file);
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--tui") return runTui(args[1]);
  try {
    if (args.length !== 1 || ["-h", "--help"].includes(args[0])) throw new Failure("Usage: ask-user.mjs <questions.json | ->", 2);
    checkEnv();
    console.log(JSON.stringify(await ask(loadQuestions(args[0])), null, 2));
  } catch (e) {
    if (!(e instanceof Failure)) throw e;
    process.stderr.write(`${e.message}\n`);
    process.exitCode = e.code;
  }
}

main();
