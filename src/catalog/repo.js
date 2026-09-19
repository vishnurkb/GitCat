// Repo setup, config, worktrees, submodules, and the raw escape hatch.
import { splitArgs } from "../exec/run.js";
import { classifyRaw } from "./risk.js";

const rawArgv = (bin, command) => {
  const parts = splitArgs(String(command || "").trim());
  if (parts[0] === bin) parts.shift();
  return [bin, ...parts];
};

export default [
  {
    id: "init",
    desc: "make this folder a git repo (branch default main)",
    params: { branch: "str" },
    risk: "write",
    build: (p) => [["git", "init", "-b", p.branch || "main"]],
  },
  { id: "clone", desc: "clone any git URL", params: { url: "str!", dir: "str" }, risk: "write", build: (p) => [["git", "clone", p.url, ...(p.dir ? [p.dir] : [])]] },
  {
    id: "set_identity",
    desc: "set git user.name / user.email (global=true for all repos)",
    params: { name: "str", email: "str", global: "bool" },
    risk: "write",
    build: (p) => {
      const scope = p.global ? ["--global"] : [];
      const s = [];
      if (p.name) s.push(["git", "config", ...scope, "user.name", p.name]);
      if (p.email) s.push(["git", "config", ...scope, "user.email", p.email]);
      // nothing to set: show what's configured instead of silently doing nothing
      return s.length ? s : [["git", "config", "user.name"], ["git", "config", "user.email"]];
    },
  },
  { id: "config_set", desc: "set any git config key", params: { key: "str!", value: "str!", global: "bool" }, risk: "write", build: (p) => [["git", "config", ...(p.global ? ["--global"] : []), p.key, p.value]] },
  {
    id: "gitignore_add",
    desc: "add patterns to .gitignore (does not untrack already-tracked files; pair with untrack)",
    params: { patterns: "list!" },
    risk: "write",
    build: (p) => [{ internal: "gitignore", patterns: p.patterns }],
  },
  { id: "cd", desc: "change GitCat's working folder — ONLY when the user explicitly asks to switch to another folder. Mentioning a path is not a request to cd", params: { path: "str!" }, risk: "read", build: (p) => [{ internal: "cd", path: p.path }] },
  {
    id: "worktree_add",
    desc: "check out a branch in a separate folder (new=true creates the branch)",
    params: { path: "str!", branch: "str!", new: "bool" },
    risk: "write",
    build: (p) => [p.new ? ["git", "worktree", "add", "-b", p.branch, p.path] : ["git", "worktree", "add", p.path, p.branch]],
  },
  { id: "worktree_list", desc: "list worktrees", risk: "read", build: () => [["git", "worktree", "list"]] },
  { id: "worktree_remove", desc: "remove a worktree folder", params: { path: "str!", force: "bool" }, risk: (p) => (p.force ? "danger" : "write"), build: (p) => [["git", "worktree", "remove", ...(p.force ? ["--force"] : []), p.path]] },
  { id: "submodule_add", desc: "add a submodule", params: { url: "str!", path: "str" }, risk: "write", build: (p) => [["git", "submodule", "add", p.url, ...(p.path ? [p.path] : [])]] },
  { id: "submodule_update", desc: "init and update all submodules", risk: "write", build: () => [["git", "submodule", "update", "--init", "--recursive"]] },
  {
    id: "git_raw",
    desc: "any git command not covered above: bisect, notes, archive, describe, blame -L, etc. command = the git args",
    params: { command: "str!" },
    risk: (p) => classifyRaw(rawArgv("git", p.command)),
    warn: () => "Raw command chosen by the model — check it before running.",
    build: (p) => [rawArgv("git", p.command)],
  },
  {
    id: "gh_raw",
    desc: "any gh command not covered above: secret/variable list, gist, codespace, label, api, etc. command = the gh args",
    params: { command: "str!" },
    risk: (p) => classifyRaw(rawArgv("gh", p.command)),
    warn: () => "Raw command chosen by the model — check it before running.",
    build: (p) => [rawArgv("gh", p.command)],
  },
];
