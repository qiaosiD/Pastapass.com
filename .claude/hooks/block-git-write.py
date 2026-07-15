#!/usr/bin/env python3
"""
PreToolUse(Bash) guardrail for the PastaPass project.

In this repo the USER runs `git commit` and `git push` manually — Claude must not.
Claude may still stage (`git add`) and inspect (`status` / `diff` / `log`).

Reads the hook JSON from stdin; if a Bash command's git *subcommand* is `commit`
or `push`, it prints a note to stderr and exits 2, which blocks the tool call.
Parsing is shlex-based so it keys off the real subcommand (not a substring), which
avoids false positives like `git log | grep commit` and handles global options such
as `git -C "/path with spaces" commit`.
"""
import json
import shlex
import sys

# git global options that consume the following token as their argument
GLOBAL_OPTS_WITH_ARG = {
    "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix",
}
BLOCKED = {"commit", "push"}


def command_from_stdin():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return ""
    if data.get("tool_name") not in (None, "Bash"):
        return ""
    return (data.get("tool_input") or {}).get("command") or ""


def has_blocked_subcommand(cmd):
    try:
        tokens = shlex.split(cmd)
    except ValueError:
        tokens = cmd.split()  # unbalanced quotes → best-effort
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok == "git" or tok.endswith("/git"):
            j = i + 1
            while j < len(tokens):
                t = tokens[j]
                if t in GLOBAL_OPTS_WITH_ARG:
                    j += 2          # skip the option AND its argument
                elif t.startswith("-"):
                    j += 1          # a flag like --no-pager / --git-dir=...
                else:
                    break
            if j < len(tokens) and tokens[j] in BLOCKED:
                return True
        i += 1
    return False


def main():
    cmd = command_from_stdin()
    if cmd and has_blocked_subcommand(cmd):
        sys.stderr.write(
            "Blocked by project policy: in PastaPass the user runs `git commit` and "
            "`git push` themselves, every time. Stage with `git add` if helpful, then "
            "leave the commit/push to the user — do not run them."
        )
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
