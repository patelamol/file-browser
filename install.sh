#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMAND_DIR="$HOME/.claude/commands"
COMMAND_FILE="$COMMAND_DIR/file-browser.md"

echo "=== File Browser for Claude Code ==="
echo ""

# Check / install bun
if ! command -v bun &>/dev/null; then
  echo "Bun is not installed."
  read -rp "Install Bun? [Y/n] " answer
  if [[ "${answer:-Y}" =~ ^[Yy]$ ]]; then
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  else
    echo "Bun is required. Aborting."
    exit 1
  fi
fi
echo "[ok] bun $(bun --version)"

# Check / install tmux
if ! command -v tmux &>/dev/null; then
  echo "tmux is not installed."
  if command -v brew &>/dev/null; then
    read -rp "Install tmux via Homebrew? [Y/n] " answer
    if [[ "${answer:-Y}" =~ ^[Yy]$ ]]; then
      brew install tmux
    else
      echo "tmux is required. Aborting."
      exit 1
    fi
  else
    echo "Please install tmux manually (e.g. apt install tmux, brew install tmux)."
    exit 1
  fi
fi
echo "[ok] tmux $(tmux -V)"

# Optional: install delta for rich git diffs
if ! command -v delta &>/dev/null; then
  echo ""
  echo "git-delta is not installed (optional, for rich colored diffs)."
  if command -v brew &>/dev/null; then
    read -rp "Install git-delta via Homebrew? [Y/n] " answer
    if [[ "${answer:-Y}" =~ ^[Yy]$ ]]; then
      brew install git-delta
    else
      echo "[skip] git-delta — diffs will use less with basic colors"
    fi
  else
    echo "[skip] git-delta — install manually for rich diffs: https://github.com/dandavison/delta"
  fi
else
  echo "[ok] delta $(delta --version | head -1)"
fi

# Install node dependencies
echo ""
echo "Installing dependencies..."
cd "$REPO_DIR"
bun install
echo "[ok] dependencies installed"

# Enable tmux mouse support
if command -v tmux &>/dev/null && [ -n "${TMUX:-}" ]; then
  tmux set-option -g mouse on 2>/dev/null || true
fi

# Install the slash command
mkdir -p "$COMMAND_DIR"
cat > "$COMMAND_FILE" <<CMDEOF
---
description: Toggle file tree panel on the right side
allowed-tools:
  - Bash
---

Toggle the file browser panel. Opens a tmux split pane on the right showing the file tree of the current working directory.

Steps:
1. Check if running inside tmux
2. Toggle the file browser pane (opens if closed, closes if open)

\`\`\`bash
bun run ${REPO_DIR}/src/cli.ts toggle --cwd "\$CWD"
\`\`\`
CMDEOF

echo "[ok] /file-browser command installed at $COMMAND_FILE"
echo ""
echo "=== Setup complete ==="
echo ""
echo "Usage:"
echo "  1. Start tmux:  tmux"
echo "  2. Start Claude: claude"
echo "  3. Type: /file-browser"
echo ""
echo "Keybindings (click file browser pane first):"
echo "  arrows/hjkl  Navigate the tree"
echo "  Enter        Open file (editor) or diff (git mode)"
echo "  g            Toggle All/Git view"
echo "  r            Refresh"
echo "  q            Close file browser"
