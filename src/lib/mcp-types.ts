// ─── MCP Protocol Types ────────────────────────────────────────────────────
// Based on the Model Context Protocol specification (JSON-RPC 2.0)
// https://modelcontextprotocol.io/specification/2025-11-25

// ── JSON-RPC 2.0 Base ──────────────────────────────────────────────────────

export interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: Record<string, unknown>;
  error?: JSONRPCError;
}

export interface JSONRPCNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

export type JSONRPCMessage = JSONRPCRequest | JSONRPCResponse | JSONRPCNotification;

// ── Standard Error Codes ───────────────────────────────────────────────────

export const MCPErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ResourceNotFound: -32002,
  ToolExecutionError: -32003,
} as const;

// ── Lifecycle ──────────────────────────────────────────────────────────────

export interface InitializeRequest {
  protocolVersion: string;
  capabilities: ClientCapabilities;
  clientInfo: Implementation;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: Implementation;
  instructions?: string;
}

export interface Implementation {
  name: string;
  version: string;
}

export interface ClientCapabilities {
  roots?: Record<string, unknown>;
  sampling?: Record<string, unknown>;
  elicitation?: Record<string, unknown>;
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
}

// ── Tools ──────────────────────────────────────────────────────────────────

export interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
}

export interface ToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallResult {
  content: ToolContent[];
  isError?: boolean;
}

export type ToolContent = TextContent | ImageContent | AudioContent | EmbeddedResource;

export interface TextContent {
  type: "text";
  text: string;
  annotations?: ContentAnnotations;
}

export interface ImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
  annotations?: ContentAnnotations;
}

export interface AudioContent {
  type: "audio";
  data: string; // base64
  mimeType: string;
  annotations?: ContentAnnotations;
}

export interface EmbeddedResource {
  type: "resource";
  resource: ResourceContent;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  annotations?: ContentAnnotations;
}

export interface ContentAnnotations {
  audience?: ("user" | "assistant")[];
  priority?: number;
  lastModified?: string;
}

// ── JSON Schema ────────────────────────────────────────────────────────────

export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  description?: string;
  $schema?: string;
  items?: JSONSchema;
}

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  items?: JSONSchema;
}

// ── Resources ──────────────────────────────────────────────────────────────

export interface Resource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: ContentAnnotations;
}

export interface ResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

// ── List Pagination ────────────────────────────────────────────────────────

export interface PaginatedRequest {
  cursor?: string;
}

export interface PaginatedResult {
  nextCursor?: string;
}

// ── Transport ──────────────────────────────────────────────────────────────

export type MessageHandler = (message: JSONRPCMessage) => void;

export interface MCPTransport {
  send(message: JSONRPCMessage): void;
  onMessage(handler: MessageHandler): void;
  close(): void;
}

// ── Helper: create JSON-RPC messages ──────────────────────────────────────

let requestIdCounter = 0;

export function createRequest(method: string, params?: Record<string, unknown>): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id: ++requestIdCounter,
    method,
    params,
  };
}

export function createResponse(id: string | number, result: Record<string, unknown>): JSONRPCResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

export function createErrorResponse(id: string | number, code: number, message: string, data?: unknown): JSONRPCResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, data },
  };
}

export function createNotification(method: string, params?: Record<string, unknown>): JSONRPCNotification {
  return {
    jsonrpc: "2.0",
    method,
    params,
  };
}
