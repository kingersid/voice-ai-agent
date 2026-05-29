// ─── Vault Git Server ─────────────────────────────────────────────────────
// Express server that saves notes to a GitHub repo (which syncs to Obsidian).
// Run alongside the Vite dev server.
//
// API:
//   POST /api/vault/save  { filename, content }
//     → writes file to repo, commits, and pushes to GitHub
//
// Config (via .env):
//   VAULT_GIT_URL  - e.g. https://github.com/kingersid/obsidian-vault.git
//   VAULT_GIT_TOKEN - GitHub personal access token with repo scope
//   VAULT_GIT_USER_NAME - commit author name (optional)
//   VAULT_GIT_USER_EMAIL - commit author email (optional)
//   VAULT_WORK_DIR - where to clone the repo locally (default: ./vault-repo)
// ───────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import express from "express";
import { simpleGit } from "simple-git";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// ─── Config ────────────────────────────────────────────────────────────────

const GIT_URL = process.env.VAULT_GIT_URL;
// Use GITHUB_TOKEN if set, otherwise fall back to VAULT_GIT_TOKEN
const GIT_TOKEN = process.env.GITHUB_TOKEN || process.env.VAULT_GIT_TOKEN;
const GIT_USER_NAME = process.env.VAULT_GIT_USER_NAME || "Sid (Aura Voice Agent)";
const GIT_USER_EMAIL = process.env.VAULT_GIT_USER_EMAIL || "kingersid@users.noreply.github.com";
const WORK_DIR = path.resolve(process.env.VAULT_WORK_DIR || path.join(__dirname, "..", "vault-repo"));

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildRepoUrl() {
  if (!GIT_URL || !GIT_TOKEN) return null;
  return GIT_URL.replace("https://", `https://${GIT_TOKEN}@`);
}

async function ensureRepo() {
  if (!GIT_URL || !GIT_TOKEN) {
    throw new Error("VAULT_GIT_URL and GITHUB_TOKEN must be set in .env");
  }

  const authUrl = buildRepoUrl();

  if (fs.existsSync(path.join(WORK_DIR, ".git"))) {
    const git = simpleGit(WORK_DIR);
    try {
      await git.pull();
    } catch {
      // Pull might fail if local is ahead; that's fine
    }
    return git;
  }

  // Clone fresh
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const git = simpleGit();
  await git.clone(authUrl, WORK_DIR);
  return simpleGit(WORK_DIR);
}

// ─── POST /api/vault/save ─────────────────────────────────────────────────

