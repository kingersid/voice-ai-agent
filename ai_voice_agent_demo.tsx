import { useState, useEffect, useRef, useCallback } from "react";
import { MCPServer } from "./src/lib/mcp-server";
import { MCPClient } from "./src/lib/mcp-client";
import { InMemoryTransport } from "./src/lib/mcp-transport";
import type { Tool, ToolCallResult, JSONSchema } from "./src/lib/mcp-types";
import { getToolResultText } from "./src/lib/mcp-types";
import { checkObsidianStatus } from "./src/lib/obsidian-client";
import {
  getMemories,
  searchMemories,
  saveMemory,
  clearMemories,
  formatMemoriesForPrompt,
  summarizeInteraction,
} from "./src/lib/memory-store";

// ─── MCP Singleton (lazily initialized — no side effects on import) ────────

let _mcpClient: MCPClient | null = null;
let _initPromise: Promise<Tool[]> | null = null;
let _cachedTools: Tool[] = [];

function getMCPClient(): MCPClient {
  if (!_mcpClient) {
    const clientTransport = new InMemoryTransport();
    const serverTransport = new InMemoryTransport();
    InMemoryTransport.link(clientTransport, serverTransport);
    // Server only needs to be created for its side effects (registers message handler)
    new MCPServer(serverTransport);
    _mcpClient = new MCPClient(clientTransport);
  }
  return _mcpClient;
}

function getMCPInitPromise(): Promise<Tool[]> {
  if (!_initPromise) {
    const client = getMCPClient();
    _initPromise = client.initialize().then(() => client.listTools());
    _initPromise.then((tools) => { _cachedTools = tools; }).catch(() => {});
  }
  return _initPromise;
}

function buildSystemPrompt(memoryContext?: string): string {
  let prompt = `You are Sid's voice assistant. Be natural and direct. No introductions.

`;

  // Inject relevant past memories if available
  if (memoryContext) {
    prompt += `${memoryContext}\n\n`;
  }

  prompt += `For simple questions (greetings, opinions, general chat), answer directly from your knowledge without using tools.

For questions needing information, use tools as needed. You can call multiple tools in sequence — each tool call result will be provided back to you so you can keep working through a task step by step.

⚠️ FILE CREATION RULE: When the user asks you to CREATE, WRITE, or BUILD a file (code, HTML, CSS, JS, a game, etc.), you MUST use the write_file tool to write it to disk. Do NOT output the file contents in your chat response — just use write_file, then briefly inform the user what was created.

For COMPLEX TASKS (coding, file operations, multi-step research), work through them methodically:
1. Break the task into logical steps
2. Call tools to accomplish each step
3. When the task is fully complete, provide a clear summary as your final answer

If the user asks about a place, travel destination, city, country, or ANY factual question you're uncertain about, ALWAYS use the web_search tool to get accurate, current information.

⚠️ CRITICAL: Never mention tools, tool calls, or tool usage in your final response text unless the user directly asks what tools you have. Never say "I don't need tools" or "no tools needed." Just answer naturally.

If the user directly asks what tools you have or can see, list them by name (and only then). Otherwise, stay silent about tools.

Your available tools:
- get_time: Get the current date and time (IST)
- read_note: Read a note from the Obsidian vault
- search_vault: Full-text search through the Obsidian vault
- web_search: Search the web for current information
- save_note: Save or update a note in the Obsidian vault
- write_file: Write content to a file on disk (USE THIS FOR CREATING CODE/FILES — do NOT output file contents in chat)
- execute_command: Run a shell command
- list_vault: List files and folders in the Obsidian vault
- get_active_file: Get the currently open file in Obsidian
- get_daily_note: Get today's daily note from Obsidian
- search_memory: Search past conversations and interactions`;
  
  return prompt;
}

// ─── Build native tool definitions for the API ─────────────────────────

function buildToolsForAPI(): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return _cachedTools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

// ─── Dashboard Sections ──────────────────────────────────────────────────

interface DashboardSection {
  title: string;
  emoji: string;
  query: string;
  metrics: { label: string; value: string; trend?: "up" | "down" | "neutral" }[];
  status?: { label: string; active: boolean };
}

const DASHBOARD_SECTIONS: DashboardSection[] = [
  {
    title: "ETHNIC VOGUE",
    emoji: "🏪",
    query: "How's my Ethnic Vogue business performing today?",
    status: { label: "Online Store", active: true },
    metrics: [
      { label: "Today's Orders", value: "12", trend: "up" },
      { label: "Revenue", value: "₹8,450", trend: "up" },
      { label: "Pending", value: "3 items", trend: "neutral" },
    ],
  },
  {
    title: "INVESTMENTS",
    emoji: "📈",
    query: "How are my personal investments and portfolio looking?",
    metrics: [
      { label: "IGIL", value: "+12.4%", trend: "up" },
      { label: "NIFTY 50", value: "24,382", trend: "up" },
      { label: "Mutual Funds", value: "₹2.4L", trend: "up" },
    ],
  },
  {
    title: "DAILY LIFE",
    emoji: "🎯",
    query: "What's my schedule and goals for today?",
    status: { label: "Today's Progress", active: true },
    metrics: [
      { label: "Meditation", value: "7:30 PM", trend: "neutral" },
      { label: "Goals", value: "3/5 done", trend: "up" },
      { label: "Routine", value: "On track", trend: "up" },
    ],
  },
];

// ─── Types ──────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  time: string;
  tools?: { name: string; args: Record<string, unknown> }[];
}

type VoiceStatus = "idle" | "listening" | "processing" | "speaking";

// (text-based tool call parsing removed — using native tool_calls only)

// ─── HUD Waveform (continuous, sci-fi style) ────────────────────────────────

function HudWaveform({ isActive, volume }: { isActive: boolean; volume: number }) {
  const barCount = 80;
  const color = "#22d3ee";
  const now = Date.now();
  return (
    <div
      role="img"
      aria-label={isActive ? "Voice activity waveform - active" : "HUD telemetry waveform"}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 2,
        height: 40,
        width: "100%",
        maxWidth: 520,
        margin: "0 auto",
        position: "relative",
      }}
    >
      {/* Baseline glow */}
      <div
        style={{
          position: "absolute",
          bottom: "50%",
          width: "100%",
          height: 1,
          background: `linear-gradient(90deg, transparent, ${color}15, transparent)`,
        }}
      />
      {/* Center marker */}
      <div
        style={{
          position: "absolute",
          bottom: "50%",
          left: "50%",
          width: 2,
          height: 12,
          transform: "translateX(-50%)",
          background: `${color}20`,
        }}
      />
      {Array.from({ length: barCount }).map((_, i) => {
        const center = barCount / 2;
        const dist = Math.abs(i - center) / center;
        const phase = i * 0.25;
        const wave = Math.sin(phase + now * 0.0015) * 0.5 + 0.5;
        const idleHeight = 3 + wave * 16 + Math.sin(i * 0.08) * 4;
        const activeHeight = 3 + wave * 28 + Math.sin(i * 0.12 + now * 0.004) * 10;
        const h = isActive ? activeHeight * (0.6 + volume * 0.5) : idleHeight;
        return (
          <div
            key={i}
            style={{
              width: 2,
              borderRadius: 1,
              background: `linear-gradient(to top, transparent 0%, ${color}${isActive ? "cc" : "50"} 50%, ${color}${isActive ? "ff" : "80"} 100%)`,
              height: Math.max(2, h),
              opacity: isActive ? 0.5 + volume * 0.5 : 0.25 + (1 - dist) * 0.35,
            }}
          />
        );
      })}
    </div>
  );
}

// ─── HUD Voice Circle (sci-fi targeting reticle) ─────────────────────────────

