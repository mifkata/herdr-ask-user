#!/usr/bin/env python3
import curses
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import traceback

OTHER = 'Other (type, or "N + notes")'
PAD = 1
ESC_KEYS = {"[H": curses.KEY_HOME, "OH": curses.KEY_HOME, "[1~": curses.KEY_HOME, "[F": curses.KEY_END,
            "OF": curses.KEY_END, "[4~": curses.KEY_END, "[3~": curses.KEY_DC}
MOUSE_ON, MOUSE_OFF = b"\x1b[?1000h\x1b[?1006h", b"\x1b[?1006l\x1b[?1000l"


def fail(msg, code):
    print(msg, file=sys.stderr)
    sys.exit(code)


def load_questions(src):
    try:
        qs = json.load(sys.stdin if src == "-" else open(src))
    except (OSError, ValueError) as e:
        fail(f"Cannot read questions: {e}", 2)
    if isinstance(qs, dict):
        qs = [qs]
    if not isinstance(qs, list) or not qs:
        fail("Questions must be a non-empty JSON list.", 2)
    for i, q in enumerate(qs, 1):
        opts = q.get("options") if isinstance(q, dict) else None
        if not isinstance(q, dict) or not isinstance(q.get("question"), str) or not opts \
                or not all(isinstance(o, str) for o in opts):
            fail(f'Question {i} needs "question" (string) and "options" (non-empty list of strings).', 2)
        rec = q.get("recommended")
        if rec is not None and not (isinstance(rec, int) and 1 <= rec <= len(opts)):
            fail(f'Question {i}: "recommended" must be an option number 1-{len(opts)}.', 2)
    return qs


def herdr(*args):
    return subprocess.run(["herdr", *args], capture_output=True, text=True)


def check_env():
    if os.environ.get("CLAUDECODE") == "1":
        fail("Claude Code: use the built-in AskUserQuestion tool instead.", 3)
    if not all(os.environ.get(v) for v in ("HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID")) \
            or not shutil.which("herdr"):
        fail("Not running inside a herdr pane: ask the user in chat instead.", 3)


def snapshot():
    return json.loads(herdr("api", "snapshot").stdout)["result"]["snapshot"]


def active_client():
    """The attached herdr client with the latest keyboard input (tty atime), and whether it runs over SSH."""
    procs = {}
    for line in subprocess.run(["ps", "-axo", "pid=,ppid=,tty=,command="], capture_output=True, text=True).stdout.splitlines():
        pid, ppid, tty, cmd = line.split(None, 3)
        procs[int(pid)] = (int(ppid), tty, cmd)
    clients = [pid for pid, (_, tty, cmd) in procs.items()
               if tty != "??" and os.path.basename(cmd.split()[0]) == "herdr" and "server" not in cmd.split()[1:2]]
    if not clients:
        return None, False
    newest = max(clients, key=lambda pid: os.stat(f"/dev/{procs[pid][1]}").st_atime)
    pid = newest
    while pid in procs and pid > 1:
        if procs[pid][2].startswith("sshd"):
            return newest, True
        pid = procs[pid][0]
    return newest, False


def ask(qs):
    tmp = tempfile.mkdtemp(prefix="herdr-ask-user-")
    out = os.path.join(tmp, "answers.json")
    json.dump(qs, open(os.path.join(tmp, "questions.json"), "w"))
    workspace = os.environ["HERDR_WORKSPACE_ID"]
    user_workspace = snapshot()["focused_workspace_id"]
    client, over_ssh = active_client()
    env = ["--env", f"HERDR_ASK_PY={sys.executable}", "--env", f"HERDR_ASK_SCRIPT={os.path.abspath(__file__)}",
           "--env", f"HERDR_ASK_DIR={tmp}"]
    if over_ssh:
        made = herdr("tab", "create", "--workspace", workspace, "--cwd", tmp, "--label", "Question", "--focus", *env)
    else:
        made = herdr("pane", "split", "--current", "--direction", "down", "--ratio", "0.6", "--cwd", tmp, *env)
    if made.returncode:
        shutil.rmtree(tmp, ignore_errors=True)
        fail(f"herdr could not open the question: {made.stderr.strip() or made.stdout.strip()}", 4)
    result = json.loads(made.stdout)["result"]
    tab_id = result["tab"]["tab_id"] if over_ssh else None
    pane = result["root_pane"]["pane_id"] if over_ssh else result["pane"]["pane_id"]
    try:
        if over_ssh:
            herdr("tab", "focus", tab_id)
            os.kill(client, signal.SIGWINCH)
        else:
            herdr("pane", "focus", "--current", "--direction", "down")
        if user_workspace != workspace:
            herdr("workspace", "focus", user_workspace)
            label = next(w["label"] for w in snapshot()["workspaces"] if w["workspace_id"] == workspace)
            herdr("notification", "show", f"Question waiting in {label}", "--body", qs[0]["question"],
                  "--sound", "request")
        herdr("pane", "run", pane, ' clear; exec "$HERDR_ASK_PY" "$HERDR_ASK_SCRIPT" --tui "$HERDR_ASK_DIR"')
        checked, misses = time.monotonic(), 0
        while not os.path.exists(out):
            time.sleep(0.3)
            if time.monotonic() - checked > 2:
                checked = time.monotonic()
                misses = misses + 1 if herdr("pane", "get", pane).returncode else 0
                if misses == 3:
                    return {"cancelled": True, "answers": []}
        res = json.load(open(out))
        if "error" in res:
            fail(f"Question screen crashed:\n{res['error']}", 4)
        return res
    finally:
        if over_ssh:
            herdr("tab", "close", tab_id)
            if snapshot()["focused_workspace_id"] == workspace:
                herdr("tab", "focus", os.environ["HERDR_TAB_ID"])
        else:
            herdr("pane", "close", pane)
        shutil.rmtree(tmp, ignore_errors=True)


