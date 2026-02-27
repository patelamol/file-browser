import { readdirSync, readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, relative, dirname } from "path";

export type GitStatus = "M" | "A" | "D" | "?" | "R";

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
  gitStatus?: GitStatus;
}

export interface WalkOptions {
  maxDepth?: number;
  maxEntries?: number;
  ignorePatterns?: string[];
}

const DEFAULT_IGNORE = [".git", "node_modules", ".DS_Store", "__pycache__", ".claude"];

function parseGitignore(rootPath: string): string[] {
  const gitignorePath = join(rootPath, ".gitignore");
  if (!existsSync(gitignorePath)) return [];

  try {
    const content = readFileSync(gitignorePath, "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function shouldIgnore(
  name: string,
  relPath: string,
  isDir: boolean,
  ignorePatterns: string[],
  gitignoreGlobs: Bun.Glob[]
): boolean {
  if (ignorePatterns.includes(name)) return true;

  const testPath = isDir ? relPath + "/" : relPath;
  for (const glob of gitignoreGlobs) {
    if (glob.match(testPath) || glob.match(name) || (isDir && glob.match(name + "/"))) {
      return true;
    }
  }

  return false;
}

export function walkTree(rootPath: string, options: WalkOptions = {}): TreeNode[] {
  const { maxDepth = 4, maxEntries = 200, ignorePatterns = DEFAULT_IGNORE } = options;

  const gitignorePatterns = parseGitignore(rootPath);
  const gitignoreGlobs = gitignorePatterns.map((p) => new Bun.Glob(p));

  let entryCount = 0;

  function walk(dirPath: string, depth: number): TreeNode[] {
    if (depth > maxDepth || entryCount >= maxEntries) return [];

    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      const aIsDir = a.isDirectory();
      const bIsDir = b.isDirectory();
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const nodes: TreeNode[] = [];

    for (const entry of entries) {
      if (entryCount >= maxEntries) break;

      const fullPath = join(dirPath, entry.name);
      const relPath = relative(rootPath, fullPath);
      const isDir = entry.isDirectory();

      if (shouldIgnore(entry.name, relPath, isDir, ignorePatterns, gitignoreGlobs)) {
        continue;
      }

      entryCount++;

      const node: TreeNode = {
        name: entry.name,
        path: fullPath,
        isDir,
      };

      if (isDir) {
        node.children = walk(fullPath, depth + 1);
      }

      nodes.push(node);
    }

    return nodes;
  }

  return walk(rootPath, 0);
}

export interface GitFileEntry {
  relPath: string;
  status: GitStatus;
}

export function getGitChanges(rootPath: string): GitFileEntry[] {
  try {
    // Use -u to expand untracked directories into individual files
    const output = execSync("git status --porcelain -u", {
      cwd: rootPath,
      encoding: "utf-8",
      timeout: 5000,
    });
    return output
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const xy = line.substring(0, 2);
        let filePath = line.substring(3).trim();
        // Remove trailing slash from directories
        if (filePath.endsWith("/")) filePath = filePath.slice(0, -1);
        let status: GitStatus;
        if (xy.includes("?")) status = "?";
        else if (xy.includes("D")) status = "D";
        else if (xy.includes("R")) status = "R";
        else if (xy.includes("A")) status = "A";
        else status = "M";
        return { relPath: filePath, status };
      });
  } catch {
    return [];
  }
}

export function buildGitTree(rootPath: string): TreeNode[] {
  const changes = getGitChanges(rootPath);
  if (changes.length === 0) return [];

  // Group files by directory segments
  interface DirBucket {
    files: { name: string; relPath: string; status: GitStatus }[];
    subdirs: Map<string, DirBucket>;
  }

  const root: DirBucket = { files: [], subdirs: new Map() };

  const ignoreSet = new Set(DEFAULT_IGNORE);

  for (const { relPath, status } of changes) {
    // Skip files under default-ignored directories
    const topDir = relPath.split("/")[0];
    if (ignoreSet.has(topDir)) continue;

    const parts = relPath.split("/");
    let bucket = root;

    for (let i = 0; i < parts.length - 1; i++) {
      if (!bucket.subdirs.has(parts[i])) {
        bucket.subdirs.set(parts[i], { files: [], subdirs: new Map() });
      }
      bucket = bucket.subdirs.get(parts[i])!;
    }

    bucket.files.push({ name: parts[parts.length - 1], relPath, status });
  }

  function bucketToNodes(bucket: DirBucket, parentPath: string): TreeNode[] {
    const nodes: TreeNode[] = [];

    for (const [dirName, subBucket] of bucket.subdirs) {
      const dirFullPath = parentPath ? parentPath + "/" + dirName : dirName;
      nodes.push({
        name: dirName,
        path: join(rootPath, dirFullPath),
        isDir: true,
        children: bucketToNodes(subBucket, dirFullPath),
      });
    }

    for (const file of bucket.files) {
      nodes.push({
        name: file.name,
        path: join(rootPath, file.relPath),
        isDir: false,
        gitStatus: file.status,
      });
    }

    // Sort: directories first, then alphabetical
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return nodes;
  }

  return bucketToNodes(root, "");
}