app.post("/api/vault/save", async (req, res) => {
  const { filename, content } = req.body;
  if (!filename || !content) {
    return res.status(400).json({ error: "Both 'filename' and 'content' are required." });
  }

  try {
    const git = await ensureRepo();

    // If filename has a directory prefix (like wiki/), use it as-is
    // Otherwise, save to daily/ (the user's preferred default)
    let relativePath = filename;
    if (!relativePath.includes("/") && !relativePath.includes("\\")) {
      relativePath = `daily/${relativePath}`;
    }

    const filePath = path.join(WORK_DIR, relativePath);

    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Write the file
    fs.writeFileSync(filePath, content, "utf-8");

    // Stage, commit, push
    await git.add(relativePath);
    const commitMsg = `Aura: saved ${relativePath}`;
    await git.commit(commitMsg, [], {
      "--author": `"${GIT_USER_NAME} <${GIT_USER_EMAIL}>"`,
    });

    // Update remote to include token for this push
    const authUrl = buildRepoUrl();
    await git.remote(["set-url", "origin", authUrl]);
    await git.push();

    console.log(`[vault] Saved & pushed: ${relativePath} (${content.length} chars)`);

    return res.json({
      success: true,
      path: relativePath,
      chars: content.length,
      message: `Note saved to repo: ${relativePath}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[vault] Save error:", msg);
    return res.status(500).json({ error: msg });
  }
});

// ─── GET /api/vault/status ────────────────────────────────────────────────

app.get("/api/vault/status", (_req, res) => {
  if (!GIT_URL) {
    return res.json({ configured: false, reason: "VAULT_GIT_URL not set" });
  }
  if (!GIT_TOKEN) {
    return res.json({ configured: false, reason: "VAULT_GIT_TOKEN not set" });
  }
  const exists = fs.existsSync(path.join(WORK_DIR, ".git"));
  return res.json({
    configured: true,
    cloned: exists,
    repo: GIT_URL,
    workDir: WORK_DIR,
  });
});
// ─── Code Execution: Write File ──────────────────────────────────────────
// POST /api/exec/write-file
// Body: { path: string, content: string }
// Writes content to a file relative to the project working directory.

app.post("/api/exec/write-file", (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath || content === undefined || content === null) {
    return res.status(400).json({ error: "Both 'path' and 'content' are required." });
  }

  // Sanitize: prevent path traversal outside the project directory
  const fullPath = path.resolve(process.cwd(), path.normalize(filePath));
  const projectRoot = path.resolve(process.cwd());

  if (!fullPath.startsWith(projectRoot)) {
    return res.status(403).json({ error: "Path traversal denied. File must be within the project directory." });
  }

  try {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
    console.log(`[exec] Written ${content.length} chars to ${fullPath}`);
    return res.json({
      success: true,
      path: path.relative(projectRoot, fullPath),
      chars: content.length,
      message: `File written: ${path.relative(projectRoot, fullPath)}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[exec] Write error:", msg);
    return res.status(500).json({ error: msg });
  }
});

// ─── Code Execution: Run Command ───────────────────────────────────────────
// POST /api/exec/run-command
// Body: { command: string, timeout?: number }
// Executes a shell command in the project working directory.
// ⚠️ SECURITY: Only intended for personal/development use.

app.post("/api/exec/run-command", async (req, res) => {
  const { command, timeout } = req.body;
  if (!command || typeof command !== "string") {
    return res.status(400).json({ error: "A 'command' string is required." });
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const child = exec(
        command,
        {
          cwd: process.cwd(),
          timeout: timeout ?? 15000,
          maxBuffer: 1024 * 1024, // 1MB output buffer
        },
        (error, stdout, stderr) => {
          resolve({ code: error?.code ?? 0, stdout, stderr, error: error?.message ?? null });
        }
      );
    });

    console.log(`[exec] Ran: ${command} (exit code: ${result.code})`);
    return res.json({
      success: result.code === 0,
      exitCode: result.code,
      stdout: result.stdout.slice(0, 5000),  // cap at 5KB
      stderr: result.stderr.slice(0, 2000),
      message: result.error
        ? `Command failed: ${result.error}`
        : `Command completed with exit code ${result.code}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[exec] Command error:", msg);
    return res.status(500).json({ error: msg });
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────

app.get("/api/vault/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ─── Start ────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.VAULT_SERVER_PORT || "3001", 10);

console.log("[vault] DEBUG: VAULT_GIT_URL =", process.env.VAULT_GIT_URL || "(not set)");
console.log("[vault] DEBUG: GITHUB_TOKEN =", process.env.GITHUB_TOKEN ? "(set, " + process.env.GITHUB_TOKEN.length + " chars)" : "(not set)");
console.log("[vault] DEBUG: CWD =", process.cwd());

app.listen(PORT, () => {
  console.log(`[vault] Server running on http://localhost:${PORT}`);
  if (!GIT_URL) console.log("[vault] ⚠️  VAULT_GIT_URL not set — save will fail until configured");    if (!GIT_TOKEN) console.log("[vault] ⚠️  GITHUB_TOKEN not set — save will fail until configured");
  if (GIT_URL && GIT_TOKEN) console.log(`[vault] ✅ Repo: ${GIT_URL}`);
});