function HudVoiceCircle({
  status,
  onClick,
  volume,
}: {
  status: VoiceStatus;
  onClick: () => void;
  volume: number;
}) {
  const isActive = status === "listening";
  const primaryColor =
    status === "listening" ? "#22d3ee" :
    status === "speaking" ? "#818cf8" :
    status === "processing" ? "#f59e0b" :
    "#22d3ee";
  const label =
    status === "idle"
      ? "Tap to start speaking"
      : status === "listening"
      ? "Listening, tap to stop"
      : status === "processing"
      ? "Processing your request"
      : "Speaking response";

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };

  const tickCount = 24;
  const outerR = 46;
  const tickInnerR = 43;
  const tickOuterR = 47;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={isActive}
      style={{
        position: "relative",
        width: 180,
        height: 180,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        userSelect: "none",
      }}
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      {/* Outer rotating ring with SVG tick marks */}
      <svg
        style={{
          position: "absolute",
          width: 180,
          height: 180,
          animation: `spin-slow ${isActive ? 12 - volume * 4 : 25}s linear infinite`,
        }}
        viewBox="0 0 100 100"
      >
        {/* Outer dashed circle */}
        <circle
          cx="50" cy="50" r={outerR}
          fill="none" stroke={`${primaryColor}30`}
          strokeWidth="0.5" strokeDasharray="2 4"
        />
        {/* Tick marks */}
        {Array.from({ length: tickCount }).map((_, i) => {
          const angle = (i * 2 * Math.PI) / tickCount;
          const x1 = 50 + tickInnerR * Math.cos(angle);
          const y1 = 50 + tickInnerR * Math.sin(angle);
          const x2 = 50 + tickOuterR * Math.cos(angle);
          const y2 = 50 + tickOuterR * Math.sin(angle);
          const isCardinal = i % 6 === 0;
          return (
            <line
              key={i}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={isCardinal ? primaryColor : `${primaryColor}50`}
              strokeWidth={isCardinal ? 1.5 : 0.8}
              opacity={isCardinal ? 0.8 : 0.4}
            />
          );
        })}
      </svg>

      {/* Middle dashed ring */}
      <div
        style={{
          position: "absolute",
          width: isActive ? 148 + volume * 24 : 138,
          height: isActive ? 148 + volume * 24 : 138,
          borderRadius: "50%",
          border: `1.5px dashed ${primaryColor}${isActive ? "70" : "20"}`,
          animation: isActive ? `spin-reverse ${6 - volume * 2}s linear infinite` : "none",
          transition: "all 0.3s ease",
        }}
      />

      {/* Inner ring glow */}
      <div
        style={{
          position: "absolute",
          width: 116,
          height: 116,
          borderRadius: "50%",
          border: `1px solid ${primaryColor}${isActive ? "50" : "10"}`,
          background: `radial-gradient(circle, ${primaryColor}${isActive ? "12" : "03"} 0%, transparent 70%)`,
        }}
      />

      {/* Center circle — the core */}
      <div
        style={{
          width: 88,
          height: 88,
          borderRadius: "50%",
          border: `2px solid ${primaryColor}${isActive ? "bb" : "30"}`,
          background: isActive
            ? `radial-gradient(circle at 40% 35%, ${primaryColor}40 0%, ${primaryColor}15 50%, transparent 80%)`
            : `radial-gradient(circle at 40% 35%, ${primaryColor}08 0%, transparent 80%)`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
          transition: "all 0.4s ease",
          boxShadow: isActive
            ? `0 0 60px ${primaryColor}25, inset 0 0 40px ${primaryColor}10`
            : "0 0 15px #00000030",
          zIndex: 2,
        }}
      >
        <span style={{ fontSize: 28, lineHeight: 1 }}>
          {status === "listening" ? "🎤" : status === "speaking" ? "🔊" : status === "processing" ? "⏳" : "🎙️"}
        </span>
        <span
          style={{
            fontSize: 7,
            letterSpacing: "0.18em",
            color: status === "idle" ? `${primaryColor}70` : "#bbf7d0",
            fontWeight: 600,
          }}
        >
          {status === "idle"
            ? "TAP TO TALK"
            : status === "listening"
            ? "LISTENING"
            : status === "processing"
            ? "THINKING"
            : "SPEAKING"}
        </span>
      </div>
    </div>
  );
}

// ─── HUD Data Panel (floating dashboard card on the main screen) ────────────

