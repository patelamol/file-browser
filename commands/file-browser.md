---
description: Toggle file tree panel on the right side
allowed-tools:
  - Bash
---

Toggle the file browser panel. Opens a tmux split pane on the right showing the file tree of the current working directory.

Steps:
1. Check if running inside tmux
2. Toggle the file browser pane (opens if closed, closes if open)

```bash
cd $CWD && bun run src/cli.ts toggle --cwd "$CWD"
```