class Screen:
    def __init__(self, scr):
        self.scr = scr
        self.lines = []

    def width(self):
        return max(10, self.scr.getmaxyx()[1] - 2 * PAD)

    def add(self, text, attr=0, raw=False):
        w = self.width()
        for para in text.split("\n"):
            chunks = [para[i:i + w] for i in range(0, len(para), w)] if raw else textwrap.wrap(para, w)
            for ln in chunks or [""]:
                self.lines.append((ln, attr))

    def add_hanging(self, prefix, text, attr=0):
        pad = " " * len(prefix)
        width = max(10, self.width() - len(prefix))
        for para in text.split("\n"):
            for ln in textwrap.wrap(para, width) or [""]:
                self.lines.append((prefix + ln, attr))
                prefix = pad

    def footer_lines(self, footer):
        return textwrap.wrap(footer, self.width() - 3) or [""]

    def draw(self, footer, offset):
        self.scr.erase()
        h, w = self.scr.getmaxyx()
        flines = self.footer_lines(footer)
        body = max(1, h - len(flines))
        top = max(0, min(len(self.lines) - body, offset))
        for i, (ln, attr) in enumerate(self.lines[top:top + body]):
            try:
                self.scr.addstr(i, PAD, ln[: w - 2 * PAD], attr)
            except curses.error:
                pass
        more = ("▲" if top > 0 else "") + ("▼" if top + body < len(self.lines) else "")
        for i, ln in enumerate(flines):
            prefix = f"{more:<2} " if more else ""
            try:
                self.scr.addstr(body + i, PAD, (prefix if i == 0 else " " * len(prefix)) + ln, curses.color_pair(3))
            except curses.error:
                pass
        self.lines = []
        return top, body


def header(s, head, title, context):
    s.add(head, curses.color_pair(1) | curses.A_BOLD)
    s.add(title, curses.A_BOLD)
    if isinstance(context, list):
        for prefix, question, answer in context:
            s.add("")
            s.add_hanging(prefix, question)
            s.add_hanging(" " * len(prefix), answer, curses.color_pair(2))
    elif context:
        s.add("")
        s.add(context)
    s.add("")


