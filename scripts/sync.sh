#!/usr/bin/env bash
# Symlink every <name>/SKILL.md directory in this repo's root into the
# skills directories of Claude Code, Codex, Grok, Antigravity, and .agents,
# so all CLIs pick up the same skill set without duplicating files.
#
# Safe to re-run. Does not touch Codex's reserved skills/.system directory
# or anything that isn't a symlink this script itself would create.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CLAUDE_SKILLS="${CLAUDE_HOME:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}/skills"
CODEX_SKILLS="${CODEX_HOME:-$HOME/.codex}/skills"
GROK_SKILLS="${GROK_HOME:-$HOME/.grok}/skills"
AGY_SKILLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini/config}/skills"
AGENTS_SKILLS="${AGENTS_HOME:-$HOME/.agents}/skills"

SKILL_TARGETS=(
  "$CLAUDE_SKILLS"
  "$CODEX_SKILLS"
  "$GROK_SKILLS"
  "$AGY_SKILLS"
  "$AGENTS_SKILLS"
)

for target_base in "${SKILL_TARGETS[@]}"; do
  [ -d "$target_base" ] || mkdir -p "$target_base"
done

link_skill() {
  local skill_dir="$1" target_base="$2" name
  name="$(basename "$skill_dir")"
  local link="$target_base/$name"

  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "skip $link (exists and is not a symlink managed by this script)" >&2
    return
  fi
  if [ -L "$link" ] && [ "$(readlink -f "$link")" = "$(readlink -f "$skill_dir")" ]; then
    return
  fi
  ln -sfn "$skill_dir" "$link"
  echo "linked $link -> $skill_dir"
}

for skill_dir in "$REPO_ROOT"/*/; do
  skill_dir="${skill_dir%/}"
  [ -f "$skill_dir/SKILL.md" ] || continue
  for target_base in "${SKILL_TARGETS[@]}"; do
    link_skill "$skill_dir" "$target_base"
  done
done
