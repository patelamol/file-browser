import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { render, Box, Text, useStdout, useApp, useInput } from "ink";
import { watch, type FSWatcher } from "fs";
import { spawn, spawnSync } from "child_process";
import { basename, relative } from "path";
import { walkTree, buildGitTree, type TreeNode, type GitStatus } from "../tree";
import { createIPCServer, type IPCServer, type ControllerMessage } from "../ipc";

interface FileTreeProps {
  cwd: string;
  socketPath?: string;
  paneId?: string;
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

interface FlatEntry {
  node: TreeNode;
  depth: number;
  prefix: string;
  connector: string;
  parentIndex: number; // -1 for root level
  firstChildIndex: number; // -1 if no children
}

function flattenTree(nodes: TreeNode[]): FlatEntry[] {
  const flat: FlatEntry[] = [];

  function walk(children: TreeNode[], depth: number, prefix: string, parentIdx: number) {
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      const isLast = i === children.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = prefix + (isLast ? "    " : "│   ");

      const myIndex = flat.length;
      flat.push({
        node,
        depth,
        prefix,
        connector,
        parentIndex: parentIdx,
        firstChildIndex: -1,
      });

      if (node.children && node.children.length > 0) {
        flat[myIndex].firstChildIndex = flat.length;
        walk(node.children, depth + 1, childPrefix, myIndex);
      }
    }
  }

  walk(nodes, 0, "", -1);
  return flat;
}

function openInTerminal(command: string, args: string[], cwd: string, onDone?: () => void): void {
  // Restore terminal before handing off to editor/pager
  process.stdout.write("\x1b[?25h"); // show cursor
  process.stdin.setRawMode?.(false);

  spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
  });

  // Restore Ink's raw mode and clear screen for re-render
  process.stdin.setRawMode?.(true);
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
  onDone?.();
}

function getEditor(): string {
  return process.env.EDITOR || process.env.VISUAL || "less";
}

function getPager(): string {
  return process.env.PAGER || "less";
}

function openFile(filePath: string, cwd: string, gitMode: boolean, onDone?: () => void): void {
  if (gitMode) {
    const relPath = relative(cwd, filePath);
    // Use delta for rich diff display (line numbers, syntax highlighting, colored backgrounds)
    // Falls back to git diff --color + less -R if delta is not installed
    const hasDelta = spawnSync("which", ["delta"], { stdio: "pipe" }).status === 0;
    // Check if file is tracked
    const isTracked = spawnSync("git", ["ls-files", relPath], { cwd, stdio: "pipe", encoding: "utf-8" })
      .stdout?.trim().length > 0;
    const diffArgs = isTracked
      ? `git diff -- '${relPath}'`
      : `git diff --no-index -- /dev/null '${relPath}'`;
    if (hasDelta) {
      openInTerminal("sh", ["-c", `${diffArgs} | delta --line-numbers --paging=never --hunk-header-style='line-number syntax' --hunk-header-decoration-style='' --file-style='yellow bold' --file-decoration-style='yellow ul' | less -RXS`], cwd, onDone);
    } else {
      openInTerminal("sh", ["-c", `${diffArgs} --color=always | less -RXS`], cwd, onDone);
    }
  } else {
    const editor = getEditor();
    openInTerminal(editor, [filePath], cwd, onDone);
  }
}

function trimLeft(str: string, offset: number): string {
  if (offset <= 0) return str;
  // Strip `offset` visible characters, preserving partial tree-drawing context
  return str.slice(offset);
}

function TreeLine({ entry, selected, hOffset }: { entry: FlatEntry; selected: boolean; hOffset: number }) {
  const { node, prefix, connector } = entry;
  const bgColor = selected ? "blue" : undefined;
  const fullPrefix = prefix + connector;
  const trimmed = trimLeft(fullPrefix, hOffset);
  const showPrefix = hOffset > 0 && trimmed.length > 0 ? "…" + trimmed.slice(1) : trimmed;

  return (
    <Box>
      <Text dimColor>{showPrefix}</Text>
      {node.isDir ? (
        <Text color={selected ? "white" : "blue"} bold backgroundColor={bgColor}>
          {node.name}/
        </Text>
      ) : (
        <Text
          color={node.gitStatus ? STATUS_COLORS[node.gitStatus] : selected ? "white" : undefined}
          backgroundColor={bgColor}
        >
          {node.name}
        </Text>
      )}
      {node.gitStatus && (
        <Text color={STATUS_COLORS[node.gitStatus]}> {STATUS_LABELS[node.gitStatus]}</Text>
      )}
    </Box>
  );
}

