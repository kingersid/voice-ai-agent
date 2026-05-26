// ─── Obsidian REST API Client ──────────────────────────────────────────────
// Wraps the Obsidian Local REST API plugin's endpoints so the voice agent can
// read, write, and search the real vault.
//
// The plugin runs inside Obsidian and exposes:
//   HTTP:  http://127.0.0.1:27123/   (requires "Enable HTTP server" in settings)
//   HTTPS: https://127.0.0.1:27124/  (self-signed cert)
//
// We proxy through Vite (/api/obsidian/) so the browser never deals with certs.
//
// API docs: https://github.com/coddingtonbear/obsidian-local-rest-api
// ───────────────────────────────────────────────────────────────────────────

const OBSIDIAN_API_BASE = "/api/obsidian";

function getApiKey(): string {
  const key = import.meta.env.VITE_OBSIDIAN_API_KEY as string | undefined;
  if (!key) return "";
  return key;
}

function authHeaders(): Record<string, string> {
  const key = getApiKey();
  if (!key) return {};
  return { Authorization: `Bearer ${key}` };
}

// ── Generic helpers ────────────────────────────────────────────────────────

async function apiGet(path: string): Promise<Response> {
  return fetch(`${OBSIDIAN_API_BASE}${path}`, {
    headers: { ...authHeaders() },
  });
}

