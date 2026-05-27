// ─── MCP Server ────────────────────────────────────────────────────────────
// In-browser MCP server that implements the Model Context Protocol.
// Provides tools that connect to the real Obsidian vault via the Local REST API plugin
// (get_time, read_note, search_vault, web_search, save_note, write_file, execute_command,
//  list_vault, get_active_file, get_daily_note).

import {
  type JSONRPCRequest,
  type JSONRPCResponse,
  type JSONRPCMessage,
  type JSONRPCNotification,
  type InitializeResult,
  type Tool,
  type ToolCallResult,
  MCPErrorCodes,
  createResponse,
  createErrorResponse,
} from "./mcp-types";
import type { InMemoryTransport } from "./mcp-transport";
import * as obsidian from "./obsidian-client";
import { searchMemories, formatMemoriesForPrompt } from "./memory-store";

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
    description: "Read a note from your Obsidian vault by its filename. Requires Obsidian to be running with the Local REST API plugin enabled.",
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
    description: "Search through all notes in your Obsidian vault (filenames and content) for a given query. Uses Obsidian's built-in search. Returns up to 3 matching notes with content previews.",
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
    description: "Save or update a note in your Obsidian vault. Creates a new note or overwrites an existing one. Requires Obsidian to be running with the Local REST API plugin enabled.",
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
    description: "List files and folders in your Obsidian vault at a given path. Use this to browse the vault structure and discover what notes are available. Requires Obsidian to be running with the Local REST API plugin enabled.",
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
  {
    name: "search_memory",
    title: "Search Past Memories",
    description: "Search through past conversations and interactions stored in your persistent memory. Use this to recall what was discussed earlier, what tools were used, and what actions were taken. Searches by keyword across all saved memories.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to find relevant memories",
        },
      },
      required: ["query"],
    },
  },
];

// ─── MCP Server ────────────────────────────────────────────────────────────

export class MCPServer {
  private transport: InMemoryTransport;
  private initialized = false;

  constructor(transport: InMemoryTransport) {
    this.transport = transport;
    this.transport.onMessage((msg) => this.handleMessage(msg));
  }

  // ── Public API for hosts to interact with the server directly ──────────

  getTools(): Tool[] {
    return TOOLS;
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
      case "search_memory":
        return await this.handleSearchMemory(args);
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
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
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: "sid-vault-mcp",
        version: "1.0.0",
      },
      instructions:
        "MCP server for My Obsidian Vault. Provides tools to read, search, save, and list notes " +
        "in your Obsidian vault, plus get the current time and search the web. " +
        "Requires Obsidian to be running with the Local REST API plugin enabled for vault operations.",
    };

    this.send(createResponse(req.id, result as unknown as Record<string, unknown>));
    this.initialized = true;
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
    if (!obsidian.isObsidianConfigured()) {
      return {
        content: [{ type: "text", text: "Obsidian is not connected. Open Obsidian with the Local REST API plugin enabled to read notes." }],
        isError: true,
      };
    }

    const filename = String(args.filename ?? "");
    if (!filename) {
      return {
        content: [{ type: "text", text: "Please provide a filename to read." }],
        isError: true,
      };
    }

    const result = await obsidian.readVaultFile(filename);
    if (!result.ok) {
      return {
        content: [{ type: "text", text: `Could not read note: ${result.error}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: `[${result.filename}]\n${result.content}` }],
    };
  }

  private async handleSearchVault(args: Record<string, unknown>): Promise<ToolCallResult> {
    if (!obsidian.isObsidianConfigured()) {
      return {
        content: [{ type: "text", text: "Obsidian is not connected. Open Obsidian with the Local REST API plugin enabled to search notes." }],
        isError: true,
      };
    }

    const query = String(args.query ?? "").trim();
    if (!query) {
      return {
        content: [{ type: "text", text: "Please provide a search query." }],
        isError: true,
      };
    }

    const result = await obsidian.simpleSearch(query);
    if (!result.ok) {
      return {
        content: [{ type: "text", text: `Search failed: ${result.error}` }],
        isError: true,
      };
    }

    if (result.results.length === 0) {
      return {
        content: [{ type: "text", text: `No results found for "${query}" in your Obsidian vault.` }],
      };
    }

    const limited = result.results.slice(0, 3);
    // Use match snippet from search response — no extra fetch per result
    const lines = limited.map((r, i) => {
      const snippet = (r.match ?? "").slice(0, 300);
      return `${i + 1}. [${r.path}]\n   ${snippet}`;
    });

    return {
      content: [{ type: "text", text: `Search results for "${query}" in Obsidian vault:\n\n${lines.join("\n\n---\n\n")}` }],
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
    if (!obsidian.isObsidianConfigured()) {
      return {
        content: [{ type: "text", text: "Obsidian is not connected. Open Obsidian with the Local REST API plugin enabled to save notes." }],
        isError: true,
      };
    }

    const filename = String(args.filename ?? "");
    const content = String(args.content ?? "");

    if (!filename || !content) {
      return {
        content: [{ type: "text", text: "Both 'filename' and 'content' are required." }],
        isError: true,
      };
    }

    const result = await obsidian.writeVaultFile(filename, content);
    if (!result.ok) {
      return {
        content: [{ type: "text", text: `Failed to save note: ${result.error}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: `Note saved to Obsidian vault: ${filename} (${result.chars} chars)` }],
    };
  }

  private async handleListVault(args: Record<string, unknown>): Promise<ToolCallResult> {
    if (!obsidian.isObsidianConfigured()) {
      return {
        content: [{ type: "text", text: "Obsidian is not connected. Open Obsidian with the Local REST API plugin enabled to browse the vault." }],
        isError: true,
      };
    }

    const dirPath = String(args.path ?? "");
    const result = await obsidian.listVaultDirectory(dirPath);

    if (!result.ok) {
      return {
        content: [{ type: "text", text: `Could not list vault: ${result.error}` }],
        isError: true,
      };
    }

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

  private async handleSearchMemory(args: Record<string, unknown>): Promise<ToolCallResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return {
        content: [{ type: "text", text: "Please provide a search query." }],
        isError: true,
      };
    }

    const results = searchMemories(query, 8);
    if (results.length === 0) {
      return {
        content: [{ type: "text", text: `No memories found for "${query}".` }],
      };
    }

    const formatted = formatMemoriesForPrompt(results);
    return {
      content: [{ type: "text", text: `Found ${results.length} relevant memory/ies for "${query}":\n${formatted}` }],
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
