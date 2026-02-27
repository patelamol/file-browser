# File Browser Plugin

Claude Code plugin that displays a file tree in a right-side tmux pane (25% width).

## Development

```bash
bun install
bun run src/cli.ts show          # Render tree in current terminal
bun run src/cli.ts toggle        # Toggle tmux pane
bun run src/cli.ts close         # Close tmux pane
```

## Architecture

- **Ink/React** for terminal UI rendering
- **tmux** for split pane management
- **IPC** via Unix domain sockets (newline-delimited JSON)
- **fs.watch** with recursive option for auto-refresh (300ms debounce)

## Key Files

- `src/cli.ts` — Entry point with subcommands
- `src/tree.ts` — Recursive file tree walker with .gitignore support
- `src/terminal.ts` — tmux pane lifecycle management
- `src/ipc.ts` — Unix socket IPC server/client
- `src/components/FileTree.tsx` — Ink React component