function HudDataPanel({
  section,
  index,
  onClick,
}: {
  section: DashboardSection;
  index: number;
  onClick: (text: string) => void;
}) {
  const colors = ["#22d3ee", "#818cf8", "#f59e0b"];
  const panelColor = colors[index];
  const [hovered, setHovered] = useState(false);
  const isLeft = index === 0;
  const isBottom = index === 2;

  return (
    <div
      onClick={() => onClick(section.query)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(section.query);
        }
      }}
      aria-label={`View ${section.title} data`}
      style={{
        position: "absolute",
        ...(isBottom
          ? { left: "50%", bottom: 80, transform: "translateX(-50%)" }
          : isLeft
          ? { left: 24, top: 52 }
          : { right: 24, top: 52 }),
        border: `1px solid ${panelColor}${hovered ? "90" : "30"}`,
        borderRadius: 8,
        padding: "10px 14px",
        background: hovered ? `${panelColor}08` : `${panelColor}03`,
        cursor: "pointer",
        minWidth: isBottom ? 300 : 175,
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        transition: "all 0.3s ease",
        boxShadow: hovered
          ? `0 0 24px ${panelColor}18, inset 0 0 20px ${panelColor}05`
          : "none",
        animation: `float-up 0.5s ease ${0.15 + index * 0.12}s both`,
        fontFamily: "'DM Mono', monospace",
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 8,
          paddingBottom: 6,
          borderBottom: `1px solid ${panelColor}15`,
        }}
      >
        <div
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: panelColor,
            boxShadow: `0 0 8px ${panelColor}`,
            animation: "pulse-dot 2s ease-in-out infinite",
          }}
        />
        <span style={{ fontSize: 9, color: panelColor, letterSpacing: "0.12em", fontWeight: 600 }}>
          {section.emoji} {section.title}
        </span>
        {section.status && (
          <span style={{ fontSize: 7, color: `${panelColor}60`, marginLeft: "auto" }}>
            [{section.status.active ? "ON" : "OFF"}]
          </span>
        )}
      </div>

      {/* Metrics */}
      <div style={{ display: "flex", gap: isBottom ? 20 : 14 }}>
        {section.metrics.map((m, i) => (
          <div
            key={i}
            style={{
              animation: `float-up 0.4s ease ${0.3 + index * 0.12 + i * 0.08}s both`,
            }}
          >
            <div
              style={{
                fontSize: 7,
                color: `${panelColor}70`,
                letterSpacing: "0.08em",
                marginBottom: 2,
              }}
            >
              {m.label.toUpperCase()}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: "#c8d8d0", lineHeight: 1.2 }}>
                {m.value}
              </span>
              {m.trend === "up" && (
                <span style={{ color: "#22c55e", fontSize: 9 }}>↑</span>
              )}
              {m.trend === "down" && (
                <span style={{ color: "#ef4444", fontSize: 9 }}>↓</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── MCP Console (debug panel) ───────────────────────────────────────────

function McpConsole({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<"connecting" | "ready" | "error">("connecting");
  const [tools, setTools] = useState<Tool[]>([]);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ name: string; output: string; time: string; error?: boolean } | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  // Refresh tools on mount
  useEffect(() => {
    let cancelled = false;
    getMCPInitPromise()
      .then((ts) => {
        if (!cancelled) {
          setTools(ts);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
          // Still try to get tools
          getMCPInitPromise()
            .then((ts) => { if (!cancelled) { setTools(ts); setStatus("ready"); } })
            .catch(() => {});
        }
      });
    return () => { cancelled = true; };
  }, []);

  const callTool = async (name: string) => {
    setRunning(name);
    setResult(null);
    const start = performance.now();
    try {
      const parsedArgs: Record<string, unknown> = {};
      const toolDef = tools.find((t) => t.name === name);
      const toolPlaceholders = toolArgPlaceholders[name] ?? {};
      if (toolDef) {
        const schema = toolDef.inputSchema as JSONSchema;
        const props = schema.properties ?? {};
        for (const key of Object.keys(props)) {
          // Use the same fallback chain as the input display: args > placeholder > ""
          const value = args[`${name}:${key}`] ?? toolPlaceholders[key] ?? "";
          if (value !== "") {
            parsedArgs[key] = value;
          }
        }
      }
      const res: ToolCallResult = await getMCPClient().callTool(name, parsedArgs);
      const elapsed = ((performance.now() - start) / 1000).toFixed(2);
      const text = getToolResultText(res);
      setResult({
        name,
        output: text || JSON.stringify(res, null, 2),
        time: `${elapsed}s`,
        error: !!res.isError,
      });
    } catch (err) {
      const elapsed = ((performance.now() - start) / 1000).toFixed(2);
      setResult({
        name,
        output: err instanceof Error ? err.message : String(err),
        time: `${elapsed}s`,
        error: true,
      });
    }
    setRunning(null);
  };

  // Tool argument templates
  const toolArgPlaceholders: Record<string, Record<string, string>> = {
    read_note: { filename: "wiki/my-investments.md" },
    search_vault: { query: "investment" },
    web_search: { query: "IPL 2025" },
    save_note: { filename: "test/note.md", content: "# Test\nHello from MCP Console!" },
    write_file: { path: "output/demo.html", content: "<h1>Hello World</h1>" },
    execute_command: { command: "mkdir -p output" },
    get_time: {},
  };

  const bgColor = "#0c1410";
  const borderColor = "#1a3322";
  const accentColor = "#22c55e";

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: 440,
        background: bgColor,
        borderLeft: `1px solid ${borderColor}`,
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        fontFamily: "'DM Mono', monospace",
        color: "#c8d8d0",
        fontSize: 11,
        animation: "float-up 0.25s ease",
        boxShadow: "-4px 0 30px rgba(0,0,0,0.6)",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: `1px solid ${borderColor}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 600, color: accentColor, fontSize: 12, letterSpacing: "0.05em" }}>
            MCP CONSOLE
          </span>
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background:
                status === "ready"
                  ? accentColor
                  : status === "error"
                  ? "#ef4444"
                  : "#f59e0b",
              boxShadow: status === "ready" ? `0 0 6px ${accentColor}80` : "none",
            }}
          />
          <span style={{ fontSize: 9, color: status === "ready" ? accentColor : "#888" }}>
            {status === "ready"
              ? `${tools.length} tools`
              : status === "error"
              ? "Connection error"
              : "Connecting..."}
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: `1px solid ${borderColor}`,
            borderRadius: 6,
            color: "#666",
            cursor: "pointer",
            fontSize: 12,
            padding: "3px 8px",
            fontFamily: "inherit",
          }}
          title="Close console"
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {/* Tool list */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 9, color: "#555", letterSpacing: "0.1em", marginBottom: 8 }}>
            AVAILABLE TOOLS
          </div>
          {tools.length === 0 ? (
            <div style={{ color: "#555", fontStyle: "italic" }}>Initializing...</div>
          ) : (
            tools.map((tool) => {
              const schema = tool.inputSchema as JSONSchema;
              const props = schema.properties ?? {};
              const propKeys = Object.keys(props);
              const placeholders = toolArgPlaceholders[tool.name] ?? {};
              return (
                <div
                  key={tool.name}
                  style={{
                    border: `1px solid ${borderColor}`,
                    borderRadius: 8,
                    marginBottom: 8,
                    overflow: "hidden",
                  }}
                >
                  {/* Tool header */}
                  <div
                    style={{
                      padding: "8px 10px",
                      background: "#0a2010",
                      borderBottom: `1px solid ${borderColor}`,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <span style={{ fontWeight: 600, color: accentColor }}>{tool.name}()</span>
                      {tool.title && (
                        <span style={{ color: "#888", fontSize: 9, marginLeft: 6 }}>
                          {tool.title}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => callTool(tool.name)}
                      disabled={running !== null}
                      style={{
                        background: running === tool.name ? accentColor + "30" : accentColor + "15",
                        border: `1px solid ${running === tool.name ? accentColor : accentColor + "40"}`,
                        borderRadius: 5,
                        padding: "3px 10px",
                        color: running === tool.name ? accentColor : accentColor + "cc",
                        fontSize: 10,
                        cursor: running !== null ? "wait" : "pointer",
                        fontFamily: "inherit",
                        fontWeight: 500,
                        letterSpacing: "0.05em",
                      }}
                    >
                      {running === tool.name ? "···" : "RUN"}
                    </button>
                  </div>

                  {/* Args form */}
                  {propKeys.length > 0 && (
                    <div style={{ padding: "6px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
                      {propKeys.map((key) => (
                        <div key={key} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <span style={{ color: "#888", fontSize: 9, width: 60, flexShrink: 0 }}>
                            {key}:
                          </span>
                          <input
                            value={args[`${tool.name}:${key}`] ?? placeholders[key] ?? ""}
                            onChange={(e) =>
                              setArgs((prev) => ({
                                ...prev,
                                [`${tool.name}:${key}`]: e.target.value,
                              }))
                            }
                            placeholder={placeholders[key] ?? key}
                            style={{
                              flex: 1,
                              background: "#050a07",
                              border: `1px solid ${borderColor}`,
                              borderRadius: 4,
                              color: "#c8d8d0",
                              fontSize: 10,
                              padding: "3px 6px",
                              fontFamily: "inherit",
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Tool description */}
                  {tool.description && (
                    <div
                      style={{
                        padding: "4px 10px 7px",
                        fontSize: 9,
                        color: "#555",
                        lineHeight: 1.5,
                      }}
                    >
                      {tool.description}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Result display */}
        {result && (
          <div
            style={{
              animation: "float-up 0.2s ease",
              border: `1px solid ${result.error ? "#ef444440" : accentColor + "40"}`,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "6px 10px",
                background: result.error ? "#2a0f0f" : "#0a2010",
                borderBottom: `1px solid ${result.error ? "#ef444440" : accentColor + "40"}`,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  fontWeight: 600,
                  fontSize: 10,
                  color: result.error ? "#ef4444" : accentColor,
                }}
              >
                {result.error ? "⚠️ ERROR" : "✓ RESULT"} — {result.name}()
              </span>
              <span style={{ fontSize: 9, color: "#666" }}>{result.time}</span>
            </div>
            <pre
              style={{
                padding: "10px",
                margin: 0,
                fontSize: 10,
                lineHeight: 1.5,
                color: result.error ? "#f87171" : "#c8d8d0",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 300,
                overflowY: "auto",
              }}
            >
              {result.output}
            </pre>
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: "8px 16px",
          borderTop: `1px solid ${borderColor}`,
          fontSize: 8,
          color: "#444",
          display: "flex",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <span>MCP CONNECTED</span>
        <span>All tools run via in-memory transport</span>
      </div>
    </div>
  );
}

// ─── Dashboard Card ────────────────────────────────────────────────────────

function DashboardCard({
  section,
  index,
  onClick,
}: {
  section: DashboardSection;
  index: number;
  onClick: (text: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const accentColor = index === 0 ? "#22c55e" : index === 1 ? "#818cf8" : "#f59e0b";
  const borderColor = index === 0 ? "#14532d" : index === 1 ? "#312e81" : "#78350f";

  return (
    <div
      onClick={() => onClick(section.query)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(section.query);
        }
      }}
      aria-label={`Ask about ${section.title.toLowerCase()}`}
      style={{
        border: `1px solid ${hovered ? accentColor + "60" : borderColor}`,
        borderRadius: 12,
        padding: "12px 14px",
        background: hovered ? `${accentColor}08` : "#0a1a0f",
        cursor: "pointer",
        transition: "all 0.35s ease",
        animation: `float-up 0.5s ease ${0.1 + index * 0.14}s both`,
        transform: hovered ? "translateY(-2px)" : "translateY(0)",
        boxShadow: hovered ? `0 4px 24px ${accentColor}18` : "0 1px 4px rgba(0,0,0,0.3)",
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>{section.emoji}</span>
          <span
            style={{
              fontWeight: 600,
              fontSize: 11,
              color: accentColor,
              letterSpacing: "0.08em",
            }}
          >
            {section.title}
          </span>
        </div>
        {section.status && (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: section.status.active ? accentColor : "#555",
                boxShadow: section.status.active ? `0 0 8px ${accentColor}` : "none",
                animation: section.status.active ? "pulse-dot 2s ease-in-out infinite" : "none",
              }}
            />
            <span style={{ fontSize: 8, color: "#555", letterSpacing: "0.05em" }}>
              {section.status.label}
            </span>
          </div>
        )}
      </div>

      {/* Metrics row */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {section.metrics.map((m, mi) => (
          <div
            key={mi}
            style={{
              animation: `float-up 0.4s ease ${0.3 + index * 0.14 + mi * 0.09}s both`,
            }}
          >
            <div
              style={{
                fontSize: 8,
                color: "#555",
                letterSpacing: "0.05em",
                marginBottom: 2,
              }}
            >
              {m.label}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: "#e0e8e4", lineHeight: 1.2 }}>
                {m.value}
              </span>
              {m.trend === "up" && (
                <span style={{ color: "#22c55e", fontSize: 10 }}>↑</span>
              )}
              {m.trend === "down" && (
                <span style={{ color: "#ef4444", fontSize: 10 }}>↓</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Tool Badge ─────────────────────────────────────────────────────────────

function ToolBadge({ name }: { name: string }) {
  const colors: Record<string, string> = {
    search_vault: "#f59e0b",
    read_note: "#22c55e",
    get_time: "#6366f1",
    web_search: "#3b82f6",
    save_note: "#ec4899",
    write_file: "#f97316",
    execute_command: "#ef4444",
  };
  const icons: Record<string, string> = {
    search_vault: "🔍",
    read_note: "📖",
    get_time: "🕐",
    web_search: "🌐",
    save_note: "💾",
    write_file: "📄",
    execute_command: "💻",
  };
  const color = colors[name] || "#888";
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: `${color}15`,
        border: `1px solid ${color}30`,
        borderRadius: 6,
        padding: "3px 10px",
        margin: "4px 0",
        fontSize: 11,
        color,
        fontFamily: "monospace",
      }}
    >
      <span>{icons[name] || "⚙️"}</span>
      <span>{name}()</span>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function AIVoiceAgentDemo() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [volume, setVolume] = useState(0);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [newMsgIdx, setNewMsgIdx] = useState(-1);
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [showChat, setShowChat] = useState(false);
  const [showMcpConsole, setShowMcpConsole] = useState(false);
  const [mcpReady, setMcpReady] = useState(false);
  const [callingTool, setCallingTool] = useState<string | null>(null);
  const [iteration, setIteration] = useState(0);
  const [obsidianStatus, setObsidianStatus] = useState<"checking" | "connected" | "disconnected">("checking");
  const [memoryCount, setMemoryCount] = useState(() => getMemories().length);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesis | null>(null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number>(0);
  const currentUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const pendingRef = useRef(false);

  // Keep messagesRef in sync
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // ── MCP Initialization ──────────────────────────────────────────────────

  const mcpReadyRef = useRef(false);

  useEffect(() => {
    getMCPInitPromise()
      .then(() => {
        mcpReadyRef.current = true;
        setMcpReady(true);
      })
      .catch((err) => {
        console.error("MCP init failed:", err);
        // Mark ready even on failure — queryAI will run without tools
        mcpReadyRef.current = true;
        setMcpReady(true);
      });
  }, []);

  // ── Check support & cache voices ─────────────────────────────────────────

  useEffect(() => {
    const hasSpeechRecognition =
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
    const hasSpeechSynthesis =
      typeof window !== "undefined" && "speechSynthesis" in window;
    if (!hasSpeechRecognition || !hasSpeechSynthesis) {
      setVoiceSupported(false);
    }
    synthRef.current = window.speechSynthesis;

    const loadVoices = () => {
      voicesRef.current = synthRef.current?.getVoices() || [];
    };
    loadVoices();
    if (synthRef.current) {
      synthRef.current.onvoiceschanged = loadVoices;
    }
    return () => {
      if (synthRef.current) {
        synthRef.current.onvoiceschanged = null;
      }
    };
  }, []);

  // ── Obsidian Health Check (polls every 15s) ───────────────────────────────

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const res = await checkObsidianStatus();
        if (!cancelled) {
          setObsidianStatus(res.ok ? "connected" : "disconnected");
        }
      } catch {
        if (!cancelled) setObsidianStatus("disconnected");
      }
    };

    // Initial check
    check();

    // Poll every 15 seconds
    const interval = setInterval(check, 15_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // ── Greeting ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const greet: ChatMessage = {
      role: "assistant",
      text: "Hey Sid. Voice agent online. Tap the mic and ask me anything.",
      time: new Date().toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
    };
    setMessages([greet]);
    setNewMsgIdx(0);
  }, []);

  // ── Scroll to bottom ─────────────────────────────────────────────────────

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // ── Volume analysis from mic ─────────────────────────────────────────────

  const startVolumeAnalysis = useCallback(async (stream: MediaStream) => {
    try {
      const audioCtx = new AudioContext();
      audioContextRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const updateVolume = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const value = (dataArray[i] - 128) / 128;
          sum += value * value;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        setVolume(Math.min(rms * 3, 1));
        animationFrameRef.current = requestAnimationFrame(updateVolume);
      };
      updateVolume();
    } catch {
      // Audio context not required for functionality
    }
  }, []);

  const stopVolumeAnalysis = useCallback(() => {
    cancelAnimationFrame(animationFrameRef.current);
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setVolume(0);
  }, []);

  // ── Speech Recognition ───────────────────────────────────────────────────

  const startListening = useCallback(() => {
    if (!voiceSupported) return;

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: any) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      if (final) setTranscript((prev) => prev + final);
      setInterimTranscript(interim);
    };

    recognition.onerror = () => {
      setVoiceStatus("idle");
      setInterimTranscript("");
      stopVolumeAnalysis();
    };

    recognition.onend = () => {
      setInterimTranscript("");
      setTranscript((prev) => {
        const text = prev.trim();
        if (text) {
          setTimeout(() => queryAICall.current?.(text, true), 0);
        }
        return "";
      });
      setVoiceStatus("idle");
      stopVolumeAnalysis();
    };

    recognitionRef.current = recognition;

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        mediaStreamRef.current = stream;
        startVolumeAnalysis(stream);
      })
      .catch(() => {});

    recognition.start();
    setVoiceStatus("listening");
    setTranscript("");
    setInterimTranscript("");
  }, [voiceSupported, stopVolumeAnalysis, startVolumeAnalysis]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Already stopped
      }
      recognitionRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    stopVolumeAnalysis();
    setVoiceStatus("idle");
    setInterimTranscript("");
  }, [stopVolumeAnalysis]);

  const toggleVoice = useCallback(() => {
    if (voiceStatus === "listening") {
      stopListening();
    } else {
      if (synthRef.current) {
        synthRef.current.cancel();
      }
      setVoiceStatus("idle");
      setTimeout(() => startListening(), 100);
    }
  }, [voiceStatus, startListening, stopListening]);

  // ── Text-to-Speech ───────────────────────────────────────────────────────

  const speakText = useCallback(
    (text: string): Promise<void> => {
      return new Promise((resolve) => {
        if (!synthRef.current || !voiceEnabled) {
          resolve();
          return;
        }

        synthRef.current.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.95;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        const voices = voicesRef.current;
        const preferredVoice =
          voices.find((v) => v.name.includes("Google UK English Female")) ||
          voices.find((v) => v.name.includes("Samantha")) ||
          voices.find((v) => v.lang.startsWith("en")) ||
          voices[0];
        if (preferredVoice) utterance.voice = preferredVoice;

        currentUtteranceRef.current = utterance;
        setVoiceStatus("speaking");

        utterance.onend = () => {
          currentUtteranceRef.current = null;
          setVoiceStatus("idle");
          resolve();
        };
        utterance.onerror = () => {
          currentUtteranceRef.current = null;
          setVoiceStatus("idle");
          resolve();
        };

        synthRef.current.speak(utterance);
      });
    },
    [voiceEnabled]
  );

  const cancelSpeech = useCallback(() => {
    if (synthRef.current) {
      synthRef.current.cancel();
    }
    currentUtteranceRef.current = null;
    setVoiceStatus("idle");
  }, []);

  // ── Core AI Query (with MCP tool calling) ───────────────────────────────

  // Encapsulate queryAI in a ref so the voice onend handler always gets the latest version
  const queryAICall = useRef<((text: string, isVoice: boolean) => Promise<void>) | undefined>(undefined);

  const queryAI = useCallback(
    async (text: string, _isVoiceInput: boolean) => {
      if (!text.trim() || pendingRef.current) return;

      // Wait up to 2s for MCP to initialise; then proceed (tools may be empty)
      if (!mcpReadyRef.current) {
        await new Promise((r) => setTimeout(r, 2000));
      }

      pendingRef.current = true;

      const userMsg: ChatMessage = {
        role: "user",
        text: text.trim(),
        time: new Date().toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
      };

      setMessages((prev) => [...prev, userMsg]);
      setLoading(true);
      setVoiceStatus("processing");

      try {
        const history = messagesRef.current.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.text,
        }));

        // ── Retrieve relevant past memories ─────────────────────────
        const relevantMemories = searchMemories(text, 5);
        const memoryContext = formatMemoriesForPrompt(relevantMemories);
        const systemPrompt = buildSystemPrompt(memoryContext);
        const toolsForAPI = buildToolsForAPI();
        const MAX_ITERATIONS = 25;

        // Build conversation messages (system + history + current user message)
        const messages: Array<Record<string, unknown>> = [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content: text },
        ];

        let finalReply = "";
        const toolsUsed: { name: string; args: Record<string, unknown> }[] = [];
        let iter = 0;

        // ── ReAct Loop: call LLM + execute tools until we get a text answer ──
        for (; iter < MAX_ITERATIONS; iter++) {
          setIteration(iter + 1);

          const body: Record<string, unknown> = {
            model: "meta/llama-3.1-70b-instruct",
            max_tokens: 800,
            temperature: 0.5,
            messages,
          };
          if (toolsForAPI.length > 0) {
            body.tools = toolsForAPI;
            body.tool_choice = "auto";
          }

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 60_000);
          let res: Response;
          try {
            res = await fetch("/api/nvidia/v1/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${import.meta.env.VITE_NVIDIA_API_KEY}`,
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeout);
          }

          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error?.message || `API error: ${res.status}`);
          }

          const choice = data.choices?.[0]?.message;
          const content = choice?.content ?? "";
          const toolCalls: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }> = choice?.tool_calls ?? [];

          // No tool calls → this is the final answer
          if (toolCalls.length === 0) {
            finalReply = content;
            break;
          }

          // ── Execute tool calls ──
          // First push the assistant message with tool_calls to maintain conversation state
          messages.push({ role: "assistant", content: null, tool_calls: toolCalls });

          for (const tc of toolCalls) {
            if (tc.type !== "function") continue;
            const fnName = tc.function.name;
            let fnArgs: Record<string, unknown> = {};
            try {
              fnArgs = JSON.parse(tc.function.arguments);
            } catch {
              fnArgs = {};
            }

            setCallingTool(fnName);
            let textResult = "";
            try {
              const result: ToolCallResult = await getMCPClient().callTool(fnName, fnArgs);
              textResult = getToolResultText(result);
            } catch (toolErr) {
              textResult = `Error calling ${fnName}: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`;
            }

            messages.push({ role: "tool", tool_call_id: tc.id, content: textResult });
            toolsUsed.push({ name: fnName, args: fnArgs });
          }
          setCallingTool(null);
          // Continue loop — next iteration sends updated messages back to LLM
        }

        setCallingTool(null);
        setIteration(0);

        // If we hit max iterations without a final answer, provide a default response
        if (!finalReply) {
          finalReply = "I've completed the task. Let me know if you need anything else.";
        }

        finalReply = finalReply.trim() || "Got it.";

        const assistantMsg: ChatMessage = {
          role: "assistant",
          text: finalReply,
          tools: toolsUsed.length > 0 ? toolsUsed : undefined,
          time: new Date().toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
        };

        setMessages((prev) => {
          setNewMsgIdx(prev.length);
          return [...prev, assistantMsg];
        });

        setLoading(false);
        pendingRef.current = false;

        // ── Save to memory ──────────────────────────────────────────
        const toolNames = toolsUsed.map((t) => t.name);
        const memorySummary = summarizeInteraction(text, finalReply, toolNames);
        saveMemory({ userMessage: text, agentResponse: finalReply, toolsUsed: toolNames, summary: memorySummary });
        setMemoryCount(getMemories().length);

        // Only speak the final answer (not intermediate tool steps)
        if (voiceEnabled && iter < MAX_ITERATIONS) {
          await speakText(finalReply);
        }
      } catch (err) {
        const errorText =
          err instanceof Error
            ? `Error: ${err.message}`
            : "Connection error. Are you offline?";
        const fallbackMsg: ChatMessage = {
          role: "assistant",
          text: errorText,
          time: new Date().toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
        };
        setMessages((prev) => {
          setNewMsgIdx(prev.length);
          return [...prev, fallbackMsg];
        });
        setLoading(false);
        pendingRef.current = false;
        setVoiceStatus("idle");
        setCallingTool(null);
        setIteration(0);

        // ── Save error to memory too (so agent learns what broke) ────
        const errSummary = summarizeInteraction(text, errorText, []);
        saveMemory({ userMessage: text, agentResponse: errorText, toolsUsed: [], summary: errSummary });
        setMemoryCount(getMemories().length);

        if (voiceEnabled) {
          await speakText(errorText);
        }
      }
    },
    [voiceEnabled, speakText]
  );

  // Update the ref so setTimeout callbacks get the latest queryAI
  queryAICall.current = queryAI;

  // ── Send text message ────────────────────────────────────────────────────

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || pendingRef.current) return;
      setInput("");

      if (synthRef.current) {
        synthRef.current.cancel();
      }

      await queryAI(text, false);
    },
    [queryAI]
  );

  // ── Cleanup on unmount ───────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      stopListening();
      cancelSpeech();
    };
  }, [stopListening, cancelSpeech]);

  // ── Render ───────────────────────────────────────────────────────────────

  const HUD_PRIMARY = "#22d3ee";

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#050a07",
        fontFamily: "'DM Mono', 'Courier New', monospace",
        color: "#e0e8e4",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Bebas+Neue&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-thumb { background: #1a3322; border-radius: 2px; }
        @keyframes bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-6px); opacity: 1; }
        }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes float-up {
          0% { opacity: 0; transform: translateY(10px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.85); }
        }
        @keyframes spin-slow {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes spin-reverse {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(-360deg); }
        }
        @keyframes scan-line {
          0% { top: 0; opacity: 0; }
          10% { opacity: 0.8; }
          90% { opacity: 0.8; }
          100% { top: 100%; opacity: 0; }
        }
        @keyframes hud-grid {
          0% { transform: translateY(0); }
          100% { transform: translateY(24px); }
        }
        @keyframes glitch {
          0%, 90%, 100% { opacity: 1; transform: translateX(0); }
          92% { opacity: 0.7; transform: translateX(-2px); }
          94% { opacity: 0.8; transform: translateX(2px); }
          96% { opacity: 0.9; transform: translateX(-1px); }
        }
        .blink { animation: blink 1s step-end infinite; }
        textarea { resize: none; }
        textarea:focus { outline: none; }
      `}</style>

      {/* ── Background HUD Grid ─────────────────────────────────────────── */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          zIndex: 0,
          overflow: "hidden",
        }}
      >
        {/* Subtle grid */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: `
              linear-gradient(rgba(34,211,238,0.03) 1px, transparent 1px),
              linear-gradient(90deg, rgba(34,211,238,0.03) 1px, transparent 1px)
            `,
            backgroundSize: "40px 40px",
            animation: "hud-grid 4s linear infinite",
          }}
        />
        {/* Vignette */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(ellipse at 50% 50%, transparent 40%, rgba(5,10,7,0.8) 100%)",
          }}
        />
      </div>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div
        style={{
          padding: "14px 20px",
          borderBottom: "1px solid #0d2018",
          background: "#050a07",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          position: "relative",
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              border: `1px solid ${HUD_PRIMARY}30`,
              background: `${HUD_PRIMARY}08`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 16,
              transition: "all 0.4s ease",
            }}
          >
            {voiceStatus === "listening" ? "🎤" : voiceStatus === "speaking" ? "🔊" : "🎙️"}
          </div>
          <div>
            <div
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 13,
                letterSpacing: "0.15em",
                color: HUD_PRIMARY,
                fontWeight: 500,
              }}
            >
              {`[SYS]`} AURA
            </div>
            <div style={{ fontSize: 9, color: `${HUD_PRIMARY}50`, letterSpacing: "0.1em" }}>
              {voiceStatus === "listening"
                ? "COM: LISTENING"
                : voiceStatus === "speaking"
                ? "COM: SPEAKING"
                : voiceStatus === "processing"
                ? "COM: PROCESSING"
                : mcpReady
                ? "COM: STANDBY"
                : "COM: INITIALIZING MCP..."}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            onClick={() => setVoiceEnabled(!voiceEnabled)}
            title={voiceEnabled ? "Voice responses on" : "Voice responses off"}
            style={{
              background: "transparent",
              border: `1px solid ${voiceEnabled ? `${HUD_PRIMARY}40` : "#222"}`,
              borderRadius: 6,
              padding: "5px 9px",
              color: voiceEnabled ? HUD_PRIMARY : "#555",
              fontSize: 10,
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "all 0.2s",
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <span>{voiceEnabled ? "🔊" : "🔇"}</span>
            <span style={{ letterSpacing: "0.08em" }}>{voiceEnabled ? "VOICE ON" : "MUTED"}</span>
          </button>
          <button
            onClick={() => setShowMcpConsole(!showMcpConsole)}
            title={showMcpConsole ? "Hide MCP Console" : "Show MCP Console"}
            style={{
              background: "transparent",
              border: `1px solid ${showMcpConsole ? `${HUD_PRIMARY}40` : "#222"}`,
              borderRadius: 6,
              padding: "5px 9px",
              color: showMcpConsole ? HUD_PRIMARY : "#555",
              fontSize: 10,
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "all 0.2s",
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <span style={{ fontSize: 11 }}>🔧</span>
            <span style={{ letterSpacing: "0.08em" }}>MCP</span>
          </button>
          <button
            onClick={() => setShowChat(!showChat)}
            title={showChat ? "Hide chat" : "Show chat"}
            style={{
              background: "transparent",
              border: `1px solid ${showChat ? `${HUD_PRIMARY}40` : "#222"}`,
              borderRadius: 6,
              padding: "5px 9px",
              color: showChat ? HUD_PRIMARY : "#555",
              fontSize: 10,
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "all 0.2s",
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <span style={{ fontSize: 11 }}>💬</span>
            <span style={{ letterSpacing: "0.08em" }}>CHAT</span>
          </button>
        </div>
      </div>

      {/* ── Main Content ────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative", zIndex: 1 }}>
        {/* Voice Area — HUD Dashboard */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
            position: "relative",
          }}
        >
          {/* ── HUD Corner Brackets ─────────────────────────────────── */}
          {/* Top-left */}
          <div style={{ position: "absolute", top: 12, left: 12, width: 28, height: 28, pointerEvents: "none" }}>
            <div style={{ position: "absolute", top: 0, left: 0, width: 18, height: 1, background: `${HUD_PRIMARY}40` }} />
            <div style={{ position: "absolute", top: 0, left: 0, width: 1, height: 18, background: `${HUD_PRIMARY}40` }} />
          </div>
          {/* Top-right */}
          <div style={{ position: "absolute", top: 12, right: 12, width: 28, height: 28, pointerEvents: "none" }}>
            <div style={{ position: "absolute", top: 0, right: 0, width: 18, height: 1, background: `${HUD_PRIMARY}40` }} />
            <div style={{ position: "absolute", top: 0, right: 0, width: 1, height: 18, background: `${HUD_PRIMARY}40` }} />
          </div>
          {/* Bottom-left */}
          <div style={{ position: "absolute", bottom: 12, left: 12, width: 28, height: 28, pointerEvents: "none" }}>
            <div style={{ position: "absolute", bottom: 0, left: 0, width: 18, height: 1, background: `${HUD_PRIMARY}40` }} />
            <div style={{ position: "absolute", bottom: 0, left: 0, width: 1, height: 18, background: `${HUD_PRIMARY}40` }} />
          </div>
          {/* Bottom-right */}
          <div style={{ position: "absolute", bottom: 12, right: 12, width: 28, height: 28, pointerEvents: "none" }}>
            <div style={{ position: "absolute", bottom: 0, right: 0, width: 18, height: 1, background: `${HUD_PRIMARY}40` }} />
            <div style={{ position: "absolute", bottom: 0, right: 0, width: 1, height: 18, background: `${HUD_PRIMARY}40` }} />
          </div>

          {/* ── Top status bar ─────────────────────────────────────── */}
          <div
            style={{
              position: "absolute",
              top: 12,
              left: "50%",
              transform: "translateX(-50%)",
              display: "flex",
              alignItems: "center",
              gap: 16,
              pointerEvents: "none",
              animation: "float-up 0.6s ease",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 6px #22c55e", animation: "pulse-dot 2s ease-in-out infinite" }} />
              <span style={{ fontSize: 8, color: `${HUD_PRIMARY}60`, letterSpacing: "0.1em" }}>SYS: ONLINE</span>
            </div>
            <div style={{ width: 1, height: 10, background: `${HUD_PRIMARY}20` }} />
            <span style={{ fontSize: 8, color: `${HUD_PRIMARY}60`, letterSpacing: "0.1em" }}>
              MCP: {mcpReady ? "CONNECTED" : "INIT"}
            </span>
            <div style={{ width: 1, height: 10, background: `${HUD_PRIMARY}20` }} />
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background:
                    obsidianStatus === "connected"
                      ? "#22c55e"
                      : obsidianStatus === "disconnected"
                      ? "#ef4444"
                      : "#f59e0b",
                  boxShadow:
                    obsidianStatus === "connected"
                      ? "0 0 6px #22c55e"
                      : obsidianStatus === "disconnected"
                      ? "0 0 6px #ef4444"
                      : "0 0 6px #f59e0b",
                  animation:
                    obsidianStatus === "checking"
                      ? "pulse-dot 1s ease-in-out infinite"
                      : obsidianStatus === "connected"
                      ? "pulse-dot 2s ease-in-out infinite"
                      : "none",
                }}
              />
              <span style={{ fontSize: 8, color: `${HUD_PRIMARY}60`, letterSpacing: "0.1em" }}>
                VAULT: {obsidianStatus === "connected" ? "LINKED" : obsidianStatus === "disconnected" ? "OFFLINE" : "SCAN"}
              </span>
            </div>
            <div style={{ width: 1, height: 10, background: `${HUD_PRIMARY}20` }} />
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 8, color: `${HUD_PRIMARY}50`, letterSpacing: "0.1em" }}>
                🧠 {memoryCount}
              </span>
            </div>
            <div style={{ width: 1, height: 10, background: `${HUD_PRIMARY}20` }} />
            <span style={{ fontSize: 8, color: `${HUD_PRIMARY}40`, letterSpacing: "0.1em" }}>
              {voiceStatus === "idle" ? "IDLE" : voiceStatus === "listening" ? "RECEIVING" : voiceStatus === "processing" ? "ANALYZING" : "TRANSMITTING"}
            </span>
          </div>

          {/* ── HUD Data Panels (floating dashboard cards) ─────────── */}
          {DASHBOARD_SECTIONS.map((section, i) => (
            <HudDataPanel key={i} section={section} index={i} onClick={sendMessage} />
          ))}

          {/* ── Center: Voice Circle ───────────────────────────────── */}
          <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center" }}>
            {voiceStatus === "idle" && messages.length <= 1 && (
              <div
                style={{
                  fontSize: 8,
                  color: `${HUD_PRIMARY}50`,
                  letterSpacing: "0.18em",
                  marginBottom: 16,
                  animation: "glitch 4s ease-in-out infinite",
                }}
              >
                &gt; TAP CORE TO INITIATE COM
              </div>
            )}
            <HudVoiceCircle status={voiceStatus} onClick={toggleVoice} volume={volume} />
          </div>

          {/* ── Bottom: Continuous Waveform ────────────────────────── */}
          <div
            style={{
              position: "absolute",
              bottom: 60,
              left: "10%",
              right: "10%",
              width: "80%",
              maxWidth: 560,
            }}
          >
            <HudWaveform isActive={voiceStatus === "listening"} volume={volume} />
          </div>

          {/* ── Scanning line (slow sweep) ─────────────────────────── */}
          {voiceStatus === "idle" && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                height: 1,
                background: `linear-gradient(90deg, transparent, ${HUD_PRIMARY}10, ${HUD_PRIMARY}30, ${HUD_PRIMARY}10, transparent)`,
                animation: "scan-line 6s ease-in-out infinite",
                pointerEvents: "none",
              }}
            />
          )}

          {/* ── Transcript overlay ─────────────────────────────────── */}
          {(transcript || interimTranscript) && voiceStatus === "listening" && (
            <div
              aria-live="polite"
              aria-atomic="true"
              style={{
                position: "absolute",
                bottom: 120,
                textAlign: "center",
                maxWidth: 480,
                animation: "float-up 0.3s ease",
              }}
            >
              <div style={{ fontSize: 8, color: `${HUD_PRIMARY}60`, letterSpacing: "0.12em", marginBottom: 6 }}>
                &gt; INCOMING SIGNAL
              </div>
              <div style={{ fontSize: 14, color: "#e0e8e4", lineHeight: 1.6 }}>
                {transcript}
                <span style={{ color: `${HUD_PRIMARY}80` }}>{interimTranscript}</span>
                <span className="blink" style={{ color: HUD_PRIMARY }}>
                  {" "}▋
                </span>
              </div>
            </div>
          )}

          {/* ── Processing indicator ───────────────────────────────── */}
          {voiceStatus === "processing" && (
            <div
              role="status"
              aria-label={callingTool ? `Calling tool: ${callingTool}` : "Processing your request"}
              style={{
                position: "absolute",
                bottom: 120,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 10,
                animation: "float-up 0.3s ease",
              }}
            >
              <div style={{ display: "flex", gap: 6 }}>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: callingTool ? "#22d3ee" : "#f59e0b",
                      animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
                    }}
                  />
                ))}
              </div>
              <div style={{ fontSize: 8, color: `${HUD_PRIMARY}60`, letterSpacing: "0.12em" }}>
                {callingTool ? (
                  <>
                    <span style={{ color: "#22d3ee", fontWeight: 600 }}>⟐ {callingTool}()</span>
                    <span style={{ color: `${HUD_PRIMARY}40` }}> — STEP {iteration}/25</span>
                  </>
                ) : iteration > 0 ? (
                  <>&gt; ANALYZING — STEP {iteration}/25</>
                ) : (
                  <>&gt; ANALYZING</>
                )}
              </div>
            </div>
          )}

          {/* ── Speaking / Stop button ─────────────────────────────── */}
          {voiceStatus === "speaking" && (
            <div
              style={{
                position: "absolute",
                bottom: 120,
                animation: "float-up 0.3s ease",
                textAlign: "center",
              }}
            >
              <button
                onClick={cancelSpeech}
                style={{
                  background: "transparent",
                  border: `1px solid ${HUD_PRIMARY}40`,
                  borderRadius: 4,
                  padding: "5px 14px",
                  color: HUD_PRIMARY,
                  fontSize: 9,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  letterSpacing: "0.12em",
                  transition: "all 0.2s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = HUD_PRIMARY;
                  e.currentTarget.style.background = `${HUD_PRIMARY}10`;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = `${HUD_PRIMARY}40`;
                  e.currentTarget.style.background = "transparent";
                }}
              >
                ⏹ ABORT TRANSMISSION
              </button>
            </div>
          )}

          {/* ── Voice unsupported warning ──────────────────────────── */}
          {!voiceSupported && (
            <div
              role="alert"
              style={{
                position: "absolute",
                bottom: 120,
                padding: "6px 12px",
                background: "#2a0f0f",
                border: "1px solid #5a2020",
                color: "#f87171",
                fontSize: 9,
                textAlign: "center",
              }}
            >
              Voice not supported. Use Chrome or Edge.
            </div>
          )}
        </div>

        {/* ── Chat Sidebar ───────────────────────────────────────────────── */}
        {showChat && (
          <div
            style={{
              width: 380,
              borderLeft: "1px solid #0d2018",
              display: "flex",
              flexDirection: "column",
              background: "#080e0a",
              animation: "float-up 0.3s ease",
              position: "relative",
              zIndex: 5,
            }}
          >
            <div style={{ flex: 1, overflowY: "auto", padding: "16px" }}>
              {messages.length <= 1 && (
                <div style={{ marginBottom: 20 }}>
                  <div
                    style={{
                      fontSize: 9,
                      color: `${HUD_PRIMARY}60`,
                      letterSpacing: "0.12em",
                      marginBottom: 14,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span>📊</span>
                    <span>YOUR DASHBOARDS</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {DASHBOARD_SECTIONS.map((section, i) => (
                      <DashboardCard key={i} section={section} index={i} onClick={sendMessage} />
                    ))}
                  </div>
                </div>
              )}

              {messages.map((msg, i) => (
                <div
                  key={i}
                  style={{
                    animation: i === newMsgIdx ? "float-up 0.4s ease" : "none",
                    marginBottom: 16,
                    display: "flex",
                    flexDirection: msg.role === "user" ? "row-reverse" : "row",
                    gap: 10,
                    alignItems: "flex-start",
                  }}
                >
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background:
                        msg.role === "user"
                          ? "linear-gradient(135deg, #4338ca, #7c3aed)"
                          : "linear-gradient(135deg, #065f46, #047857)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#fff",
                    }}
                  >
                    {msg.role === "user" ? "S" : "🎙️"}
                  </div>

                  <div style={{ maxWidth: "80%", minWidth: 40 }}>
                    <div
                      style={{
                        fontSize: 9,
                        color: "#444",
                        letterSpacing: "0.1em",
                        marginBottom: 4,
                        textAlign: msg.role === "user" ? "right" : "left",
                      }}
                    >
                      {msg.role === "user" ? "SID" : "VOICE AGENT"}
                    </div>

                    {msg.role === "assistant" && msg.tools && msg.tools.length > 0 && (
                      <div style={{ marginBottom: 6 }}>
                        {msg.tools.map((t, ti) => (
                          <ToolBadge key={ti} name={t.name} />
                        ))}
                      </div>
                    )}

                    <div
                      style={{
                        background: msg.role === "user" ? "#1e1b4b" : "#0f1a14",
                        border: `1px solid ${msg.role === "user" ? "#312e81" : "#14532d"}`,
                        borderRadius: msg.role === "user" ? "12px 4px 12px 12px" : "4px 12px 12px 12px",
                        padding: "10px 14px",
                        fontSize: 12,
                        color: "#e8e8f0",
                        lineHeight: 1.6,
                      }}
                    >
                      {msg.text}
                    </div>

                    <div
                      style={{
                        fontSize: 9,
                        color: "#333",
                        marginTop: 3,
                        textAlign: msg.role === "user" ? "right" : "left",
                      }}
                    >
                      {msg.time}
                    </div>
                  </div>
                </div>
              ))}

              {loading && (
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 16 }}>
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: "linear-gradient(135deg, #065f46, #047857)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 12,
                    }}
                  >
                    🎙️
                  </div>
                  <div>
                    <div style={{ fontSize: 9, color: "#444", letterSpacing: "0.1em", marginBottom: 4 }}>
                      VOICE AGENT
                    </div>
                    <div
                      style={{
                        background: "#0f1a14",
                        border: "1px solid #14532d",
                        borderRadius: "4px 12px 12px 12px",
                        padding: "10px 14px",
                        display: "flex",
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      {callingTool ? (
                        <>
                          <div
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              background: "#22d3ee",
                              boxShadow: "0 0 8px #22d3ee",
                              animation: "pulse-dot 1.2s ease-in-out infinite",
                            }}
                          />
                          <span style={{ fontSize: 10, color: "#22d3ee", fontFamily: "monospace" }}>
                            ⟐ {callingTool}()
                          </span>
                          <span style={{ fontSize: 8, color: "#888", fontFamily: "monospace" }}>
                            STEP {iteration}/25
                          </span>
                        </>
                      ) : iteration > 0 ? (
                        <>
                          <div
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              background: "#f59e0b",
                              boxShadow: "0 0 6px #f59e0b",
                              animation: "pulse-dot 1.2s ease-in-out infinite",
                            }}
                          />
                          <span style={{ fontSize: 9, color: "#f59e0b", fontFamily: "monospace" }}>
                            ANALYZING — STEP {iteration}/25
                          </span>
                        </>
                      ) : (
                        [0, 1, 2].map((i) => (
                          <div
                            key={i}
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              background: "#22c55e",
                              animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
                            }}
                          />
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>

            {/* Chat input */}
            <div style={{ padding: "10px 12px 14px", borderTop: "1px solid #0d2018" }}>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-end",
                  background: "#0a1a0f",
                  border: "1px solid #1a3322",
                  borderRadius: 12,
                  padding: "8px 12px",
                }}
              >
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage(input);
                    }
                  }}
                  placeholder="Type a message..."
                  aria-label="Type your message"
                  rows={1}
                  style={{
                    flex: 1,
                    background: "transparent",
                    border: "none",
                    color: "#e0e8e4",
                    fontSize: 12,
                    lineHeight: 1.5,
                    fontFamily: "inherit",
                    maxHeight: 80,
                    overflowY: "auto",
                  }}
                />
                <button
                  onClick={() => sendMessage(input)}
                  disabled={loading || !input.trim()}
                  aria-label="Send message"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    border: "none",
                    background: input.trim() && !loading ? "#22c55e" : "#1a3322",
                    color: input.trim() && !loading ? "#050a07" : "#2d5a3d",
                    fontSize: 14,
                    cursor: input.trim() && !loading ? "pointer" : "default",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "all 0.2s",
                    flexShrink: 0,
                  }}
                >
                  ↑
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── MCP Console Overlay ─────────────────────────────────────────── */}
      {showMcpConsole && <McpConsole onClose={() => setShowMcpConsole(false)} />}

      {/* ── Footer Bar ──────────────────────────────────────────────────── */}
      <div
        style={{
          padding: "8px 16px",
          borderTop: "1px solid #0d2018",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 8,
          color: `${HUD_PRIMARY}30`,
          letterSpacing: "0.05em",
          position: "relative",
          zIndex: 10,
          background: "#050a07",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>MY VAULT · 7 TOOLS · LLAMA 3.1 70B VIA NVIDIA</span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              color:
                obsidianStatus === "connected"
                  ? "#22c55e"
                  : obsidianStatus === "disconnected"
                  ? "#ef4444"
                  : "#f59e0b",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: "currentColor",
              }}
            />
            OBSIDIAN {obsidianStatus === "connected" ? "LINKED" : obsidianStatus === "disconnected" ? "OFFLINE" : "..."}
          </span>
          {memoryCount > 0 && (
            <button
              onClick={() => {
                if (window.confirm("Clear all stored memories? This cannot be undone.")) {
                  clearMemories();
                  setMemoryCount(0);
                }
              }}
              title="Clear all stored memories"
              style={{
                background: "transparent",
                border: "1px solid #333",
                borderRadius: 4,
                padding: "2px 8px",
                color: "#555",
                fontSize: 8,
                cursor: "pointer",
                fontFamily: "inherit",
                letterSpacing: "0.05em",
                transition: "all 0.2s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "#ef4444";
                e.currentTarget.style.color = "#ef4444";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "#333";
                e.currentTarget.style.color = "#555";
              }}
            >
              ✕ CLEAR MEM
            </button>
          )}
        </span>
        <span aria-live="polite">
          {voiceStatus === "listening"
            ? "▲ RECV"
            : voiceStatus === "processing"
            ? "⏳ PROC"
            : voiceStatus === "speaking"
            ? "▼ SEND"
            : mcpReady
            ? "◆ STANDBY"
            : "◈ MCP INIT..."}
        </span>
      </div>
    </div>
  );
}
