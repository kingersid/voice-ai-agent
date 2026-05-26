// ─── MCP Server ────────────────────────────────────────────────────────────
// In-browser MCP server that implements the Model Context Protocol.
// Provides vault tools (get_time, read_note, search_vault, web_search, save_note)
// and vault resources (notes exposed as resources list/read).

import {
  type JSONRPCRequest,
  type JSONRPCResponse,
  type JSONRPCMessage,
  type JSONRPCNotification,
  type InitializeResult,
  type Tool,
  type ToolCallResult,
  type Resource,
  type ResourceContents,
  type ServerCapabilities,
  MCPErrorCodes,
  createResponse,
  createErrorResponse,
} from "./mcp-types";
import type { InMemoryTransport } from "./mcp-transport";
import * as obsidian from "./obsidian-client";

// ─── Tavily Rate Limiter ─────────────────────────────────────────────────────
// Tavily free tier typically allows ~1 request/sec burst and ~1000 req/month.
// This ensures we never exceed a safe per-second threshold.

let TAVILY_MIN_INTERVAL_MS = 3_000; // at least 3s between searches
const TAVILY_MAX_QUEUE = 5;            // drop excess if queue piles up

let _tavilyLastSearch = 0;
let _tavilyQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
let _tavilyProcessing = false;

/**
 * Override the rate-limiter interval (e.g. set to 0 in tests).
 * Pass -1 to reset to the default (3s).
 */
export function setTavilyRateLimit(ms: number): void {
  TAVILY_MIN_INTERVAL_MS = ms < 0 ? 3_000 : ms;
}

function processTavilyQueue(): void {
  if (_tavilyProcessing || _tavilyQueue.length === 0) return;
  _tavilyProcessing = true;

  const now = Date.now();
  const elapsed = now - _tavilyLastSearch;
  const delay = Math.max(0, TAVILY_MIN_INTERVAL_MS - elapsed);

  if (delay > 0) {
    setTimeout(() => {
      _tavilyLastSearch = Date.now();
      const item = _tavilyQueue.shift();
      if (item) item.resolve();
      _tavilyProcessing = false;
      processTavilyQueue();
    }, delay);
  } else {
    _tavilyLastSearch = now;
    const item = _tavilyQueue.shift();
    if (item) item.resolve();
    _tavilyProcessing = false;
    processTavilyQueue();
  }
}

/** Wait for the green light to call the Tavily API (rate-limited queue). */
function acquireTavilySlot(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (_tavilyQueue.length >= TAVILY_MAX_QUEUE) {
      // Queue is full — reject the oldest pending item to make room
      const oldest = _tavilyQueue.shift();
      if (oldest) oldest.reject(new Error("Web search queue full. Try again in a moment."));
    }

    _tavilyQueue.push({ resolve, reject });

    if (!_tavilyProcessing) {
      processTavilyQueue();
    }
  });
}

// ─── Vault Data ────────────────────────────────────────────────────────────

export interface VaultEntry {
  filename: string;
  content: string;
  mimeType?: string;
}

const DEFAULT_VAULT: VaultEntry[] = [
  {
    filename: "wiki/sid-profile.md",
    content: `# Sid Profile
- Co-founder, Label Ethnic Vogue (Surat)
- Teacher at PP Savani University (Network Essentials IDCE2040)
- VPS: 103.194.228.56 (Ubuntu 24.04), Hermes Agent running
- Enjoys walking after dinner. Walks a lot when talking.`,
    mimeType: "text/markdown",
  },
  {
    filename: "wiki/personal-goals-aspirations.md",
    content: `# Personal Goals
- North Star: 2,000 Instagram followers by end of 2026 (currently ~500)
- Content series: "Life with AI Agents"
- Long-term: Launch AI deployment agency
- Skills to build: video production, AI agent dev, public speaking`,
    mimeType: "text/markdown",
  },
  {
    filename: "wiki/my-investments.md",
    content: `# My Investments
- IGIL: ₹1,00,000 invested
- Bear case: CMP ₹362, target ₹240, stress ₹180
- Rating: SELL/AVOID per own research
- Action: Monitor for ₹220-260 entry`,
    mimeType: "text/markdown",
  },
  {
    filename: "wiki/meditation-sessions.md",
    content: `# Meditation
- Weekly Thursday 9PM-9:30PM on Google Meet
- Teacher: Archana Didi
- Regular practice, important to Sid`,
    mimeType: "text/markdown",
  },
  {
    filename: "daily/routine.md",
    content: `# Daily Routine
- Likes walking after dinner
- Walks a lot when engaged in conversation`,
    mimeType: "text/markdown",
  },
  {
    filename: "wiki/professional-growth-plan.md",
    content: `# Professional Growth
1. Scale labelethnicvogue.shop
2. Monetize teaching (online courses, eBooks)
3. AI & tech integration into business
4. Build network, industry influence
5. Personal brand authority in ethnic fashion + AI`,
    mimeType: "text/markdown",
  },
  {
    filename: "output/2026-05-24 - Drinks with the Boys.md",
    content: `# Drinks with the Boys
Date: 24 May 2026
Plan: Drinks in Patiala
Shortlist: The Brew Estate, Hotel Eqbal Inn, Garden Resort DJ night
Preferred vibe: Loud party, music, DJ`,
    mimeType: "text/markdown",
  },
];

