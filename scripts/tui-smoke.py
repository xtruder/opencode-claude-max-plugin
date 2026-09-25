"""Real OpenCode v2 PTY smoke; fixture quotas, no inference or live sessions.
Run: uv run --with pexpect --with pyte python scripts/tui-smoke.py
"""
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

import pexpect
import pyte

root = Path(tempfile.mkdtemp(prefix="claude-tui-smoke-", dir=os.environ.get("TMPDIR")))
plugin = Path(__file__).resolve().parents[1] / "build"
env = {k: v for k, v in os.environ.items() if not k.startswith(("OPENCODE_", "ANTHROPIC_", "CLAUDE_"))}
for key, folder in [("HOME", "home"), ("XDG_CONFIG_HOME", "config"), ("XDG_STATE_HOME", "state"), ("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache")]:
    env[key] = str(root / folder)
    (root / folder).mkdir()
(root / "work").mkdir()
(root / "config/opencode").mkdir()
(root / "config/opencode/opencode.json").write_text(json.dumps({"plugins": [{"package": plugin.as_uri(), "options": {"poll_interval": 10}}]}))
(root / "config/opencode/cli.json").write_text(json.dumps({"plugins": [{"package": plugin.as_uri(), "options": {"poll_interval": 10}}]}))
(root / "state/opencode").mkdir()
cache = root / "state/opencode/usage-cache.json"
fixture = {"five_hour": {"utilization": 25, "resets_at": None}, "seven_day": {"utilization": 60, "resets_at": None}, "seven_day_sonnet": {"utilization": 42, "resets_at": None}, "extra_usage": {"is_enabled": False}}
def seed():
    cache.write_text(json.dumps({"api": fixture, "headers": None, "apiFetchedAt": int(time.time() * 1000), "apiRateLimitUntil": 0, "updatedAt": int(time.time() * 1000)}))
seed()
env["TERM"] = "xterm-256color"
binary = shutil.which("opencode")
assert binary, "opencode must be installed"
created = subprocess.run([binary, "api", "--standalone", "session.create", "-d", json.dumps({"title": "Isolated TUI smoke (no inference)"})], env=env, cwd=root / "work", capture_output=True, text=True, timeout=30)
assert created.returncode == 0, created.stderr
session = json.loads(created.stdout)["data"]["id"]
child = pexpect.spawn(binary, ["--standalone", "--session", session], env=env, cwd=str(root / "work"), dimensions=(45, 150), encoding="utf-8", timeout=1)
screen = pyte.Screen(150, 45)
stream = pyte.Stream(screen)
raw = []
def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        try:
            text = child.read_nonblocking(65536, timeout=.2)
            raw.append(text)
            stream.feed(text)
            if "\x1b[6n" in text:
                child.send("\x1b[1;1R")
            if "\x1b[c" in text:
                child.send("\x1b[?1;2c")
        except pexpect.TIMEOUT:
            pass
        except pexpect.EOF:
            break
    return "\n".join(screen.display)
def check(name, seconds, *expected):
    frame = pump(seconds)
    (root / f"{name}.txt").write_text(frame)
    for text in expected:
        assert text in frame, f"{name}: missing {text!r}; see {root}"
    assert "plugin failed" not in frame
    print(f"PASS {name}: {', '.join(expected)}")
    return frame
try:
    print(f"Evidence: {root}")
    check("sidebar", 10, "Claude Usage", "25%", "60%")
    child.send("/usage")
    check("completion", 1, "/usage", "Claude subscription usage")
    child.send("\r")
    frame = check("dialog", 2, "Claude Subscription Usage", "Sonnet (7d)", "42%", "Extra usage: disabled")
    def quota_width(frame):
        return max(len(row) for row in re.findall(r"5h \[[█░]*\] 25%", frame))
    wide = quota_width(frame)
    assert wide > 40, f"Dialog bar is too narrow: {wide}"
    child.setwinsize(45, 50)
    screen.resize(45, 50)
    frame = check("dialog-narrow", 2, "Claude Subscription Usage", "25%")
    narrow = quota_width(frame)
    assert 30 < narrow < wide, (narrow, wide)
    child.setwinsize(45, 150)
    screen.resize(45, 150)
    frame = check("dialog-wide", 2, "Claude Subscription Usage", "25%")
    assert quota_width(frame) == wide
    print(f"PASS bar resize: dialog content {wide} -> {narrow} -> {wide} columns")
    fixture["five_hour"]["utilization"] = 90
    seed()
    check("reactive-poll", 11, "90%", "Claude Subscription Usage")
    child.send("\x1b")
    frame = check("closed", 1, "Claude Usage", "90%")
    assert "Claude Subscription Usage" not in frame
    cache.unlink()
    check("unavailable", 11, "cached usage", "claude auth login")
finally:
    child.send("\x03")
    pump(1)
    if child.isalive():
        child.send("\x03")
        pump(1)
    child.close(force=True)
    (root / "terminal.raw").write_text("".join(raw))
logs = (root / "data/opencode/log/opencode.log").read_text()
assert "plugin operation failed" not in logs
print("PASS plugin logs: no load/setup failures; standalone fixture session only")
