// ─── MCP Transport ─────────────────────────────────────────────────────────
// Transport abstraction for MCP — currently uses in-memory transport for the
// browser, but could be swapped for stdio (Node.js) or Streamable HTTP later.

import type { JSONRPCMessage, MessageHandler } from "./mcp-types";

// ── In-Memory Transport ────────────────────────────────────────────────────
// Both client and server share this transport — messages pass synchronously.

export class InMemoryTransport {
  private handlers: MessageHandler[] = [];
  private peer: InMemoryTransport | null = null;

  /** Link two transports together (client ↔ server) */
  static link(client: InMemoryTransport, server: InMemoryTransport) {
    client.peer = server;
    server.peer = client;
  }

  send(message: JSONRPCMessage): void {
    // Deliver to the linked peer's handlers
    if (this.peer) {
      for (const handler of this.peer.handlers) {
        try {
          handler(message);
        } catch {
          // Handler errors shouldn't break the transport
        }
      }
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  close(): void {
    this.handlers = [];
    this.peer = null;
  }
}
