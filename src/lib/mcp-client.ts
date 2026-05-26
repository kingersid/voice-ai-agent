// ─── MCP Client ────────────────────────────────────────────────────────────
// MCP client that connects to an MCP server via transport, performs lifecycle
// handshake, discovers tools/resources, and calls tools.

import {
  type JSONRPCRequest,
  type JSONRPCResponse,
  type Tool,
  type ToolCallRequest,
  type ToolCallResult,
  type Resource,
  type ResourceContents,
  type InitializeResult,
  type ServerCapabilities,
  createRequest,
} from "./mcp-types";
import type { InMemoryTransport } from "./mcp-transport";

// ─── MCP Client ────────────────────────────────────────────────────────────

export class MCPClient {
  private transport: InMemoryTransport;
  private initialized = false;
  private pendingRequests: Map<string | number, {
    resolve: (value: JSONRPCResponse) => void;
    reject: (reason: unknown) => void;
  }> = new Map();

  // Discovered capabilities
  private serverInfo: { name: string; version: string } | null = null;

  constructor(transport: InMemoryTransport) {
    this.transport = transport;
    this.transport.onMessage((msg) => this.handleResponse(msg as JSONRPCResponse));
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Initialize the MCP connection — perform capability negotiation */
  async initialize(): Promise<{ capabilities: ServerCapabilities; serverInfo: { name: string; version: string } }> {
    const req = createRequest("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "sid-voice-agent", version: "1.0.0" },
    });

    const response = await this.sendRequest(req);
    if (response.error) {
      throw new Error(`MCP initialize failed: ${response.error.message}`);
    }

    const result = response.result as unknown as InitializeResult;
    this.serverInfo = result.serverInfo;
    this.initialized = true;

    // Send initialized notification
    this.transport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    return {
      capabilities: result.capabilities,
      serverInfo: result.serverInfo,
    };
  }

  // ── Tools ──────────────────────────────────────────────────────────────

  /** Discover available tools from the MCP server */
  async listTools(): Promise<Tool[]> {
    if (!this.initialized) {
      throw new Error("MCP client not initialized. Call initialize() first.");
    }

    const req = createRequest("tools/list");
    const response = await this.sendRequest(req);
    if (response.error) {
      throw new Error(`MCP tools/list failed: ${response.error.message}`);
    }

    const result = response.result as { tools: Tool[] } | undefined;
    return result?.tools ?? [];
  }

  /** Call a tool on the MCP server */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    if (!this.initialized) {
      throw new Error("MCP client not initialized. Call initialize() first.");
    }

    const callReq: ToolCallRequest = { name, arguments: args };
    const req = createRequest("tools/call", callReq as unknown as Record<string, unknown>);
    const response = await this.sendRequest(req);
    if (response.error) {
      return {
        content: [{ type: "text", text: `Error calling ${name}: ${response.error.message}` }],
        isError: true,
      };
    }

    return (response.result as unknown as ToolCallResult) ?? {
      content: [{ type: "text", text: "No result returned" }],
      isError: true,
    };
  }

  // ── Resources ──────────────────────────────────────────────────────────

  /** Discover available resources from the MCP server */
  async listResources(): Promise<Resource[]> {
    if (!this.initialized) {
      throw new Error("MCP client not initialized. Call initialize() first.");
    }

    const req = createRequest("resources/list");
    const response = await this.sendRequest(req);
    if (response.error) {
      throw new Error(`MCP resources/list failed: ${response.error.message}`);
    }

    const result = response.result as { resources: Resource[] } | undefined;
    return result?.resources ?? [];
  }

  /** Read a specific resource by URI */
  async readResource(uri: string): Promise<ResourceContents | null> {
    if (!this.initialized) {
      throw new Error("MCP client not initialized. Call initialize() first.");
    }

    const req = createRequest("resources/read", { uri });
    const response = await this.sendRequest(req);
    if (response.error) {
      return null;
    }

    const result = response.result as { contents: ResourceContents[] } | undefined;
    return result?.contents?.[0] ?? null;
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private sendRequest(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error(`MCP request timed out: ${request.method}`));
      }, 10_000);

      this.pendingRequests.set(request.id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.transport.send(request);
    });
  }

  private handleResponse(response: JSONRPCResponse) {
    if (response.id === undefined || response.id === null) return;
    const pending = this.pendingRequests.get(response.id);
    if (pending) {
      this.pendingRequests.delete(response.id);
      pending.resolve(response);
    }
  }

  /** Get the server info after initialization */
  getServerInfo() {
    return this.serverInfo;
  }

  /** Check if the client has been initialized */
  isInitialized() {
    return this.initialized;
  }
}