function FileTreeApp({ cwd: initialCwd, socketPath, paneId: myPaneIdProp }: FileTreeProps) {
  type ViewMode = "all" | "git";
  const [cwd, setCwd] = useState(initialCwd);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("all");
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const [, setTick] = useState(0);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const serverRef = useRef<IPCServer | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const flat = useMemo(() => flattenTree(tree), [tree]);

  const refreshTree = useCallback((dir: string, mode?: ViewMode, resetCursor = false) => {
    const m = mode ?? viewMode;
    const newTree = m === "git" ? buildGitTree(dir) : walkTree(dir);
    setTree(newTree);
    if (resetCursor) {
      setCursor(0);
    } else {
      // Clamp cursor to new tree size
      const newFlat = flattenTree(newTree);
      setCursor((c) => Math.min(c, Math.max(0, newFlat.length - 1)));
    }
  }, [viewMode]);

  // Keyboard input
  useInput((input, key) => {
    if (input === "q") {
      exit();
    } else if (input === "r") {
      refreshTree(cwd);
    } else if (input === "g") {
      const next: ViewMode = viewMode === "all" ? "git" : "all";
      setViewMode(next);
      refreshTree(cwd, next, true);
    } else if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(flat.length - 1, c + 1));
    } else if (key.leftArrow || input === "h") {
      // Go to parent
      if (flat.length > 0 && flat[cursor]) {
        const parentIdx = flat[cursor].parentIndex;
        if (parentIdx >= 0) setCursor(parentIdx);
      }
    } else if (key.rightArrow || input === "l") {
      // Go to first child
      if (flat.length > 0 && flat[cursor]) {
        const childIdx = flat[cursor].firstChildIndex;
        if (childIdx >= 0) setCursor(childIdx);
      }
    } else if (key.return) {
      // Open selected file
      if (flat.length > 0 && flat[cursor] && !flat[cursor].node.isDir) {
        openFile(flat[cursor].node.path, cwd, viewMode === "git", () => {
          // Force Ink to re-render after editor exits
          setTick((t) => t + 1);
        });
      }
    }
  });

  // Poll tmux to detect if this pane is focused
  useEffect(() => {
    // TMUX_PANE env var is the reliable way to get the pane ID we're running in
    // (tmux display-message -p returns the *active* pane, not ours)
    const myPaneId = myPaneIdProp || process.env.TMUX_PANE || "";
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
  const cols = stdout?.columns || 60;
  const dirName = basename(cwd);
  const maxVisible = rows - 5; // header + footer + margins
  const paneWidth = cols - 2; // account for paddingX

  // Scroll window: keep cursor visible
  const scrollStart = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), flat.length - maxVisible));
  const visibleEntries = flat.slice(scrollStart, scrollStart + maxVisible);
  const hiddenBelow = flat.length - (scrollStart + maxVisible);

  // Horizontal offset: shift left when the selected entry overflows pane width
  let hOffset = 0;
  if (flat.length > 0 && flat[cursor]) {
    const entry = flat[cursor];
    const lineWidth = entry.prefix.length + entry.connector.length + entry.node.name.length + (entry.node.isDir ? 1 : 0);
    if (lineWidth > paneWidth) {
      // Shift so the filename is fully visible with some prefix context
      const nameLen = entry.node.name.length + (entry.node.isDir ? 1 : 0) + 4; // name + some padding
      hOffset = Math.max(0, lineWidth - Math.max(paneWidth, nameLen));
    }
  }

  return (
    <Box flexDirection="column" paddingX={1} height={rows}>
      <Box marginBottom={1}>
        <Text bold color={focused ? "green" : "gray"}>📁 {dirName}</Text>
        <Text dimColor> [{viewMode === "all" ? "All" : "Git"}]</Text>
        {focused && <Text color="green"> ●</Text>}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {scrollStart > 0 && (
          <Text dimColor>  ↑ {scrollStart} more</Text>
        )}
        {flat.length === 0 && viewMode === "git" && (
          <Text dimColor italic>  No uncommitted changes</Text>
        )}
        {visibleEntries.map((entry, i) => (
          <TreeLine
            key={entry.node.path}
            entry={entry}
            selected={scrollStart + i === cursor}
            hOffset={hOffset}
          />
        ))}
        {hiddenBelow > 0 && (
          <Text dimColor>  ↓ {hiddenBelow} more</Text>
        )}
      </Box>
      <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
        <Text dimColor>⏎</Text><Text dimColor>:open </Text>
        <Text dimColor>g</Text><Text dimColor>:git </Text>
        <Text dimColor>↑↓←→</Text><Text dimColor>:nav </Text>
        <Text dimColor>q</Text><Text dimColor>:close</Text>
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

export async function renderFileTree(cwd: string, socketPath?: string, paneId?: string): Promise<void> {
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");

  process.on("exit", () => process.stdout.write("\x1b[?25h"));
  process.on("SIGINT", () => {
    process.stdout.write("\x1b[?25h");
    process.exit();
  });

  const { waitUntilExit } = render(
    <FileTreeApp cwd={cwd} socketPath={socketPath} paneId={paneId} />,
    { exitOnCtrlC: true }
  );

  await waitUntilExit();
}
