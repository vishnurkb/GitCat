// Risk tiers: "read" (never asks), "write" (asks only in confirm mode),
// "danger" (always asks unless yolo mode). Used for raw commands typed by
// the user or chosen by the model via git_raw/gh_raw.

const DANGER = [
  /^git reset\b.*--hard/,
  /^git push\b.*(\s-f\b|--force|--delete|\s:\S)/,
  /^git clean\b(?!.*(-n|--dry-run))/,
  /^git branch\b.*\s-D\b/,
  /^git (checkout|restore)\b.*\s--?\s*\.?$/,
  /^git (checkout|restore)\b.*--\s/,
  /^git stash (drop|clear)\b/,
  /^git rebase\b/,
  /^git filter-(branch|repo)\b/,
  /^git reflog (expire|delete)\b/,
  /^git gc\b.*--prune/,
  /^git update-ref -d\b/,
  /^git rm\b(?!.*--cached)/,
  /^gh repo (delete|archive|edit)\b/,
  /^gh (pr|issue) (merge|delete)\b/,
  /^gh release delete\b/,
  /^gh secret (set|delete)\b/,
  /^gh auth (logout|refresh)\b/,
  /^gh api\b.*-X\s*(DELETE|PUT|PATCH|POST)/i,
];

const READ = [
  /^git (status|log|diff|show|blame|branch( -[avr]+| --list)?$|branch -vv|remote( -v)?$|tag( -n| -l|$)|stash (list|show)|reflog$|reflog -n|shortlog|ls-files|ls-remote|grep|rev-parse|describe|config (--get|--list|-l|user\.)|fetch|help|version|--version|worktree list|cat-file|count-objects|whatchanged|name-rev|merge-base|check-ignore)\b/,
  /^gh (auth status|repo (view|list)|pr (list|view|status|checks|diff)|issue (list|view|status)|run (list|view)|release (list|view)|browse|search|api(?!.*-X)|--version|status)\b/,
];

export function classifyRaw(argv) {
  const line = argv.join(" ");
  if (DANGER.some((r) => r.test(line))) return "danger";
  if (READ.some((r) => r.test(line))) return "read";
  return "write";
}
