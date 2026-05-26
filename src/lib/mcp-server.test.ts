// ─── MCP Server Tests: write_file & execute_command ────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MCPServer } from "./mcp-server";
import { InMemoryTransport } from "./mcp-transport";
import type { ToolCallResult } from "./mcp-types";

// ─── Helpers ───────────────────────────────────────────────────────────────

function createServer(): MCPServer {
  const transport = new InMemoryTransport();
  return new MCPServer(transport);
}

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

    // Verify fetch was called correctly
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

    // Verify fetch was called correctly
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

    // Should include IST timezone indicator
    expect(text).toContain("(IST)");

    // Should include today's date parts
    expect(text).toContain(String(before.getFullYear()));
    const monthName = before.toLocaleDateString("en", { month: "long" });
    expect(text).toContain(monthName);

    // Should include time in HH:MM:SS format
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
  });

  it("should return note content for an existing filename", async () => {
    const result: ToolCallResult = await server.callTool("read_note", {
      filename: "wiki/sid-profile.md",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as any).text;
    expect(text).toContain("[wiki/sid-profile.md]");
    expect(text).toContain("Label Ethnic Vogue");
    expect(text).toContain("PP Savani University");
  });

  it("should return error for a non-existent filename", async () => {
    const result: ToolCallResult = await server.callTool("read_note", {
      filename: "nonexistent.md",
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as any).text;
    expect(text).toContain("Note not found: nonexistent.md");
    expect(text).toContain("Available notes:");
  });

  it("should list available notes in the error message", async () => {
    const result: ToolCallResult = await server.callTool("read_note", {
      filename: "missing.md",
    });

    const text = (result.content[0] as any).text;
    expect(text).toContain("wiki/sid-profile.md");
    expect(text).toContain("wiki/my-investments.md");
    expect(text).toContain("daily/routine.md");
  });

  it("should return error when filename is missing", async () => {
    const result: ToolCallResult = await server.callTool("read_note", {});

    expect(result.isError).toBe(true);
    const text = (result.content[0] as any).text;
    expect(text).toContain("Note not found:");
    expect(text).toContain("Available notes:");
  });

  it("should handle filenames with special characters", async () => {
    const result: ToolCallResult = await server.callTool("read_note", {
      filename: "output/2026-05-24 - Drinks with the Boys.md",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("Drinks with the Boys");
    expect(text).toContain("Patiala");
  });
});

// ─── search_vault Tests ────────────────────────────────────────────────────

describe("search_vault tool", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = createServer();
  });

  it("should find notes matching query in content", async () => {
    const result: ToolCallResult = await server.callTool("search_vault", {
      query: "Archana",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("Search results for");
    expect(text).toContain("meditation-sessions");
  });

  it("should find notes matching query in filename", async () => {
    const result: ToolCallResult = await server.callTool("search_vault", {
      query: "investment",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("Search results for");
    expect(text).toContain("my-investments");
  });

  it("should be case-insensitive", async () => {
    const result: ToolCallResult = await server.callTool("search_vault", {
      query: "ARCHANA",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("meditation-sessions");
  });

  it("should return no results for an unmatched query", async () => {
    const result: ToolCallResult = await server.callTool("search_vault", {
      query: "xyznonexistent123",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("No results found");
  });

  it("should limit results to a maximum of 3", async () => {
    const result: ToolCallResult = await server.callTool("search_vault", {
      query: "the",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    const matches = text.match(/\[.*?\]:/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeLessThanOrEqual(3);
  });

  it("should search across multiple content fields", async () => {
    const result: ToolCallResult = await server.callTool("search_vault", {
      query: "Meditation",
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    expect(text).toContain("meditation-sessions");
  });

  it("should return all notes when query is an empty string (matches everything)", async () => {
    // When query is empty, all notes match because "".includes("") is always true
    const result: ToolCallResult = await server.callTool("search_vault", {});

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text;
    const matches = text.match(/\[.*?\]:/g);
    expect(matches).not.toBeNull();
    // There are 7 notes in the default vault
    expect(matches!.length).toBeLessThanOrEqual(3); // limited to 3
  });
});

// ─── web_search Tests ──────────────────────────────────────────────────────

describe("web_search tool", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = createServer();
    // Set a dummy API key for tests that need it
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

    // Verify fetch was called with correct URL and body
    expect(fetch).toHaveBeenCalledWith("/api/tavily/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-tavily-key",
      },
      body: JSON.stringify({
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
    // Should have at most 5 numbered results (1. through 5.)
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
    // Each snippet is limited to 300 chars
    const snippet = text.split("URL:")[1]?.split("\n")[1] ?? "";
    expect(snippet.length).toBeLessThanOrEqual(305); // 300 + some padding from formatting
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

  it("should save note to vault and return success", async () => {
    // Simulate GitHub backend being available
    mockFetchOnce({
      ok: true,
      json: async () => ({ path: "wiki/test-note.md", success: true }),
    });

    const result: ToolCallResult = await server.callTool("save_note", {
      filename: "wiki/test-note.md",
      content: "# Test Note\nThis is a test note.",
    });

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as any).text).toContain("Note saved: wiki/test-note.md");

    // Verify fetch was called to persist to GitHub
    expect(fetch).toHaveBeenCalledWith("/api/vault/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "wiki/test-note.md",
        content: "# Test Note\nThis is a test note.",
      }),
    });
  });

  it("should persist the note in the vault and make it readable", async () => {
    // Simulate GitHub backend being available
    mockFetchOnce({
      ok: true,
      json: async () => ({ path: "wiki/test-note.md", success: true }),
    });

    await server.callTool("save_note", {
      filename: "wiki/test-note.md",
      content: "# Persist Test\nThis should be readable.",
    });

    // The note should now be readable via read_note
    const readResult: ToolCallResult = await server.callTool("read_note", {
      filename: "wiki/test-note.md",
    });

    expect(readResult.isError).toBeFalsy();
    const text = (readResult.content[0] as any).text;
    expect(text).toContain("# Persist Test");
    expect(text).toContain("This should be readable.");
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

  it("should still save to in-memory vault when GitHub fetch fails", async () => {
    // Simulate backend unavailable (fetch throws)
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Connection refused"));

    const result: ToolCallResult = await server.callTool("save_note", {
      filename: "wiki/offline-note.md",
      content: "# Offline Note\nSaved even though backend is down.",
    });

    // Should still return success for in-memory save
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as any).text).toContain("Note saved: wiki/offline-note.md");

    // The note should be readable from in-memory vault
    const readResult: ToolCallResult = await server.callTool("read_note", {
      filename: "wiki/offline-note.md",
    });
    expect(readResult.isError).toBeFalsy();
    expect((readResult.content[0] as any).text).toContain("Offline Note");
  });

  it("should still save to in-memory vault when GitHub returns an error", async () => {
    mockFetchOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "Internal server error" }),
    });

    const result: ToolCallResult = await server.callTool("save_note", {
      filename: "wiki/error-note.md",
      content: "# Error Note\nGitHub failed but vault saved.",
    });

    // Should still return success for in-memory save
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as any).text).toContain("Note saved: wiki/error-note.md");

    // The note should be readable from in-memory vault
    const readResult: ToolCallResult = await server.callTool("read_note", {
      filename: "wiki/error-note.md",
    });
    expect(readResult.isError).toBeFalsy();
    expect((readResult.content[0] as any).text).toContain("Error Note");
  });

  it("should overwrite existing note with the same filename", async () => {
    // Save a note
    mockFetchOnce({
      ok: true,
      json: async () => ({ path: "wiki/updatable.md", success: true }),
    });

    await server.callTool("save_note", {
      filename: "wiki/updatable.md",
      content: "# Original Content",
    });

    // Overwrite it
    mockFetchOnce({
      ok: true,
      json: async () => ({ path: "wiki/updatable.md", success: true }),
    });

    await server.callTool("save_note", {
      filename: "wiki/updatable.md",
      content: "# Updated Content",
    });

    // Should contain the updated content
    const readResult: ToolCallResult = await server.callTool("read_note", {
      filename: "wiki/updatable.md",
    });
    expect((readResult.content[0] as any).text).toContain("# Updated Content");
    expect((readResult.content[0] as any).text).not.toContain("Original Content");
  });
});