def page(scr, st, head, title, context, labels, other, can_next, footer):
    s = Screen(scr)
    other_idx = len(labels) if other else None
    follow = False
    while True:
        sel, buf = st["sel"], st["buf"]
        header(s, head, title, context)
        spans = []
        for n, text in enumerate(labels + ([f"{len(labels) + 1}. {OTHER}"] if other else [])):
            if st["answer"] is not None and st["picked"] == n:
                text += " ✓"
            start = len(s.lines)
            s.add(text, curses.color_pair(4) | curses.A_BOLD if n == sel else 0)
            spans.append((start, len(s.lines) - 1))
        editing = other and sel == other_idx
        cur = st["cur"] = min(st["cur"], len(buf))
        buf_start = len(s.lines)
        if other and (editing or buf):
            s.add(buf if buf else "Type here…", 0 if buf else curses.A_DIM, raw=True)
            spans[other_idx] = (spans[other_idx][0], len(s.lines) - 1)
        row, col = cursor_pos(buf, cur, s.width())
        cursor_line = buf_start + row
        first, last = spans[sel]
        if editing:
            last = cursor_line
        foot = footer(editing)
        body = max(1, scr.getmaxyx()[0] - len(s.footer_lines(foot)))
        if follow:
            st["offset"] = min(max(st["offset"], last - body + 1), first)
            if last >= st["offset"] + body:
                st["offset"] = last - body + 1
            follow = False
        top, body = s.draw(foot, st["offset"])
        st["offset"] = top
        if editing and top <= cursor_line < top + body:
            curses.curs_set(1)
            try:
                scr.move(cursor_line - top, PAD + col)
            except curses.error:
                pass
        else:
            curses.curs_set(0)
        k = read_key(scr)
        if k == "\x1b":
            seq = read_escape(scr)
            if not seq:
                if editing:
                    continue
                return ("cancel",)
            m = re.fullmatch(r"\[<(\d+);(\d+);(\d+)([Mm])", seq)
            if m:
                button, y = int(m.group(1)), int(m.group(3)) - 1
                if button == 64:
                    st["offset"] -= 3
                elif button == 65:
                    st["offset"] += 3
                elif button == 0 and m.group(4) == "M":
                    hit = [n for n, (a, b) in enumerate(spans) if a <= top + y <= b]
                    if hit and hit[0] == other_idx:
                        st["sel"] = other_idx
                    elif hit:
                        st["sel"] = hit[0]
                        return ("pick", hit[0])
                continue
            k = ESC_KEYS.get(seq)
            if k is None:
                continue
        if editing and k in (curses.KEY_LEFT, curses.KEY_RIGHT, curses.KEY_HOME, curses.KEY_END):
            line_start = buf.rfind("\n", 0, cur) + 1
            line_end = buf.find("\n", cur) if "\n" in buf[cur:] else len(buf)
            st["cur"] = {curses.KEY_LEFT: max(0, cur - 1), curses.KEY_RIGHT: min(len(buf), cur + 1),
                         curses.KEY_HOME: line_start, curses.KEY_END: line_end}[k]
            follow = True
            continue
        if k == curses.KEY_LEFT:
            return ("prev",)
        if k == curses.KEY_RIGHT:
            if can_next:
                return ("next",)
            curses.beep()
        elif k == curses.KEY_UP or (k == "k" and not editing):
            if first < top or sel == 0:
                st["offset"] -= 1
            else:
                st["sel"], follow = sel - 1, True
        elif k == curses.KEY_DOWN or (k == "j" and not editing):
            if last >= top + body or sel == len(spans) - 1:
                st["offset"] += 1
            else:
                st["sel"], follow = sel + 1, True
        elif k == curses.KEY_PPAGE:
            st["offset"] -= body
        elif k == curses.KEY_NPAGE:
            st["offset"] += body
        elif editing:
            if k in ("\n", "\r", curses.KEY_ENTER) and not pasting(scr):
                if buf.strip():
                    return ("other",)
            elif k in ("\x7f", "\b", curses.KEY_BACKSPACE):
                if cur:
                    st["buf"], st["cur"] = buf[:cur - 1] + buf[cur:], cur - 1
            elif k in (curses.KEY_DC, "\x04"):
                st["buf"] = buf[:cur] + buf[cur + 1:]
            elif k in ("\n", "\r", curses.KEY_ENTER):
                st["buf"], st["cur"] = buf[:cur] + " " + buf[cur:], cur + 1
            elif isinstance(k, str) and k.isprintable():
                st["buf"], st["cur"] = buf[:cur] + k + buf[cur:], cur + len(k)
            follow = True
        elif isinstance(k, str) and k.isdigit() and 1 <= int(k) <= len(spans):
            st["sel"], follow = int(k) - 1, True
        elif k in ("\n", "\r", curses.KEY_ENTER):
            return ("pick", sel)