async function apiPut(path: string, body: string, contentType = "text/markdown"): Promise<Response> {
  return fetch(`${OBSIDIAN_API_BASE}${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      ...authHeaders(),
    },
    body,
  });
}

async function apiPost(path: string, body?: unknown, contentType?: string): Promise<Response> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (body !== undefined) {
    headers["Content-Type"] = contentType ?? "application/json";
  }
  return fetch(`${OBSIDIAN_API_BASE}${path}`, {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function apiDelete(path: string): Promise<Response> {
  return fetch(`${OBSIDIAN_API_BASE}${path}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
}

async function apiPatch(
  path: string,
  body: string,
  operation: "append" | "prepend" | "replace",
  targetType: "heading" | "block" | "frontmatter",
  target: string,
): Promise<Response> {
  return fetch(`${OBSIDIAN_API_BASE}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "text/plain",
      Operation: operation,
      "Target-Type": targetType,
      Target: target,
      ...authHeaders(),
    },
    body,
  });
}

// ── Error helpers ───────────────────────────────────────────────────────────

function obsidianError(msg: string): { ok: false; error: string } {
  return { ok: false as const, error: msg };
}

// ── Status ──────────────────────────────────────────────────────────────────

export async function checkObsidianStatus(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiGet("/");
    if (!res.ok) return obsidianError(`Obsidian API returned ${res.status}`);
    return { ok: true };
  } catch (err) {
    return obsidianError(
      `Cannot reach Obsidian. Is it running with the Local REST API plugin enabled? (${err instanceof Error ? err.message : "Unknown error"})`,
    );
  }
}

// ── Vault: List directory ──────────────────────────────────────────────────

export interface ObsidianFileEntry {
  name: string;
  type: "file" | "folder";
}

export async function listVault(path = ""): Promise<
  { ok: true; files: ObsidianFileEntry[] } | { ok: false; error: string }
> {
  try {
    const qs = path ? `?path=${encodeURIComponent(path)}` : "";
    const res = await apiGet(`/vault/${qs}`);
    if (!res.ok) {
      const text = await res.text();
      return obsidianError(`List failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    // The API returns an object with file/folder keys or an array
    const files: ObsidianFileEntry[] = [];
    if (Array.isArray(data)) {
      for (const item of data) {
        files.push({ name: item.name ?? item, type: item.type ?? "file" });
      }
    } else if (data.files) {
      for (const item of data.files) {
        files.push({ name: item.name ?? item, type: item.type ?? "file" });
      }
    }
    return { ok: true, files };
  } catch (err) {
    return obsidianError(
      `List vault failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

// ── Vault: Read file ───────────────────────────────────────────────────────

export async function readVaultFile(path: string): Promise<
  | { ok: true; content: string; filename: string }
  | { ok: false; error: string }
> {
  try {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const res = await apiGet(`/vault/${encodedPath}`);
    if (!res.ok) {
      if (res.status === 404) return obsidianError(`Note not found: ${path}`);
      const text = await res.text();
      return obsidianError(`Read failed (${res.status}): ${text}`);
    }
    const content = await res.text();
    return { ok: true, content, filename: path };
  } catch (err) {
    return obsidianError(
      `Read failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

// ── Vault: Write file ──────────────────────────────────────────────────────

export async function writeVaultFile(
  path: string,
  content: string,
): Promise<
  | { ok: true; path: string; chars: number }
  | { ok: false; error: string }
> {
  try {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const res = await apiPut(`/vault/${encodedPath}`, content);
    if (!res.ok) {
      const text = await res.text();
      return obsidianError(`Write failed (${res.status}): ${text}`);
    }
    return { ok: true, path, chars: content.length };
  } catch (err) {
    return obsidianError(
      `Write failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

// ── Vault: Append to file ──────────────────────────────────────────────────

export async function appendVaultFile(
  path: string,
  content: string,
): Promise<
  | { ok: true; path: string }
  | { ok: false; error: string }
> {
  try {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    // POST append expects raw text body — NOT JSON.stringify'd
    const res = await fetch(`${OBSIDIAN_API_BASE}/vault/${encodedPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        ...authHeaders(),
      },
      body: content,
    });
    if (!res.ok) {
      const errText = await res.text();
      return obsidianError(`Append failed (${res.status}): ${errText}`);
    }
    return { ok: true, path };
  } catch (err) {
    return obsidianError(
      `Append failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

// ── Vault: Delete file ─────────────────────────────────────────────────────

export async function deleteVaultFile(path: string): Promise<
  | { ok: true }
  | { ok: false; error: string }
> {
  try {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const res = await apiDelete(`/vault/${encodedPath}`);
    if (!res.ok) {
      const text = await res.text();
      return obsidianError(`Delete failed (${res.status}): ${text}`);
    }
    return { ok: true };
  } catch (err) {
    return obsidianError(
      `Delete failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

// ── Vault: Patch specific section ──────────────────────────────────────────

export async function patchVaultSection(
  path: string,
  content: string,
  operation: "append" | "prepend" | "replace",
  targetType: "heading" | "block" | "frontmatter",
  target: string,
): Promise<
  | { ok: true }
  | { ok: false; error: string }
> {
  try {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const res = await apiPatch(`/vault/${encodedPath}`, content, operation, targetType, target);
    if (!res.ok) {
      const text = await res.text();
      return obsidianError(`Patch failed (${res.status}): ${text}`);
    }
    return { ok: true };
  } catch (err) {
    return obsidianError(
      `Patch failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

// ── Vault: List files in a directory ───────────────────────────────────────

export async function listVaultDirectory(
  dirPath = "",
): Promise<
  | { ok: true; files: ObsidianFileEntry[] }
  | { ok: false; error: string }
> {
  return listVault(dirPath);
}

// ── Active File ────────────────────────────────────────────────────────────

export async function getActiveFilePath(): Promise<
  | { ok: true; path: string }
  | { ok: false; error: string }
> {
  try {
    const res = await apiGet("/active/");
    if (!res.ok) {
      const text = await res.text();
      return obsidianError(`Get active file failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    return { ok: true, path: data.path ?? "" };
  } catch (err) {
    return obsidianError(
      `Get active file failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

// ── Periodic Notes ─────────────────────────────────────────────────────────

export type PeriodicPeriod = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

export async function getPeriodicNotePath(
  period: PeriodicPeriod,
): Promise<
  | { ok: true; path: string }
  | { ok: false; error: string }
> {
  try {
    const res = await apiGet(`/periodic/${period}/`);
    if (!res.ok) {
      const text = await res.text();
      return obsidianError(`Get ${period} note failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    return { ok: true, path: data.path ?? "" };
  } catch (err) {
    return obsidianError(
      `Get ${period} note failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

// ── Search ─────────────────────────────────────────────────────────────────

export interface SearchResult {
  path: string;
  score?: number;
  match?: string;
}

export async function simpleSearch(
  query: string,
): Promise<
  | { ok: true; results: SearchResult[] }
  | { ok: false; error: string }
> {
  try {
    const res = await apiPost(`/search/simple/?query=${encodeURIComponent(query)}`);
    if (!res.ok) {
      const text = await res.text();
      return obsidianError(`Search failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    const results: SearchResult[] = [];
    if (Array.isArray(data)) {
      for (const item of data) {
        results.push({
          path: item.path ?? item.filename ?? "",
          score: item.score,
          match: item.match ?? item.content ?? "",
        });
      }
    }
    return { ok: true, results };
  } catch (err) {
    return obsidianError(
      `Search failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

// ── Tags ───────────────────────────────────────────────────────────────────

export interface TagEntry {
  tag: string;
  count: number;
}

export async function listTags(): Promise<
  | { ok: true; tags: TagEntry[] }
  | { ok: false; error: string }
> {
  try {
    const res = await apiGet("/tags/");
    if (!res.ok) {
      const text = await res.text();
      return obsidianError(`List tags failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    const tags: TagEntry[] = [];
    if (Array.isArray(data)) {
      for (const item of data) {
        tags.push({ tag: item.tag ?? "", count: item.count ?? 0 });
      }
    }
    return { ok: true, tags };
  } catch (err) {
    return obsidianError(
      `List tags failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

// ── Commands ───────────────────────────────────────────────────────────────

export interface CommandEntry {
  id: string;
  name: string;
}

export async function listCommands(): Promise<
  | { ok: true; commands: CommandEntry[] }
  | { ok: false; error: string }
> {
  try {
    const res = await apiGet("/commands/");
    if (!res.ok) {
      const text = await res.text();
      return obsidianError(`List commands failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    const commands: CommandEntry[] = [];
    if (Array.isArray(data)) {
      for (const item of data) {
        commands.push({ id: item.id ?? "", name: item.name ?? "" });
      }
    }
    return { ok: true, commands };
  } catch (err) {
    return obsidianError(
      `List commands failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

export async function executeCommand(
  commandId: string,
): Promise<
  | { ok: true }
  | { ok: false; error: string }
> {
  try {
    const encodedId = encodeURIComponent(commandId);
    const res = await apiPost(`/commands/${encodedId}/`);
    if (!res.ok) {
      const text = await res.text();
      return obsidianError(`Execute command failed (${res.status}): ${text}`);
    }
    return { ok: true };
  } catch (err) {
    return obsidianError(
      `Execute command failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

// ── Open File ──────────────────────────────────────────────────────────────

export async function openFileInObsidian(
  path: string,
): Promise<
  | { ok: true }
  | { ok: false; error: string }
> {
  try {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const res = await apiPost(`/open/${encodedPath}/`);
    if (!res.ok) {
      const text = await res.text();
      return obsidianError(`Open file failed (${res.status}): ${text}`);
    }
    return { ok: true };
  } catch (err) {
    return obsidianError(
      `Open file failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

// ── Check if Obsidian API is properly configured ──────────────────────────

export function isObsidianConfigured(): boolean {
  return !!getApiKey();
}
