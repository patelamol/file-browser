# File Browser for Claude Code

A file tree panel that sits on the right side of your terminal while using Claude Code. Navigate files, view git diffs, and open files in your editor — all without leaving your session.

![25% right pane with file tree](https://img.shields.io/badge/tmux-25%25_right_pane-blue)

## Quick Setup

```bash
git clone <repo-url> ~/.claude-file-browser
cd ~/.claude-file-browser
./install.sh
```

The install script will:
- Check and install **Bun** (runtime)
- Check and install **tmux** (pane management)
- Optionally install **git-delta** (rich colored diffs)
- Install npm dependencies
- Register the `/file-browser` slash command globally

## Requirements

- **Bun** — JavaScript runtime
- **tmux** — terminal multiplexer (Claude Code must run inside tmux)
- **git-delta** — optional, for syntax-highlighted diffs

## Usage

1. Start a tmux session: `tmux`
2. Launch Claude Code: `claude`
3. Type `/file-browser` to toggle the panel

### Keybindings

| Key | Action |
|-----|--------|
| `↑` `↓` / `j` `k` | Move cursor up/down |
| `←` `→` / `h` `l` | Jump to parent / first child |
| `Enter` | Open file in `$EDITOR`, or git diff in git mode |
| `g` | Toggle between All Files and Git Changes view |
| `r` | Refresh the tree |
| `q` | Close the file browser |
| `click` | Switch focus between Claude Code and file browser |

### Git Mode

Press `g` to switch to git mode. Only modified, added, and deleted files are shown with status indicators:

| Indicator | Meaning |
|-----------|---------|
| `M` yellow | Modified |
| `A` green | Added |
| `D` red | Deleted |
| `?` gray | Untracked |

Pressing `Enter` on a file in git mode opens a diff view with syntax highlighting (requires git-delta).

## Manual Setup

If you prefer not to use the install script:

```bash
# Install dependencies
brew install tmux git-delta  # macOS
bun install

# Register the slash command
mkdir -p ~/.claude/commands
cat > ~/.claude/commands/file-browser.md << 'EOF'
---
description: Toggle file tree panel on the right side
allowed-tools:
  - Bash
---

Toggle the file browser panel.

```bash
bun run /path/to/file-browser/src/cli.ts toggle --cwd "$CWD"
```
EOF
```

Replace `/path/to/file-browser` with the actual path to this repo.

## CLI

```bash
bun run src/cli.ts show [--cwd <path>]    # Render tree in current terminal
bun run src/cli.ts toggle [--cwd <path>]  # Toggle tmux pane
bun run src/cli.ts close                  # Close tmux pane
bun run src/cli.ts refresh <id>           # Refresh via IPC
```

## Architecture

- **Ink/React** for terminal UI rendering
- **tmux** for split pane management (25% width right side)
- **IPC** via Unix domain sockets (newline-delimited JSON)
- **fs.watch** with recursive option for auto-refresh (300ms debounce)
- **delta** for rich git diff rendering

## License

MIT