def cursor_pos(buf, cur, width):
    before = buf[:cur].split("\n")
    row = sum(max(1, -(-len(p) // width)) for p in before[:-1])
    line = before[-1]
    at_line_end = cur == len(buf) or buf[cur] == "\n"
    if line and len(line) % width == 0 and at_line_end:
        return row + len(line) // width - 1, width
    return row + len(line) // width, len(line) % width


def label(q, n):
    rec = " (recommended)" if q.get("recommended") == n + 1 else ""
    return f"{n + 1}. {q['options'][n]}{rec}"


def question_footer(editing):
    if editing:
        return "↑↓ move/scroll · ←→ cursor · Enter submit"
    return "←→ questions · ↑↓ move/scroll · 1-9 or tap choose · Enter confirm · Esc cancel"


def review_footer(editing):
    return "← back · Enter or tap submit · Esc cancel"


def summary(answers):
    return [(f"Q{n}. ", a["question"], a["answer"] + (f"\n{a['notes']}" if a.get("notes") else ""))
            for n, a in enumerate(answers, 1)]


def pasting(scr):
    scr.nodelay(True)
    try:
        ch = scr.get_wch()
    except curses.error:
        return False
    finally:
        scr.nodelay(False)
    curses.unget_wch(ch) if isinstance(ch, str) else curses.ungetch(ch)
    return True


def read_key(scr):
    scr.timeout(250)
    try:
        while True:
            try:
                return scr.get_wch()
            except curses.error:
                size = os.get_terminal_size(0)
                if (size.lines, size.columns) != scr.getmaxyx():
                    curses.resizeterm(size.lines, size.columns)
                    return curses.KEY_RESIZE
    finally:
        scr.timeout(-1)


def read_escape(scr):
    scr.nodelay(True)
    seq, deadline = "", time.monotonic() + 0.1
    try:
        while len(seq) < 16 and time.monotonic() < deadline:
            try:
                ch = scr.get_wch()
            except curses.error:
                time.sleep(0.005)
                continue
            if not isinstance(ch, str):
                break
            seq += ch
            if ch.isalpha() or ch == "~":
                break
    finally:
        scr.nodelay(False)
    return seq


def parse_other(q, text):
    m = re.match(r"\s*(\d+)(?:\s*[+:.,)\-]\s*|\s+|$)([\s\S]*)$", text)
    n = int(m.group(1)) if m else 0
    if 1 <= n <= len(q["options"]):
        answer = {"question": q["question"], "choice": n, "answer": q["options"][n - 1]}
        if m.group(2).strip():
            answer["notes"] = m.group(2).strip()
        return answer
    return {"question": q["question"], "choice": None, "answer": text.strip(), "other": True}


def tui(scr, qs):
    curses.curs_set(0)
    curses.use_default_colors()
    os.write(1, MOUSE_ON)
    for i, c in enumerate([curses.COLOR_CYAN, curses.COLOR_GREEN, curses.COLOR_YELLOW], 1):
        curses.init_pair(i, c, -1)
    if curses.COLORS >= 256:
        curses.init_pair(4, 156, 237)
    else:
        curses.init_pair(4, curses.COLOR_GREEN, -1)
    states = [{"sel": (q.get("recommended") or 1) - 1, "buf": "", "cur": 0, "offset": 0, "answer": None, "picked": None}
              for q in qs]
    review = {"sel": 0, "buf": "", "cur": 0, "offset": 0, "answer": None, "picked": None}
    qi = 0
    while True:
        if qi == len(qs):
            answers = [st["answer"] for st in states]
            act = page(scr, review, "Review", "Submit these answers?", summary(answers),
                       ["1. Submit answers"], False, False, review_footer)
            if act[0] == "pick":
                return {"cancelled": False, "answers": answers}
        else:
            q, st = qs[qi], states[qi]
            labels = [label(q, n) for n in range(len(q["options"]))]
            act = page(scr, st, f"Question {qi + 1} of {len(qs)}", q["question"], q.get("context"),
                       labels, True, st["answer"] is not None, question_footer)
            if act[0] == "pick":
                st["answer"], st["picked"] = {"question": q["question"], "choice": act[1] + 1,
                                              "answer": q["options"][act[1]]}, act[1]
                qi += 1
            elif act[0] == "other":
                st["answer"], st["picked"] = parse_other(q, st["buf"]), len(q["options"])
                qi += 1
            if len(qs) == 1 and st["answer"] is not None and act[0] in ("pick", "other"):
                return {"cancelled": False, "answers": [st["answer"]]}
            elif act[0] == "next":
                qi += 1
        if act[0] == "cancel":
            return {"cancelled": True, "answers": [st["answer"] for st in states if st["answer"]]}
        if act[0] == "prev":
            qi = max(0, qi - 1)


def main():
    args = sys.argv[1:]
    if args[:1] == ["--tui"]:
        os.environ.setdefault("ESCDELAY", "100")
        qs = json.load(open(os.path.join(args[1], "questions.json")))
        try:
            res = curses.wrapper(tui, qs)
        except Exception:
            res = {"error": traceback.format_exc()}
        finally:
            os.write(1, MOUSE_OFF)
        out = os.path.join(args[1], "answers.json")
        with open(out + ".tmp", "w") as f:
            json.dump(res, f)
        os.replace(out + ".tmp", out)
        return
    if len(args) != 1 or args[0] in ("-h", "--help"):
        fail("Usage: ask-user.py <questions.json | ->", 2)
    check_env()
    print(json.dumps(ask(load_questions(args[0])), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
