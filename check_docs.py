#!/usr/bin/env python3
"""check_docs.py - tell me when the docs stopped being true.

Three checks, in the order they matter:

  1. Regenerates the file tree inside docs/structure.md between the GENERATED
     markers. A hand-maintained tree is wrong within a week; a generated one
     cannot be.
  2. Reports tracked paths that no doc mentions, and documented paths that no
     longer exist. This is the check a tree alone cannot do -- the tree tells
     you what is there, this tells you what nobody explained.
  3. Reports docs/architecture.html older than docs/architecture.md, because
     the HTML is a snapshot and a stale snapshot is trusted anyway.

Run:  python check_docs.py          report only
      python check_docs.py --write  also rewrite the tree block

Exit 1 when anything drifted, so it can gate CI. Only tracked files are
considered -- .gitignore is the definition of "part of the project".
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
STRUCTURE = os.path.join(ROOT, "docs", "structure.md")
ARCH_MD = os.path.join(ROOT, "docs", "architecture.md")
ARCH_HTML = os.path.join(ROOT, "docs", "architecture.html")

BEGIN = "<!-- GENERATED:tree -->"
END = "<!-- /GENERATED:tree -->"

# Files nobody needs a sentence about. Explaining these is noise that makes the
# genuinely load-bearing entries harder to find.
BORING = re.compile(
    r"(^|/)(\.gitkeep|\.gitignore|\.gitattributes|package-lock\.json|"
    r"poetry\.lock|yarn\.lock|pnpm-lock\.yaml|__init__\.py|py\.typed)$"
)
BORING_DIRS = ("node_modules/", ".venv/", "dist/", "build/", ".next/")


def tracked_files():
    try:
        out = subprocess.run(
            ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        sys.exit("  [ERROR] not a git repository, or git is not on PATH.")
    files = [f for f in out.splitlines() if f.strip()]
    return [f for f in files if not any(f.startswith(d) for d in BORING_DIRS)]


def build_tree(files):
    """ASCII tree from a flat path list. No external `tree` dependency: it is
    absent on Windows and formats differently on macOS."""
    tree = {}
    for f in files:
        node = tree
        for part in f.split("/"):
            node = node.setdefault(part, {})
    lines = []

    def walk(node, prefix=""):
        items = sorted(node.items(), key=lambda kv: (not kv[1], kv[0].lower()))
        for i, (name, child) in enumerate(items):
            last = i == len(items) - 1
            lines.append(prefix + ("`-- " if last else "|-- ") + name + ("/" if child else ""))
            if child:
                walk(child, prefix + ("    " if last else "|   "))

    walk(tree)
    return "\n".join(lines)


# Extensions that make a token a path claim rather than prose. Without this,
# `core.hooksPath` and `object.method` read as files and the report fills with
# noise -- and a checker that cries wolf is a checker nobody runs.
PATHY = re.compile(
    r"\.(py|ts|tsx|js|jsx|mjs|json|md|html|css|scss|sql|sh|bat|ya?ml|toml|ini|cfg|txt|env|example)$"
)
# Files where a new one appearing genuinely needs explaining. A new .md in an
# already-documented docs/ folder does not; a new route module does.
SOURCE = re.compile(r"\.(py|ts|tsx|js|jsx|mjs|go|rs|java|rb|sql)$")


def table_claims(text):
    """Backticked paths in the FIRST cell of a markdown table row.

    Deliberately not "every backtick in the file". Prose says things like "see
    `src/lib/hydrate.ts`" as an illustration; a table row is an assertion that
    the path exists. Only assertions should be checkable, or every example in
    the docs becomes a false positive.
    """
    found = set()
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("|") or set(line) <= set("|-: "):
            continue
        first = line.split("|")[1] if len(line.split("|")) > 1 else ""
        for tok in re.findall(r"`([^`\n]+)`", first):
            tok = tok.strip().rstrip("/")
            if tok and " " not in tok and ("/" in tok or PATHY.search(tok)):
                found.add(tok)
    return found


def documented_paths(text):
    """Every backticked path-looking token, anywhere. Used for the softer
    "has anyone explained this file" check, where a prose mention counts."""
    found = set()
    for tok in re.findall(r"`([^`\n]+)`", text):
        tok = tok.strip().rstrip("/")
        if not tok or " " in tok:
            continue
        if "/" in tok or PATHY.search(tok):
            found.add(tok)
    return found


def main():
    write = "--write" in sys.argv
    problems = 0
    files = tracked_files()

    # --- 1. tree ---------------------------------------------------------
    if not os.path.exists(STRUCTURE):
        print("  [ERROR] docs/structure.md is missing. It is required.")
        return 1

    text = open(STRUCTURE, encoding="utf-8").read()
    if BEGIN not in text or END not in text:
        print("  [ERROR] docs/structure.md has no %s / %s markers." % (BEGIN, END))
        return 1

    tree = build_tree(files)
    new_block = "%s\n```\n%s\n```\n%s" % (BEGIN, tree, END)
    old_block = text[text.index(BEGIN): text.index(END) + len(END)]

    if old_block != new_block:
        if write:
            open(STRUCTURE, "w", encoding="utf-8", newline="\n").write(
                text.replace(old_block, new_block)
            )
            print("  [fixed] regenerated the tree in docs/structure.md")
            text = text.replace(old_block, new_block)
        else:
            print("  [drift] the tree in docs/structure.md is out of date.")
            print("          fix:  python check_docs.py --write")
            problems += 1
    else:
        print("  [ok] tree is current")

    # --- 2. undocumented / phantom --------------------------------------
    all_docs = text
    for extra in ("docs/architecture.md", "docs/stack_and_tooling.md",
                  "start_commands.md", "README.md"):
        p = os.path.join(ROOT, extra)
        if os.path.exists(p):
            all_docs += "\n" + open(p, encoding="utf-8", errors="replace").read()

    mentioned = documented_paths(all_docs)
    documented_dirs = {m for m in mentioned if "/" in m and not PATHY.search(m)}

    def explained(f):
        if f in mentioned or os.path.basename(f) in mentioned:
            return True
        # In a folder that has been explained: fine for a doc or a config file,
        # not fine for a new source module -- that is exactly the thing whose
        # purpose nobody can guess from the folder name.
        parent = f.rsplit("/", 1)[0] if "/" in f else ""
        if parent and parent in documented_dirs and not SOURCE.search(f):
            return True
        return False

    undocumented = [f for f in files if not BORING.search(f) and not explained(f)]
    if undocumented:
        print("\n  [drift] tracked but explained nowhere (%d):" % len(undocumented))
        for f in undocumented[:25]:
            print("          %s" % f)
        if len(undocumented) > 25:
            print("          ... and %d more" % (len(undocumented) - 25))
        problems += 1

    on_disk = set(files) | {d for f in files for d in _parents(f)}
    claims = table_claims(open(STRUCTURE, encoding="utf-8").read())
    phantom = sorted(
        p for p in claims
        if p not in on_disk
        and not p.startswith(("http", "www."))
        and "*" not in p
        and not os.path.exists(os.path.join(ROOT, p))
    )
    if phantom:
        print("\n  [drift] documented but not in the repo (%d):" % len(phantom))
        for p in phantom[:25]:
            print("          %s" % p)
        print("          Either it was deleted and the doc still claims it exists,")
        print("          or it is an external reference -- rephrase so it is clear.")
        problems += 1

    # --- 3. stale html snapshot -----------------------------------------
    if os.path.exists(ARCH_MD) and os.path.exists(ARCH_HTML):
        if os.path.getmtime(ARCH_HTML) < os.path.getmtime(ARCH_MD):
            print("\n  [drift] docs/architecture.html is older than architecture.md.")
            print("          The HTML is a snapshot. Regenerate it, do not edit it.")
            problems += 1

    print("")
    if problems:
        print("  %d doc problem(s). Nothing here blocks you; it just means a" % problems)
        print("  file on disk is now claiming something that is not true.")
        return 1
    print("  Docs match the repo.")
    return 0


def _parents(path):
    parts = path.split("/")[:-1]
    return ["/".join(parts[: i + 1]) for i in range(len(parts))]


if __name__ == "__main__":
    sys.exit(main())
