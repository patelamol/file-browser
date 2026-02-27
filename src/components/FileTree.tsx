import React, { useState, useEffect, useRef, useCallback } from "react";
import { render, Box, Text, useStdout, useApp, useInput } from "ink";
import { watch, type FSWatcher } from "fs";
import { spawn } from "child_process";
import { basename } from "path";
import { walkTree, buildGitTree, type TreeNode, type GitStatus } from "../tree";
import { createIPCServer, type IPCServer, type ControllerMessage } from "../ipc";

interface FileTreeProps {
  cwd: string;
  socketPath?: string;
}

const STATUS_COLORS: Record<GitStatus, string> = {
  M: "yellow",
  A: "green",
  D: "red",
  "?": "gray",
  R: "cyan",
};

const STATUS_LABELS: Record<GitStatus, string> = {
  M: "M",
  A: "A",
  D: "D",
  "?": "?",
  R: "R",
};

function TreeEntry({ node, prefix, isLast }: { node: TreeNode; prefix: string; isLast: boolean }) {
  const connector = isLast ? "└── " : "├── ";
  const childPrefix = prefix + (isLast ? "    " : "│   ");

  return (
    <>
      <Box>
        <Text dimColor>{prefix}{connector}</Text>
        {node.isDir ? (
          <Text color="blue" bold>{node.name}/</Text>
        ) : (
          <Text color={node.gitStatus ? STATUS_COLORS[node.gitStatus] : undefined}>
            {node.name}
          </Text>
        )}
        {node.gitStatus && (
          <Text color={STATUS_COLORS[node.gitStatus]}> {STATUS_LABELS[node.gitStatus]}</Text>
        )}
      </Box>
      {node.children?.map((child, i) => (
        <TreeEntry
          key={child.path}
          node={child}
          prefix={childPrefix}
          isLast={i === node.children!.length - 1}
        />
      ))}
    </>
  );
}

function FileTreeApp({ cwd: initialCwd, socketPath }: FileTreeProps) {
  type ViewMode = "all" | "git";
  const [cwd, setCwd] = useState(initialCwd);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("all");
  const [focused, setFocused] = useState(false);
  const [, setTick] = useState(0);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const serverRef = useRef<IPCServer | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshTree = useCallback((dir: string, mode?: ViewMode) => {
    const m = mode ?? viewMode;
    setTree(m === "git" ? buildGitTree(dir) : walkTree(dir));
  }, [viewMode]);

  // Keyboard input — hotkeys only, no free typing
  useInput((input, key) => {
    if (input === "q") {
      exit();
    } else if (input === "r") {
      refreshTree(cwd);
    } else if (input === "g") {
      const next: ViewMode = viewMode === "all" ? "git" : "all";
      setViewMode(next);
      refreshTree(cwd, next);
    }
  });

  // Poll tmux to detect if this pane is focused
  useEffect(() => {
    // Read our pane ID from the persisted file
    let myPaneId = "";
    try {
      myPaneId = require("fs").readFileSync("/tmp/file-browser-pane-id", "utf-8").trim();
    } catch { return; }
    if (!myPaneId) return;

    const checkFocus = () => {
      const proc = spawn("tmux", ["list-panes", "-F", "#{pane_id} #{pane_active}"]);
      let out = "";
      proc.stdout?.on("data", (d) => { out += d.toString(); });
      proc.on("close", () => {
        for (const line of out.trim().split("\n")) {
          const [id, active] = line.split(" ");
          if (id === myPaneId) { setFocused(active === "1"); break; }
        }
      });
    };
    checkFocus();
    focusPollRef.current = setInterval(checkFocus, 200);
    return () => { if (focusPollRef.current) clearInterval(focusPollRef.current); };
  }, []);

  // Debounced refresh
  const debouncedRefresh = useCallback((dir: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => refreshTree(dir), 300);
  }, [refreshTree]);

  // Initial load + fs.watch
  useEffect(() => {
    refreshTree(cwd);

    let watcher: FSWatcher | null = null;
    try {
      watcher = watch(cwd, { recursive: true }, () => {
        debouncedRefresh(cwd);
      });
    } catch {
      // Fallback: poll every 2 seconds
      const interval = setInterval(() => refreshTree(cwd), 2000);
      return () => clearInterval(interval);
    }

    return () => {
      watcher?.close();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [cwd, refreshTree, debouncedRefresh]);

  // Terminal resize
  useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    stdout?.on("resize", onResize);
    return () => { stdout?.off("resize", onResize); };
  }, [stdout]);

  // IPC server
  useEffect(() => {
    if (!socketPath) return;

    let mounted = true;

    createIPCServer({
      socketPath,
      onMessage(msg: ControllerMessage) {
        switch (msg.type) {
          case "close":
            exit();
            break;
          case "ping":
            serverRef.current?.broadcast({ type: "pong" });
            break;
          case "refresh":
            refreshTree(cwd);
            break;
          case "setCwd":
            if (mounted) setCwd(msg.cwd);
            break;
        }
      },
    }).then((server) => {
      if (mounted) {
        serverRef.current = server;
        server.broadcast({ type: "ready" });
      } else {
        server.close();
      }
    });

    return () => {
      mounted = false;
      serverRef.current?.close();
    };
  }, [socketPath, cwd, refreshTree, exit]);

  const rows = stdout?.rows || 24;
  const dirName = basename(cwd);

  // Flatten tree for counting visible lines
  const flatCount = countNodes(tree);
  const maxVisible = rows - 3; // header + footer margin

  return (
    <Box flexDirection="column" paddingX={1} height={rows}>
      <Box marginBottom={1}>
        <Text bold color={focused ? "green" : "gray"}>📁 {dirName}</Text>
        <Text dimColor> [{viewMode === "all" ? "All" : "Git"}]</Text>
        {focused && <Text color="green"> ●</Text>}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {tree.map((node, i) => (
          <TreeEntry
            key={node.path}
            node={node}
            prefix=""
            isLast={i === tree.length - 1}
          />
        ))}
        {flatCount > maxVisible && (
          <Box marginTop={1}>
            <Text dimColor>... {flatCount - maxVisible} more entries</Text>
          </Box>
        )}
      </Box>
      <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
        <Text dimColor>q</Text><Text dimColor>:close </Text>
        <Text dimColor>r</Text><Text dimColor>:refresh </Text>
        <Text dimColor>g</Text><Text dimColor>:git </Text>
        <Text dimColor>click</Text><Text dimColor>:switch</Text>
      </Box>
    </Box>
  );
}

function countNodes(nodes: TreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count++;
    if (node.children) count += countNodes(node.children);
  }
  return count;
}

export async function renderFileTree(cwd: string, socketPath?: string): Promise<void> {
  // Clear screen and hide cursor
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");

  process.on("exit", () => process.stdout.write("\x1b[?25h"));
  process.on("SIGINT", () => {
    process.stdout.write("\x1b[?25h");
    process.exit();
  });

  const { waitUntilExit } = render(
    <FileTreeApp cwd={cwd} socketPath={socketPath} />,
    { exitOnCtrlC: true }
  );

  await waitUntilExit();
}
