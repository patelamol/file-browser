#!/usr/bin/env bun
import { renderFileTree } from "./components/FileTree";
import { toggleBrowser, closeBrowser } from "./terminal";
import { sendCommand, getSocketPath } from "./ipc";

const args = process.argv.slice(2);
const command = args[0];

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}

async function main() {
  switch (command) {
    case "show": {
      const cwd = getArg("cwd") || process.cwd();
      const socket = getArg("socket");
      const paneId = getArg("pane-id");
      await renderFileTree(cwd, socket, paneId);
      break;
    }

    case "toggle": {
      const cwd = getArg("cwd") || process.cwd();
      await toggleBrowser(cwd);
      break;
    }

    case "close": {
      await closeBrowser();
      break;
    }

    case "refresh": {
      const id = args[1];
      if (!id) {
        console.error("Usage: file-browser refresh <id>");
        process.exit(1);
      }
      const socketPath = getSocketPath(id);
      const result = await sendCommand(socketPath, { type: "refresh" });
      if (!result) {
        console.error("Failed to send refresh command");
        process.exit(1);
      }
      break;
    }

    default:
      console.log(`file-browser v0.1.0

Usage:
  file-browser show [--cwd <path>] [--socket <path>]  Show file tree
  file-browser toggle [--cwd <path>]                   Toggle tmux pane
  file-browser close                                   Close tmux pane
  file-browser refresh <id>                            Refresh via IPC`);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
