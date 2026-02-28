import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";

export function detectTmux(): boolean {
  return !!process.env.TMUX;
}

function getPaneIdFile(sourcePaneId: string): string {
  const safe = sourcePaneId.replace(/[^a-zA-Z0-9]/g, "");
  return `/tmp/file-browser-pane-${safe}`;
}

function readPaneId(paneIdFile: string): string | null {
  if (!existsSync(paneIdFile)) return null;
  try {
    return readFileSync(paneIdFile, "utf-8").trim();
  } catch {
    return null;
  }
}

function savePaneId(paneIdFile: string, id: string): void {
  writeFileSync(paneIdFile, id);
}

function clearPaneId(paneIdFile: string): void {
  try {
    if (existsSync(paneIdFile)) unlinkSync(paneIdFile);
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

  const sourcePaneId = await getCurrentPaneId();
  const paneIdFile = getPaneIdFile(sourcePaneId);

  const existingPaneId = readPaneId(paneIdFile);
  if (existingPaneId && (await paneExists(existingPaneId))) {
    // Reuse existing pane
    await reusePane(existingPaneId, cwd);
    return existingPaneId;
  }

  return createNewPane(cwd, sourcePaneId, paneIdFile);
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

function createNewPane(cwd: string, sourcePaneId: string, paneIdFile: string): Promise<string | null> {
  return new Promise(async (resolve) => {
    const command = buildShowCommand(cwd);
    const args = ["split-window", "-h", "-p", "25", "-d", "-P", "-F", "#{pane_id}", command];
    const proc = spawn("tmux", args);
    let paneId = "";

    proc.stdout?.on("data", (data) => {
      paneId += data.toString();
    });

    proc.on("close", async (code) => {
      if (code === 0 && paneId.trim()) {
        savePaneId(paneIdFile, paneId.trim());
        // -d flag keeps focus on original pane, but ensure it
        await selectPane(sourcePaneId);
        resolve(paneId.trim());
      } else {
        resolve(null);
      }
    });
  });
}

function buildShowCommand(cwd: string, browserPaneId?: string): string {
  const scriptDir = import.meta.dir;
  const cliPath = `${scriptDir}/cli.ts`;
  const paneArg = browserPaneId ? ` --pane-id '${browserPaneId}'` : "";
  return `bun run ${cliPath} show --cwd '${cwd}'${paneArg}`;
}

export async function closeBrowser(): Promise<void> {
  const sourcePaneId = await getCurrentPaneId();
  const paneIdFile = getPaneIdFile(sourcePaneId);
  const paneId = readPaneId(paneIdFile);
  if (!paneId) return;

  if (await paneExists(paneId)) {
    await new Promise<void>((resolve) => {
      const proc = spawn("tmux", ["kill-pane", "-t", paneId]);
      proc.on("close", () => resolve());
    });
  }

  clearPaneId(paneIdFile);
}

export async function toggleBrowser(cwd: string): Promise<void> {
  const sourcePaneId = await getCurrentPaneId();
  const paneIdFile = getPaneIdFile(sourcePaneId);
  const paneId = readPaneId(paneIdFile);
  if (paneId && (await paneExists(paneId))) {
    await closeBrowser();
  } else {
    clearPaneId(paneIdFile);
    await spawnBrowser(cwd);
  }
}
