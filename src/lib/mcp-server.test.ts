// ─── MCP Server Tests ──────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from "vitest";
import { MCPServer, setTavilyRateLimit } from "./mcp-server";
import { InMemoryTransport } from "./mcp-transport";
import type { ToolCallResult } from "./mcp-types";

// Disable the Tavily rate limiter in tests so they don't incur 3s delays
beforeAll(() => {
  setTavilyRateLimit(0);
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function createServer(): MCPServer {
  const transport = new InMemoryTransport();
  return new MCPServer(transport);
}

/** Mock the next fetch call to return a given JSON response. */
function mockFetchOnce(response: Partial<Response>) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
    ...response,
  } as Response);
}

// ─── write_file Tests ──────────────────────────────────────────────────────

describe("write_file tool", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = createServer();
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return success when writing a file with valid arguments", async () => {
    const mockJson = {
      success: true,
      path: "output/test.html",
      chars: 42,
      message: "File written: output/test.html",
    };

    mockFetchOnce({
      ok: true,
      json: async () => mockJson,
    });

    const result: ToolCallResult = await server.callTool("write_file", {
      path: "output/test.html",
      content: "<h1>Hello, World!</h1><p>Test content</p>",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as any).text).toContain("✅ Written 42 chars to output/test.html");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/exec/write-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "output/test.html",
        content: "<h1>Hello, World!</h1><p>Test content</p>",
      }),
    });
  });

  it("should return error when path is missing", async () => {
    const result: ToolCallResult = await server.callTool("write_file", {
      content: "some content",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("Both 'path' and 'content' are required.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should return error when content is missing", async () => {
    const result: ToolCallResult = await server.callTool("write_file", {
      path: "test.html",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("Both 'path' and 'content' are required.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should return error when both path and content are missing", async () => {
    const result: ToolCallResult = await server.callTool("write_file", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("Both 'path' and 'content' are required.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should return error when fetch fails with non-ok status", async () => {
    mockFetchOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "Permission denied" }),
    });

    const result: ToolCallResult = await server.callTool("write_file", {
      path: "test.html",
      content: "test",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("Write failed: Permission denied");
  });

  it("should return error when fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));

    const result: ToolCallResult = await server.callTool("write_file", {
      path: "test.html",
      content: "test",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("Write failed: Network error");
  });
});

// ─── execute_command Tests ─────────────────────────────────────────────────

describe("execute_command tool", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = createServer();
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return success output when command completes successfully", async () => {
    const mockJson = {
      success: true,
      exitCode: 0,
      stdout: "file1.txt\nfile2.txt\n",
      stderr: "",
      message: "Command completed with exit code 0",
    };

    mockFetchOnce({
      ok: true,
      json: async () => mockJson,
    });

    const result: ToolCallResult = await server.callTool("execute_command", {
      command: "ls -la",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe("text");
    const output = (result.content[0] as any).text;
    expect(output).toContain("$ ls -la");
    expect(output).toContain("file1.txt\nfile2.txt");
    expect(output).toContain("→ Exit code: 0");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/exec/run-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "ls -la",
        timeout: 15000,
      }),
    });
  });

  it("should include stderr in the output when present", async () => {
    const mockJson = {
      success: true,
      exitCode: 0,
      stdout: "output.txt",
      stderr: "warning: file not found",
      message: "Command completed with exit code 0",
    };

    mockFetchOnce({
      ok: true,
      json: async () => mockJson,
    });

    const result: ToolCallResult = await server.callTool("execute_command", {
      command: "cat missing.txt",
    });

    const output = (result.content[0] as any).text;
    expect(output).toContain("warning: file not found");
    expect(output).toContain("⚠️ stderr:");
  });

  it("should pass custom timeout when provided", async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        success: true,
        exitCode: 0,
        stdout: "done",
        stderr: "",
        message: "Command completed with exit code 0",
      }),
    });

    await server.callTool("execute_command", {
      command: "sleep 1 && echo done",
      timeout: 30000,
    });

    expect(fetch).toHaveBeenCalledWith("/api/exec/run-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "sleep 1 && echo done",
        timeout: 30000,
      }),
    });
  });

  it("should return error when command is empty", async () => {
    const result: ToolCallResult = await server.callTool("execute_command", {
      command: "",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("A 'command' string is required.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should return error when command is missing", async () => {
    const result: ToolCallResult = await server.callTool("execute_command", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("A 'command' string is required.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should return isError=true when command exits with non-zero code", async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        success: false,
        exitCode: 1,
        stdout: "",
        stderr: "command not found",
        message: "Command failed: command not found",
      }),
    });

    const result: ToolCallResult = await server.callTool("execute_command", {
      command: "nonexistent-command",
    });

    expect(result.isError).toBe(true);
    const output = (result.content[0] as any).text;
    expect(output).toContain("→ Exit code: 1");
    expect(output).toContain("command not found");
  });

  it("should return error when fetch fails with non-ok status", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "A 'command' string is required." }),
    });

    const result: ToolCallResult = await server.callTool("execute_command", {
      command: "ls",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("Command failed: A 'command' string is required.");
  });

  it("should return error when fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Connection refused"));

    const result: ToolCallResult = await server.callTool("execute_command", {
      command: "ls",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("Command execution failed: Connection refused");
  });
});

