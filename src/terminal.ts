import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";

const PANE_ID_FILE = "/tmp/file-browser-pane-id";

export function detectTmux(): boolean {
  return !!process.env.TMUX;
}

function getPaneId(): string | null {
  if (!existsSync(PANE_ID_FILE)) return null;
  try {
    return readFileSync(PANE_ID_FILE, "utf-8").trim();
  } catch {
    return null;
  }
}

function savePaneId(id: string): void {
  writeFileSync(PANE_ID_FILE, id);
}

function clearPaneId(): void {
  try {
    if (existsSync(PANE_ID_FILE)) unlinkSync(PANE_ID_FILE);
  } catch {}
}

function paneExists(paneId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("tmux", ["display-message", "-t", paneId, "-p", "#{pane_id}"]);
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

export async function spawnBrowser(cwd: string): Promise<string | null> {
  if (!detectTmux()) {
    console.error("file-browser requires tmux. Please run inside a tmux session.");
    return null;
  }

  const existingPaneId = getPaneId();
  if (existingPaneId && (await paneExists(existingPaneId))) {
    // Reuse existing pane
    await reusePane(existingPaneId, cwd);
    return existingPaneId;
  }

  return createNewPane(cwd);
}

function reusePane(paneId: string, cwd: string): Promise<void> {
  return new Promise((resolve) => {
    const killProc = spawn("tmux", ["send-keys", "-t", paneId, "C-c", ""]);
    killProc.on("close", () => {
      setTimeout(() => {
        const command = buildShowCommand(cwd);
        const proc = spawn("tmux", ["send-keys", "-t", paneId, `clear && ${command}`, "Enter"]);
        proc.on("close", () => resolve());
      }, 150);
    });
  });
}

function getCurrentPaneId(): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn("tmux", ["display-message", "-p", "#{pane_id}"]);
    let id = "";
    proc.stdout?.on("data", (data) => { id += data.toString(); });
    proc.on("close", () => resolve(id.trim()));
  });
}

function selectPane(paneId: string): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn("tmux", ["select-pane", "-t", paneId]);
    proc.on("close", () => resolve());
  });
}

function createNewPane(cwd: string): Promise<string | null> {
  return new Promise(async (resolve) => {
    const originalPaneId = await getCurrentPaneId();
    const command = buildShowCommand(cwd);
    const args = ["split-window", "-h", "-p", "25", "-d", "-P", "-F", "#{pane_id}", command];
    const proc = spawn("tmux", args);
    let paneId = "";

    proc.stdout?.on("data", (data) => {
      paneId += data.toString();
    });

    proc.on("close", async (code) => {
      if (code === 0 && paneId.trim()) {
        savePaneId(paneId.trim());
        // -d flag keeps focus on original pane, but ensure it
        await selectPane(originalPaneId);
        resolve(paneId.trim());
      } else {
        resolve(null);
      }
    });
  });
}

function buildShowCommand(cwd: string): string {
  const scriptDir = import.meta.dir;
  const cliPath = `${scriptDir}/cli.ts`;
  return `bun run ${cliPath} show --cwd '${cwd}'`;
}

export async function closeBrowser(): Promise<void> {
  const paneId = getPaneId();
  if (!paneId) return;

  if (await paneExists(paneId)) {
    await new Promise<void>((resolve) => {
      const proc = spawn("tmux", ["kill-pane", "-t", paneId]);
      proc.on("close", () => resolve());
    });
  }

  clearPaneId();
}

export async function toggleBrowser(cwd: string): Promise<void> {
  const paneId = getPaneId();
  if (paneId && (await paneExists(paneId))) {
    await closeBrowser();
  } else {
    clearPaneId();
    await spawnBrowser(cwd);
  }
}
