// ─── Memory Store ──────────────────────────────────────────────────────────
// Persistent, localStorage-backed memory for Sid's voice agent.
// Inspired by claude-mem's approach: captures interaction summaries and
// injects relevant context back into future sessions.
//
// Each memory is a structured record of a user ↔ agent interaction:
//   - userMessage: what the user said
//   - agentResponse: what the agent replied
//   - toolsUsed: which tools were called
//   - summary: one-line AI-generated summary for efficient retrieval
//
// Storage key prefix: "aura_memory_"
// ───────────────────────────────────────────────────────────────────────────

export interface Memory {
  id: string;
  timestamp: number;
  userMessage: string;
  agentResponse: string;
  toolsUsed: string[];
  summary: string;
}

const STORAGE_KEY = "aura_memories";
const MAX_MEMORIES = 100;

// ── I/O ────────────────────────────────────────────────────────────────────

function loadAll(): Memory[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Memory[];
  } catch {
    return [];
  }
}

function saveAll(memories: Memory[]): void {
  try {
    // Keep only the most recent N
    const trimmed = memories.slice(-MAX_MEMORIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage full — prune aggressively
    try {
      const half = memories.slice(-Math.floor(MAX_MEMORIES / 2));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(half));
    } catch {
      // Give up — memory unavailable
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Get all stored memories, most recent first. */
export function getMemories(): Memory[] {
  return loadAll().reverse();
}

/** Save a new memory entry. */
export function saveMemory(memory: Omit<Memory, "id" | "timestamp">): Memory {
  const entry: Memory = {
    ...memory,
    id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  };
  const all = loadAll();
  all.push(entry);
  saveAll(all);
  return entry;
}

/** Search memories by keyword (simple substring match on userMessage, agentResponse, and summary). */
export function searchMemories(query: string, limit = 5): Memory[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  return loadAll()
    .reverse()
    .filter(
      (m) =>
        m.userMessage.toLowerCase().includes(q) ||
        m.agentResponse.toLowerCase().includes(q) ||
        m.summary.toLowerCase().includes(q) ||
        m.toolsUsed.some((t) => t.toLowerCase().includes(q)),
    )
    .slice(0, limit);
}

/** Format memories as a compact text block for system prompt injection. */
export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m) => {
    const ago = formatTimeAgo(m.timestamp);
    const tools = m.toolsUsed.length > 0 ? ` [tools: ${m.toolsUsed.join(", ")}]` : "";
    return `• ${ago}: ${m.summary}${tools}`;
  });
  return `\n--- PAST MEMORIES (you remember these) ---\n${lines.join("\n")}\n--- END MEMORIES ---\n`;
}

/** Generate a brief summary of an interaction for future retrieval. */
export function summarizeInteraction(userMessage: string, agentResponse: string, toolsUsed: string[]): string {
  const toolHint = toolsUsed.length > 0 ? ` (used ${toolsUsed.join(", ")})` : "";
  // Truncate the user message for the summary
  const msg = userMessage.length > 80 ? userMessage.slice(0, 80) + "…" : userMessage;
  // Truncate the response for the summary
  const resp = agentResponse.length > 120 ? agentResponse.slice(0, 120) + "…" : agentResponse;
  return `${msg} → ${resp}${toolHint}`;
}

/** Clear all memories. */
export function clearMemories(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString("en", { month: "short", day: "numeric" });
}