// ─── get_time Tests ───────────────────────────────────────────────────────

describe("get_time tool", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = createServer();
  });

  it("should return the current date and time", async () => {
    const before = new Date();
    const result: ToolCallResult = await server.callTool("get_time", {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as any).text;
    expect(text).toContain("(IST)");
    expect(text).toContain(String(before.getFullYear()));
    const monthName = before.toLocaleDateString("en", { month: "long" });
    expect(text).toContain(monthName);
    const timeMatch = text.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    expect(timeMatch).not.toBeNull();
  });

  it("should not require any arguments", async () => {
    const result: ToolCallResult = await server.callTool("get_time", {});
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as any).text).toBeTruthy();
  });
});

// ─── read_note Tests ───────────────────────────────────────────────────────

describe("read_note tool", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = createServer();
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return note content for an existing filename", async () => {
    const noteContent = "# Sid Profile\n- Co-founder, Label Ethnic Vogue (Surat)\n- Teacher at PP Savani University";
    mockFetchOnce({
      ok: true,
      status: 200,
      text: async () => noteContent,
    });

    const result: ToolCallResult = await server.callTool("read_note", {
      filename: "wiki/sid-profile.md",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("[wiki/sid-profile.md]");
    expect(text).toContain("Label Ethnic Vogue");
    expect(text).toContain("PP Savani University");
  });

  it("should return error for a non-existent filename", async () => {
    mockFetchOnce({
      ok: false,
      status: 404,
      text: async () => "Not found",
    });

    const result: ToolCallResult = await server.callTool("read_note", {
      filename: "nonexistent.md",
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as any).text;
    expect(text).toContain("Could not read note");
    expect(text).toContain("nonexistent.md");
  });

  it("should return error when filename is missing", async () => {
    const result: ToolCallResult = await server.callTool("read_note", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("Please provide a filename to read.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should return error when Obsidian is not configured", async () => {
    vi.stubEnv("VITE_OBSIDIAN_API_KEY", "");

    const result: ToolCallResult = await server.callTool("read_note", {
      filename: "wiki/test.md",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Obsidian is not connected");
    expect(fetch).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });
});

// ─── search_vault Tests ────────────────────────────────────────────────────

describe("search_vault tool", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = createServer();
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should find notes matching query in content", async () => {
    // First fetch: search POST
    mockFetchOnce({
      ok: true,
      json: async () => [
        { path: "wiki/meditation-sessions.md", match: "# Meditation\n- Weekly Thursday 9PM", score: 0.95 },
      ],
    });
    // Second fetch: read each result
    mockFetchOnce({
      ok: true,
      text: async () => "# Meditation\n- Weekly Thursday 9PM on Google Meet\n- Teacher: Archana Didi",
    });

    const result: ToolCallResult = await server.callTool("search_vault", {
      query: "Archana",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("Search results for");
    expect(text).toContain("meditation-sessions");
  });

  it("should return no results for an unmatched query", async () => {
    mockFetchOnce({
      ok: true,
      json: async () => [],
    });

    const result: ToolCallResult = await server.callTool("search_vault", {
      query: "xyznonexistent123",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("No results found");
  });

  it("should return error when query is empty", async () => {
    const result: ToolCallResult = await server.callTool("search_vault", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("Please provide a search query.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should handle search API failure gracefully", async () => {
    mockFetchOnce({
      ok: false,
      status: 500,
      text: async () => "Internal server error",
    });

    const result: ToolCallResult = await server.callTool("search_vault", {
      query: "test",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Search failed");
  });

  it("should limit results to a maximum of 3", async () => {
    // Return 5 results
    const manyResults = Array.from({ length: 5 }, (_, i) => ({
      path: `wiki/note-${i + 1}.md`,
      match: `Content for note ${i + 1}`,
      score: 1.0 - i * 0.1,
    }));
    mockFetchOnce({
      ok: true,
      json: async () => manyResults,
    });
    // Read each of the 3 limited results
    for (let i = 0; i < 3; i++) {
      mockFetchOnce({
        ok: true,
        text: async () => `# Note ${i + 1}\nContent for note ${i + 1}.`,
      });
    }

    const result: ToolCallResult = await server.callTool("search_vault", {
      query: "note",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    const matches = text.match(/\[.*?\]/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeLessThanOrEqual(3);
  });

  it("should return error when Obsidian is not configured", async () => {
    vi.stubEnv("VITE_OBSIDIAN_API_KEY", "");

    const result: ToolCallResult = await server.callTool("search_vault", {
      query: "test",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Obsidian is not connected");

    vi.unstubAllEnvs();
  });
});

// ─── web_search Tests ──────────────────────────────────────────────────────

describe("web_search tool", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = createServer();
    vi.stubEnv("VITE_TAVILY_API_KEY", "test-tavily-key");
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("should return error when query is missing", async () => {
    const result: ToolCallResult = await server.callTool("web_search", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("No search query provided.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should return error when query is empty", async () => {
    const result: ToolCallResult = await server.callTool("web_search", {
      query: "   ",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("No search query provided.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should return error when API key is not set", async () => {
    vi.stubEnv("VITE_TAVILY_API_KEY", "");

    const result: ToolCallResult = await server.callTool("web_search", {
      query: "IPL 2025",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Web search is not configured yet");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should return formatted results for a successful search", async () => {
    const mockResults = [
      {
        title: "IPL 2025 News",
        url: "https://example.com/ipl-2025",
        content: "The Indian Premier League 2025 season is in full swing with exciting matches.",
      },
      {
        title: "IPL Schedule 2025",
        url: "https://example.com/schedule",
        content: "Check the full schedule for IPL 2025 including playoffs.",
      },
    ];

    mockFetchOnce({
      ok: true,
      json: async () => ({ results: mockResults }),
    });

    const result: ToolCallResult = await server.callTool("web_search", {
      query: "IPL 2025 news",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("Web search results for");
    expect(text).toContain("IPL 2025 News");
    expect(text).toContain("https://example.com/ipl-2025");
    expect(text).toContain("Indian Premier League");

    expect(fetch).toHaveBeenCalledWith("/api/tavily/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: "test-tavily-key",
        query: "IPL 2025 news",
        search_depth: "basic",
        max_results: 5,
        include_images: false,
      }),
    });
  });

  it("should limit to at most 5 results", async () => {
    const manyResults = Array.from({ length: 10 }, (_, i) => ({
      title: `Result ${i + 1}`,
      url: `https://example.com/${i + 1}`,
      content: `Content for result ${i + 1}`,
    }));

    mockFetchOnce({
      ok: true,
      json: async () => ({ results: manyResults }),
    });

    const result: ToolCallResult = await server.callTool("web_search", {
      query: "test query",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    const numberedResults = text.match(/\d+\.\s/g);
    expect(numberedResults?.length).toBe(5);
  });

  it("should return success with empty results message when API returns no results", async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({ results: [] }),
    });

    const result: ToolCallResult = await server.callTool("web_search", {
      query: "xyznonexistentquery12345",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("No search results found");
  });

  it("should return error when API returns non-ok status", async () => {
    mockFetchOnce({
      ok: false,
      status: 429,
      text: async () => "Rate limit exceeded",
    });

    const result: ToolCallResult = await server.callTool("web_search", {
      query: "IPL 2025",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Web search failed (429)");
  });

  it("should return error when fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network timeout"));

    const result: ToolCallResult = await server.callTool("web_search", {
      query: "IPL 2025",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Web search failed: Network timeout");
  });

  it("should truncate long content snippets to 300 characters", async () => {
    const longContent = "A".repeat(500);
    mockFetchOnce({
      ok: true,
      json: async () => ({
        results: [{ title: "Long Article", url: "https://example.com", content: longContent }],
      }),
    });

    const result: ToolCallResult = await server.callTool("web_search", {
      query: "long article",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    const snippet = text.split("URL:")[1]?.split("\n")[1] ?? "";
    expect(snippet.length).toBeLessThanOrEqual(305);
  });
});

// ─── save_note Tests ───────────────────────────────────────────────────────

describe("save_note tool", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = createServer();
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should save note to Obsidian vault and return success", async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    });

    const result: ToolCallResult = await server.callTool("save_note", {
      filename: "wiki/test-note.md",
      content: "# Test Note\nThis is a test note.",
    });

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as any).text).toContain("Note saved to Obsidian vault: wiki/test-note.md");
    // Should report character count
    expect((result.content[0] as any).text).toContain("chars");
  });

  it("should return error when filename is missing", async () => {
    const result: ToolCallResult = await server.callTool("save_note", {
      content: "Some content",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("Both 'filename' and 'content' are required.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should return error when content is missing", async () => {
    const result: ToolCallResult = await server.callTool("save_note", {
      filename: "test.md",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("Both 'filename' and 'content' are required.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should return error when both filename and content are missing", async () => {
    const result: ToolCallResult = await server.callTool("save_note", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toBe("Both 'filename' and 'content' are required.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should return error when Obsidian write fails", async () => {
    mockFetchOnce({
      ok: false,
      status: 500,
      text: async () => "Internal server error",
    });

    const result: ToolCallResult = await server.callTool("save_note", {
      filename: "wiki/fail-note.md",
      content: "# Fail\nThis should fail.",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Failed to save note");
  });

  it("should return error when Obsidian is not configured", async () => {
    vi.stubEnv("VITE_OBSIDIAN_API_KEY", "");

    const result: ToolCallResult = await server.callTool("save_note", {
      filename: "wiki/test.md",
      content: "# Test",
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Obsidian is not connected");
    expect(fetch).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });
});

// ─── list_vault Tests ──────────────────────────────────────────────────────

describe("list_vault tool", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = createServer();
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should list files and folders at root", async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        files: [
          { name: "wiki", type: "folder" },
          { name: "daily", type: "folder" },
          { name: "README.md", type: "file" },
        ],
      }),
    });

    const result: ToolCallResult = await server.callTool("list_vault", {});

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain('Contents of "root" in Obsidian vault:');
    expect(text).toContain("📁 Folders:");
    expect(text).toContain("wiki");
    expect(text).toContain("daily");
    expect(text).toContain("📄 Files:");
    expect(text).toContain("README.md");
  });

  it("should list contents of a subdirectory", async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        files: [
          { name: "sid-profile.md", type: "file" },
          { name: "my-investments.md", type: "file" },
        ],
      }),
    });

    const result: ToolCallResult = await server.callTool("list_vault", {
      path: "wiki",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain('Contents of "wiki" in Obsidian vault:');
    expect(text).toContain("sid-profile.md");
    expect(text).toContain("my-investments.md");
  });

  it("should show empty message when directory has no contents", async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({ files: [] }),
    });

    const result: ToolCallResult = await server.callTool("list_vault", {
      path: "empty-folder",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("(empty)");
  });

  it("should handle API error gracefully", async () => {
    mockFetchOnce({
      ok: false,
      status: 500,
      text: async () => "Internal server error",
    });

    const result: ToolCallResult = await server.callTool("list_vault", {});

    expect(result.isError).toBe(true);
    const text = (result.content[0] as any).text;
    expect(text).toContain("Could not list vault");
  });

  it("should return error when Obsidian is not configured", async () => {
    vi.stubEnv("VITE_OBSIDIAN_API_KEY", "");

    const result: ToolCallResult = await server.callTool("list_vault", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Obsidian is not connected");
    expect(fetch).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });
});

// ─── get_active_file Tests ─────────────────────────────────────────────────

describe("get_active_file tool", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = createServer();
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return active file path and content", async () => {
    // First fetch: get active file path
    mockFetchOnce({
      ok: true,
      json: async () => ({ path: "wiki/sid-profile.md" }),
    });
    // Second fetch: read the file content
    mockFetchOnce({
      ok: true,
      text: async () => "# Sid Profile\n- Co-founder at Label Ethnic Vogue",
    });

    const result: ToolCallResult = await server.callTool("get_active_file", {});

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("📍 Active file: wiki/sid-profile.md");
    expect(text).toContain("Label Ethnic Vogue");
  });

  it("should return message when no file is open", async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({ path: "" }),
    });

    const result: ToolCallResult = await server.callTool("get_active_file", {});

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toBe("No file is currently open in Obsidian.");
  });

  it("should handle active file API failure", async () => {
    mockFetchOnce({
      ok: false,
      status: 500,
      text: async () => "Server error",
    });

    const result: ToolCallResult = await server.callTool("get_active_file", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Could not get active file");
  });

  it("should handle file content read failure", async () => {
    // First fetch: get active file path — succeeds
    mockFetchOnce({
      ok: true,
      json: async () => ({ path: "wiki/sid-profile.md" }),
    });
    // Second fetch: read the file — fails
    mockFetchOnce({
      ok: false,
      status: 404,
      text: async () => "Not found",
    });

    const result: ToolCallResult = await server.callTool("get_active_file", {});

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("Active file: wiki/sid-profile.md");
    expect(text).toContain("could not read content");
  });

  it("should return error when Obsidian is not configured", async () => {
    vi.stubEnv("VITE_OBSIDIAN_API_KEY", "");

    const result: ToolCallResult = await server.callTool("get_active_file", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Obsidian is not connected");
    expect(fetch).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });
});

// ─── get_daily_note Tests ──────────────────────────────────────────────────

describe("get_daily_note tool", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = createServer();
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return today's daily note content", async () => {
    // First fetch: get daily note path
    mockFetchOnce({
      ok: true,
      json: async () => ({ path: "daily/2026-05-27.md" }),
    });
    // Second fetch: read the file content
    mockFetchOnce({
      ok: true,
      text: async () => "# Daily Note\n- Woke up early\n- Worked on voice agent",
    });

    const result: ToolCallResult = await server.callTool("get_daily_note", {});

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("📅 Today's daily note");
    expect(text).toContain("daily/2026-05-27.md");
    expect(text).toContain("Worked on voice agent");
  });

  it("should return message when no daily note exists", async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({ path: "" }),
    });

    const result: ToolCallResult = await server.callTool("get_daily_note", {});

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toBe("No daily note found for today. Create one in Obsidian first.");
  });

  it("should handle periodic note API failure", async () => {
    mockFetchOnce({
      ok: false,
      status: 500,
      text: async () => "Internal server error",
    });

    const result: ToolCallResult = await server.callTool("get_daily_note", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Could not find today's daily note");
  });

  it("should handle daily note read failure", async () => {
    // First fetch: get daily note path — succeeds
    mockFetchOnce({
      ok: true,
      json: async () => ({ path: "daily/2026-05-27.md" }),
    });
    // Second fetch: read the file — fails
    mockFetchOnce({
      ok: false,
      status: 404,
      text: async () => "Not found",
    });

    const result: ToolCallResult = await server.callTool("get_daily_note", {});

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("Daily note: daily/2026-05-27.md");
    expect(text).toContain("could not read");
  });

  it("should return error when Obsidian is not configured", async () => {
    vi.stubEnv("VITE_OBSIDIAN_API_KEY", "");

    const result: ToolCallResult = await server.callTool("get_daily_note", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Obsidian is not connected");
    expect(fetch).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });
});