// ─── Tool Definitions ──────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "get_time",
    title: "Current Date and Time",
    description: "Get the current date and time (IST timezone). Call this when the user asks for the time, date, day of the week, or today's date.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "read_note",
    title: "Read Vault Note",
    description: "Read a note from your Obsidian vault by its filename. Reads from the real Obsidian vault when Obsidian is running with the Local REST API plugin enabled. Falls back to cached notes if Obsidian is unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "The filename of the note to read, e.g. 'wiki/my-investments.md'",
        },
      },
      required: ["filename"],
    },
  },
  {
    name: "search_vault",
    title: "Search Vault Notes",
    description: "Search through all notes in your Obsidian vault (filenames and content) for a given query. Uses Obsidian's built-in search when available. Falls back to cached notes if Obsidian is unavailable. Returns up to 3 matching notes with content previews.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to find in the vault",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_search",
    title: "Search the Web",
    description: "Search the web using Tavily for current information on any topic. Call this for questions about places, travel, geography, history, culture, news, weather, current events, or ANY factual topic where external knowledge is needed.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The web search query",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "save_note",
    title: "Save Vault Note",
    description: "Save or update a note in your Obsidian vault. Creates a new note or overwrites an existing one. Writes directly to the real Obsidian vault when Obsidian is running with the Local REST API plugin enabled.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "The filename for the note (e.g., 'wiki/ideas.md')",
        },
        content: {
          type: "string",
          description: "The markdown content of the note",
        },
      },
      required: ["filename", "content"],
    },
  },
  {
    name: "write_file",
    title: "Write File to Disk",
    description: "Write HTML, text, or any content to a file on the server's working directory. Creates parent directories automatically. Use this to save generated HTML pages, CSS, JS, or any other files.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The relative file path (e.g., 'output/demo.html', 'index.html')",
        },
        content: {
          type: "string",
          description: "The file content to write (HTML, text, code, etc.)",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "execute_command",
    title: "Execute Terminal Command",
    description: "Run a shell command on the server (e.g., 'mkdir -p output', 'ls -la', 'echo hello'). Useful for creating directories, listing files, or running simple terminal operations.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        timeout: {
          type: "number",
          description: "Optional timeout in milliseconds (default: 15000)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "list_vault",
    title: "List Vault Files",
    description: "List files and folders in your Obsidian vault at a given path. Use this to browse the vault structure and discover what notes are available.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional subdirectory path to list (e.g., 'wiki/', 'daily/'). Leave empty or omit to list the vault root.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_active_file",
    title: "Get Active Obsidian File",
    description: "Get the path and content of the currently active (open) file in Obsidian. Useful for understanding what the user is currently working on.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_daily_note",
    title: "Get Today's Daily Note",
    description: "Get today's daily note from the Obsidian vault. Requires the Periodic Notes plugin or similar daily note setup in Obsidian.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// ─── MCP Server ────────────────────────────────────────────────────────────

export class MCPServer {
  private transport: InMemoryTransport;
  private vault: Map<string, VaultEntry>;
  private initialized = false;

  constructor(transport: InMemoryTransport, vault?: VaultEntry[]) {
    this.transport = transport;
    this.vault = new Map(
      (vault ?? DEFAULT_VAULT).map((e) => [e.filename, e])
    );
    this.transport.onMessage((msg) => this.handleMessage(msg));
  }

  // ── Public API for hosts to interact with the server directly ──────────

  getTools(): Tool[] {
    return TOOLS;
  }

  getResources(): Resource[] {
    return Array.from(this.vault.entries()).map(
      ([filename, entry]): Resource => ({
        uri: `vault:///${filename}`,
        name: filename,
        title: filename.replace(/\.md$/, "").split("/").pop() ?? filename,
        description: `Vault note: ${filename}`,
        mimeType: entry.mimeType ?? "text/markdown",
        size: entry.content.length,
      })
    );
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    switch (name) {
      case "get_time":
        return this.handleGetTime();
      case "read_note":
        return await this.handleReadNote(args);
      case "search_vault":
        return await this.handleSearchVault(args);
      case "web_search":
        return await this.handleWebSearch(args);
      case "save_note":
        return await this.handleSaveNote(args);
      case "write_file":
        return await this.handleWriteFile(args);
      case "execute_command":
        return await this.handleExecuteCommand(args);
      case "list_vault":
        return await this.handleListVault(args);
      case "get_active_file":
        return await this.handleGetActiveFile();
      case "get_daily_note":
        return await this.handleGetDailyNote();
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  }

  readResource(uri: string): ResourceContents | null {
    // Parse vault:///filename.md URIs
    const prefix = "vault:///";
    if (!uri.startsWith(prefix)) return null;
    const filename = uri.slice(prefix.length);
    const entry = this.vault.get(filename);
    if (!entry) return null;
    return {
      uri,
      mimeType: entry.mimeType ?? "text/markdown",
      text: entry.content,
    };
  }

  // ── Internal: JSON-RPC message handling ────────────────────────────────

  private async handleMessage(msg: JSONRPCMessage) {
    // Ignore responses (we don't send requests to the client)
    if ("result" in msg || "error" in msg) return;
    // Notifications don't have an id — ignore them
    if (!("id" in msg) || msg.id === undefined || msg.id === null) return;

    const req = msg as JSONRPCRequest;

    switch (req.method) {
      case "initialize":
        this.handleInitialize(req);
        break;
      case "tools/list":
        this.handleToolsList(req);
        break;
      case "tools/call":
        await this.handleToolsCall(req);
        break;
      case "resources/list":
        this.handleResourcesList(req);
        break;
      case "resources/read":
        this.handleResourcesRead(req);
        break;
      default:
        this.send(
          createErrorResponse(req.id, MCPErrorCodes.MethodNotFound, `Method not found: ${req.method}`)
        );
    }
  }

  private send(msg: JSONRPCResponse | JSONRPCNotification) {
    this.transport.send(msg);
  }

  // ── Initialize ──────────────────────────────────────────────────────────

  private handleInitialize(req: JSONRPCRequest) {
    const params = req.params as { protocolVersion?: string } | undefined;
    const clientVersion = params?.protocolVersion ?? "2025-11-25";

    const result: InitializeResult = {
      protocolVersion: clientVersion,
      capabilities: this.getServerCapabilities(),
      serverInfo: {
        name: "sid-vault-mcp",
        version: "1.0.0",
      },
      instructions:
        "MCP server for My Vault. Provides tools to read notes, search notes, " +
        "get the current time, and save new notes. All tools are executed automatically by the client.",
    };

    this.send(createResponse(req.id, result as unknown as Record<string, unknown>));
    this.initialized = true;
  }

  private getServerCapabilities(): ServerCapabilities {
    return {
      tools: { listChanged: false },
      resources: { listChanged: false },
    };
  }

  // ── Tools: List ─────────────────────────────────────────────────────────

  private handleToolsList(req: JSONRPCRequest) {
    if (!this.initialized) {
      this.send(createErrorResponse(req.id, MCPErrorCodes.InvalidRequest, "Server not initialized"));
      return;
    }
    this.send(createResponse(req.id, { tools: TOOLS }));
  }

  // ── Tools: Call ─────────────────────────────────────────────────────────

  private async handleToolsCall(req: JSONRPCRequest) {
    if (!this.initialized) {
      this.send(createErrorResponse(req.id, MCPErrorCodes.InvalidRequest, "Server not initialized"));
      return;
    }

    const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    if (!params?.name) {
      this.send(createErrorResponse(req.id, MCPErrorCodes.InvalidParams, "Missing tool name"));
      return;
    }

    const result = await this.callTool(params.name, params.arguments ?? {});
    this.send(createResponse(req.id, result as unknown as Record<string, unknown>));
  }

  // ── Resources: List ─────────────────────────────────────────────────────

  private handleResourcesList(req: JSONRPCRequest) {
    if (!this.initialized) {
      this.send(createErrorResponse(req.id, MCPErrorCodes.InvalidRequest, "Server not initialized"));
      return;
    }
    this.send(createResponse(req.id, { resources: this.getResources() }));
  }

  // ── Resources: Read ─────────────────────────────────────────────────────

  private handleResourcesRead(req: JSONRPCRequest) {
    if (!this.initialized) {
      this.send(createErrorResponse(req.id, MCPErrorCodes.InvalidRequest, "Server not initialized"));
      return;
    }

    const params = req.params as { uri?: string } | undefined;
    if (!params?.uri) {
      this.send(createErrorResponse(req.id, MCPErrorCodes.InvalidParams, "Missing resource URI"));
      return;
    }

    const content = this.readResource(params.uri);
    if (!content) {
      this.send(
        createErrorResponse(req.id, MCPErrorCodes.ResourceNotFound, `Resource not found: ${params.uri}`)
      );
      return;
    }

    this.send(createResponse(req.id, { contents: [content] }));
  }

  // ── Tool Implementations ────────────────────────────────────────────────

  private handleGetTime(): ToolCallResult {
    const now = new Date();
    const formatted = `${now.toLocaleDateString("en", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    })} at ${now.toLocaleTimeString("en", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    })} (IST)`;

    return {
      content: [{ type: "text", text: formatted }],
    };
  }

  private async handleReadNote(args: Record<string, unknown>): Promise<ToolCallResult> {
    const filename = String(args.filename ?? "");

    // Try reading from the real Obsidian vault first
    if (obsidian.isObsidianConfigured()) {
      const result = await obsidian.readVaultFile(filename);
      if (result.ok) {
        return {
          content: [{ type: "text", text: `[${result.filename}]\n${result.content}` }],
        };
      }
      // If not found in Obsidian, fall through to in-memory vault
    }

    // Fall back to in-memory vault
    const entry = this.vault.get(filename);
    if (!entry) {
      return {
        content: [
          {
            type: "text",
            text: `Note not found in Obsidian or cache: ${filename}. Available notes: ${Array.from(this.vault.keys()).join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: `[${filename}] (cached)\n${entry.content}` }],
    };
  }

  private async handleSearchVault(args: Record<string, unknown>): Promise<ToolCallResult> {
    const query = String(args.query ?? "");

    // Try searching the real Obsidian vault first
    if (obsidian.isObsidianConfigured()) {
      const result = await obsidian.simpleSearch(query);
      if (result.ok && result.results.length > 0) {
        const limited = result.results.slice(0, 3);
        const lines = await Promise.all(
          limited.map(async (r, i) => {
            // Try to fetch a snippet from each result
            const full = await obsidian.readVaultFile(r.path);
            const snippet = full.ok ? full.content.slice(0, 300) : (r.match ?? "");
            return `${i + 1}. [${r.path}]\n   ${snippet}`;
          }),
        );
        return {
          content: [{ type: "text", text: `Search results for "${query}" in Obsidian vault:\n\n${lines.join("\n\n---\n\n")}` }],
        };
      }
    }

    // Fall back to in-memory vault search
    const lowerQuery = query.toLowerCase();
    const matches = Array.from(this.vault.entries())
      .filter(
        ([key, val]) =>
          key.toLowerCase().includes(lowerQuery) ||
          val.content.toLowerCase().includes(lowerQuery)
      )
      .slice(0, 3);

    if (matches.length === 0) {
      return {
        content: [{ type: "text", text: `No results found for "${query}" in vault (Obsidian or cache).` }],
      };
    }

    const results = matches
      .map(
        ([filename, entry]) =>
          `[${filename}]: ${entry.content.slice(0, 300)}`
      )
      .join("\n\n---\n\n");

    return {
      content: [{ type: "text", text: `Search results for "${query}" (from cache):\n\n${results}` }],
    };
  }

  private async handleWebSearch(args: Record<string, unknown>): Promise<ToolCallResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return {
        content: [{ type: "text", text: "No search query provided." }],
        isError: true,
      };
    }

    const apiKey = import.meta.env.VITE_TAVILY_API_KEY;
    if (!apiKey) {
      console.error("[web_search] Missing VITE_TAVILY_API_KEY — set it in .env");
      return {
        content: [{ type: "text", text: "Web search is not configured yet. Add your Tavily API key to the .env file (VITE_TAVILY_API_KEY)." }],
        isError: true,
      };
    }

    try {
      // Wait for a rate-limited slot before hitting the Tavily API
      await acquireTavilySlot();

      const res = await fetch("/api/tavily/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: "basic",
          max_results: 5,
          include_images: false,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[web_search] Tavily error ${res.status}:`, errText);
        return {
          content: [{ type: "text", text: `Web search failed (${res.status}): ${errText}` }],
          isError: true,
        };
      }

      const data = await res.json();

      if (!data.results || data.results.length === 0) {
        return {
          content: [{ type: "text", text: `No search results found for "${query}".` }],
        };
      }

      // Truncate long results to avoid NVIDIA context issues
      const formatted = data.results
        .slice(0, 5)
        .map(
          (r: { title?: string; url?: string; content?: string }, i: number) => {
            const snippet = (r.content ?? "").slice(0, 300);
            return `${i + 1}. ${r.title ?? "Untitled"}\n   URL: ${r.url ?? "N/A"}\n   ${snippet}`;
          }
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Web search results for "${query}":\n\n${formatted}`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[web_search] Failed:", err);
      return {
        content: [{ type: "text", text: `Web search failed: ${msg}` }],
        isError: true,
      };
    }
  }

  private async handleWriteFile(args: Record<string, unknown>): Promise<ToolCallResult> {
    const filePath = String(args.path ?? "").trim();
    const content = String(args.content ?? "").trim();

    if (!filePath || !content) {
      return {
        content: [{ type: "text", text: "Both 'path' and 'content' are required." }],
        isError: true,
      };
    }

    try {
      const res = await fetch("/api/exec/write-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, content }),
      });

      const data = await res.json();
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Write failed: ${data.error ?? res.statusText}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: `✅ Written ${data.chars} chars to ${data.path}` }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[write_file] Error:", err);
      return {
        content: [{ type: "text", text: `Write failed: ${msg}` }],
        isError: true,
      };
    }
  }

  private async handleExecuteCommand(args: Record<string, unknown>): Promise<ToolCallResult> {
    const command = String(args.command ?? "").trim();
    if (!command) {
      return {
        content: [{ type: "text", text: "A 'command' string is required." }],
        isError: true,
      };
    }

    try {
      const res = await fetch("/api/exec/run-command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command,
          timeout: args.timeout ?? 15000,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Command failed: ${data.error ?? res.statusText}` }],
          isError: true,
        };
      }

      let output = `$ ${command}\n`;
      if (data.stdout) {
        output += data.stdout;
      }
      if (data.stderr) {
        output += `\n⚠️ stderr:\n${data.stderr}`;
      }
      output += `\n\n→ Exit code: ${data.exitCode}`;

      return {
        content: [{ type: "text", text: output }],
        isError: !data.success,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[execute_command] Error:", err);
      return {
        content: [{ type: "text", text: `Command execution failed: ${msg}` }],
        isError: true,
      };
    }
  }

  private async handleSaveNote(args: Record<string, unknown>): Promise<ToolCallResult> {
    const filename = String(args.filename ?? "");
    const content = String(args.content ?? "");

    if (!filename || !content) {
      return {
        content: [{ type: "text", text: "Both 'filename' and 'content' are required." }],
        isError: true,
      };
    }

    // Always cache in the in-memory vault
    this.vault.set(filename, {
      filename,
      content,
      mimeType: "text/markdown",
    });

    // Try writing to the real Obsidian vault first
    if (obsidian.isObsidianConfigured()) {
      const result = await obsidian.writeVaultFile(filename, content);
      if (result.ok) {
        console.log("[vault] Saved to Obsidian:", result.path);
        // Also try GitHub backup (best-effort)
        await this.tryGitHubBackup(filename, content);
        return {
          content: [{ type: "text", text: `Note saved to Obsidian vault: ${filename} (${result.chars} chars)` }],
        };
      }
      console.warn("[vault] Obsidian save failed, cached in-memory:", result.error);
    }

    // Fall back to GitHub backup as second persistence layer
    const gitHubOk = await this.tryGitHubBackup(filename, content);
    if (gitHubOk) {
      return {
        content: [{ type: "text", text: `Note saved to cache and GitHub: ${filename} (${content.length} chars)` }],
      };
    }

    return {
      content: [{ type: "text", text: `Note cached in-memory: ${filename} (${content.length} chars). Enable Obsidian Local REST API for persistent saves.` }],
    };
  }

  private async tryGitHubBackup(filename: string, content: string): Promise<boolean> {
    try {
      const res = await fetch("/api/vault/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, content }),
      });
      if (res.ok) {
        const data = await res.json();
        console.log("[vault] GitHub backup saved:", data.path);
        return true;
      }
      const err = await res.json();
      console.warn("[vault] GitHub backup failed:", err.error);
      return false;
    } catch {
      console.warn("[vault] GitHub backend unavailable");
      return false;
    }
  }

  // ── New Tool Handlers ─────────────────────────────────────────────────

  private async handleListVault(args: Record<string, unknown>): Promise<ToolCallResult> {
    const dirPath = String(args.path ?? "");

    // Try Obsidian first
    if (obsidian.isObsidianConfigured()) {
      const result = await obsidian.listVaultDirectory(dirPath);
      if (result.ok) {
        const folders = result.files.filter((f) => f.type === "folder");
        const files = result.files.filter((f) => f.type === "file");
        let text = `Contents of "${dirPath || "root"}" in Obsidian vault:`;
        if (folders.length > 0) {
          text += `\n\n📁 Folders:\n  ${folders.map((f) => f.name).join("\n  ")}`;
        }
        if (files.length > 0) {
          text += `\n\n📄 Files:\n  ${files.map((f) => f.name).join("\n  ")}`;
        }
        if (result.files.length === 0) {
          text += "\n  (empty)";
        }
        return { content: [{ type: "text", text }] };
      }
      return {
        content: [{ type: "text", text: `Could not list vault: ${result.error}` }],
        isError: true,
      };
    }

    // Fall back to listing from in-memory vault
    const prefix = dirPath ? dirPath.replace(/\/$/, "") + "/" : "";
    const files = Array.from(this.vault.keys())
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length).split("/")[0])
      .filter((v, i, a) => a.indexOf(v) === i);
    if (files.length === 0) {
      return {
        content: [{ type: "text", text: `No cached files at "${dirPath || "root"}". Obsidian is not connected — cached notes are limited.` }],
      };
    }
    return {
      content: [{ type: "text", text: `Contents of "${dirPath || "root"}" (from cache):\n  ${files.join("\n  ")}` }],
    };
  }

  private async handleGetActiveFile(): Promise<ToolCallResult> {
    if (!obsidian.isObsidianConfigured()) {
      return {
        content: [{ type: "text", text: "Obsidian is not connected. Open Obsidian with the Local REST API plugin enabled to use this tool." }],
        isError: true,
      };
    }

    const active = await obsidian.getActiveFilePath();
    if (!active.ok) {
      return {
        content: [{ type: "text", text: `Could not get active file: ${active.error}` }],
        isError: true,
      };
    }

    if (!active.path) {
      return {
        content: [{ type: "text", text: "No file is currently open in Obsidian." }],
      };
    }

    const content = await obsidian.readVaultFile(active.path);
    if (!content.ok) {
      return {
        content: [{ type: "text", text: `Active file: ${active.path}\n(but could not read content: ${content.error})` }],
      };
    }

    return {
      content: [{ type: "text", text: `📍 Active file: ${active.path}\n\n${content.content}` }],
    };
  }

  private async handleGetDailyNote(): Promise<ToolCallResult> {
    if (!obsidian.isObsidianConfigured()) {
      return {
        content: [{ type: "text", text: "Obsidian is not connected. Open Obsidian with the Local REST API plugin enabled to use this tool." }],
        isError: true,
      };
    }

    const daily = await obsidian.getPeriodicNotePath("daily");
    if (!daily.ok) {
      return {
        content: [{ type: "text", text: `Could not find today's daily note: ${daily.error}` }],
        isError: true,
      };
    }

    if (!daily.path) {
      return {
        content: [{ type: "text", text: "No daily note found for today. Create one in Obsidian first." }],
      };
    }

    const content = await obsidian.readVaultFile(daily.path);
    if (!content.ok) {
      return {
        content: [{ type: "text", text: `Daily note: ${daily.path}\n(but could not read: ${content.error})` }],
      };
    }

    return {
      content: [{ type: "text", text: `📅 Today's daily note (${daily.path}):\n\n${content.content}` }],
    };
  }
}
