import { useState, useEffect, useRef } from "react";

const VAULT = {
  "wiki/sid-profile.md": `# Sid Profile
- Co-founder, Label Ethnic Vogue (Surat)
- Teacher at PP Savani University (Network Essentials IDCE2040)
- VPS: 103.194.228.56 (Ubuntu 24.04), Hermes Agent running
- Enjoys walking after dinner. Walks a lot when talking.`,

  "wiki/personal-goals-aspirations.md": `# Personal Goals
- North Star: 2,000 Instagram followers by end of 2026 (currently ~500)
- Content series: "Life with AI Agents"
- Long-term: Launch AI deployment agency
- Skills to build: video production, AI agent dev, public speaking`,

  "wiki/my-investments.md": `# My Investments
- IGIL: ₹1,00,000 invested
- Bear case: CMP ₹362, target ₹240, stress ₹180
- Rating: SELL/AVOID per own research
- Action: Monitor for ₹220-260 entry`,

  "wiki/meditation-sessions.md": `# Meditation
- Weekly Thursday 9PM-9:30PM on Google Meet
- Teacher: Archana Didi
- Regular practice, important to Sid`,

  "daily/routine.md": `# Daily Routine
- Likes walking after dinner
- Walks a lot when engaged in conversation`,

  "wiki/professional-growth-plan.md": `# Professional Growth
1. Scale labelethnicvogue.shop
2. Monetize teaching (online courses, eBooks)
3. AI & tech integration into business
4. Build network, industry influence
5. Personal brand authority in ethnic fashion + AI`,

  "output/2026-05-24 - Drinks with the Boys.md": `# Drinks with the Boys
Date: 24 May 2026
Plan: Drinks in Patiala
Shortlist: The Brew Estate, Hotel Eqbal Inn, Garden Resort DJ night
Preferred vibe: Loud party, music, DJ`,
};

const SYSTEM_PROMPT = `You are Sid's personal second brain — an intelligent assistant that knows his life intimately.

Sid is:
- Co-founder of Label Ethnic Vogue (ethnic fashion, Surat)  
- Teacher at PP Savani University
- Builder of AI agents on his VPS
- Father of two, introverted, walks after dinner
- Has goals around Instagram growth, AI agency, and personal brand

You have access to his Obsidian vault notes (provided as context).
Give SHORT, conversational answers — 2-4 sentences max. No bullet points. No markdown headers.
Speak like a trusted friend who knows everything about him.
When referencing vault data, weave it naturally — don't say "according to your notes".

VAULT CONTENTS:
${Object.entries(VAULT).map(([k,v]) => `[${k}]\n${v}`).join("\n\n")}

Available tools you can call:
- search_vault(query): search notes
- read_note(filename): read specific note  
- get_time(): current time
- web_search(query): search the web
- save_note(filename, content): save to vault

When you use a tool, show it naturally in your thinking. Keep responses voice-friendly.`;

const SUGGESTIONS = [
  "What are my goals for this year?",
  "How's my IGIL investment looking?",
  "What's my daily routine like?",
  "When is my next meditation session?",
  "What should I focus on professionally?",
  "Tell me something remarkable about me",
];

function ToolBadge({ name, args }) {
  const colors = {
    search_vault: "#f59e0b",
    read_note: "#22c55e",
    get_time: "#6366f1",
    web_search: "#3b82f6",
    save_note: "#ec4899",
  };
  const icons = {
    search_vault: "🔍",
    read_note: "📖",
    get_time: "🕐",
    web_search: "🌐",
    save_note: "💾",
  };
  const color = colors[name] || "#888";
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      background: `${color}15`, border: `1px solid ${color}30`,
      borderRadius: 6, padding: "3px 10px", margin: "4px 0",
      fontSize: 11, color: color, fontFamily: "monospace"
    }}>
      <span>{icons[name] || "⚙️"}</span>
      <span>{name}({args})</span>
    </div>
  );
}

function Message({ msg, isNew }) {
  const [visible, setVisible] = useState(false);
  const [displayedText, setDisplayedText] = useState("");
  const [toolsDone, setToolsDone] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(t);
  }, []);

  // Typewriter effect for assistant messages
  useEffect(() => {
    if (msg.role !== "assistant" || !isNew || !msg.text) return;
    // Show tools first, then typewrite text
    const delay = (msg.tools?.length || 0) * 400 + 200;
    const toolTimer = setTimeout(() => setToolsDone(true), delay);

    let i = 0;
    const textTimer = setTimeout(() => {
      const interval = setInterval(() => {
        i++;
        setDisplayedText(msg.text.slice(0, i));
        if (i >= msg.text.length) clearInterval(interval);
      }, 18);
      return () => clearInterval(interval);
    }, delay);

    return () => { clearTimeout(toolTimer); clearTimeout(textTimer); };
  }, [msg, isNew]);

  const showText = isNew ? displayedText : msg.text;
  const showTools = isNew ? toolsDone || !msg.tools?.length : true;

  return (
    <div style={{
      opacity: visible ? 1 : 0,
      transform: visible ? "translateY(0)" : "translateY(8px)",
      transition: "all 0.3s ease",
      marginBottom: 24,
      display: "flex",
      flexDirection: msg.role === "user" ? "row-reverse" : "row",
      gap: 12, alignItems: "flex-start"
    }}>
      {/* Avatar */}
      <div style={{
        width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
        background: msg.role === "user"
          ? "linear-gradient(135deg, #4338ca, #7c3aed)"
          : "linear-gradient(135deg, #065f46, #047857)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 14, fontWeight: 700, color: "#fff",
        boxShadow: msg.role === "user" ? "0 0 12px #4338ca40" : "0 0 12px #04785740"
      }}>
        {msg.role === "user" ? "S" : "🧠"}
      </div>

      <div style={{ maxWidth: "78%", minWidth: 60 }}>
        {/* Role label */}
        <div style={{
          fontSize: 10, color: "#444", letterSpacing: "0.1em",
          marginBottom: 6, textAlign: msg.role === "user" ? "right" : "left"
        }}>
          {msg.role === "user" ? "SID" : "SECOND BRAIN"}
        </div>

        {/* Tools */}
        {msg.role === "assistant" && msg.tools?.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            {msg.tools.map((t, i) => (
              <div key={i} style={{
                opacity: isNew ? (i < (toolsDone ? msg.tools.length : i + 1) ? 1 : 0) : 1,
                transition: "opacity 0.3s",
                transitionDelay: `${i * 0.3}s`
              }}>
                <ToolBadge name={t.name} args={t.args} />
              </div>
            ))}
          </div>
        )}

        {/* Message bubble */}
        <div style={{
          background: msg.role === "user" ? "#1e1b4b" : "#0f1a14",
          border: `1px solid ${msg.role === "user" ? "#312e81" : "#14532d"}`,
          borderRadius: msg.role === "user" ? "16px 4px 16px 16px" : "4px 16px 16px 16px",
          padding: "12px 16px",
          fontSize: 14, color: "#e8e8f0", lineHeight: 1.7,
        }}>
          {showText || (msg.role === "assistant" && isNew && (
            <span style={{ color: "#444" }}>
              <span className="blink">▋</span>
            </span>
          ))}
          {isNew && msg.role === "assistant" && showText && showText.length < (msg.text?.length || 0) && (
            <span style={{ color: "#22c55e" }}>▋</span>
          )}
        </div>

        <div style={{ fontSize: 10, color: "#333", marginTop: 4, textAlign: msg.role === "user" ? "right" : "left" }}>
          {msg.time}
        </div>
      </div>
    </div>
  );
}

function ThinkingDots() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 24 }}>
      <div style={{
        width: 32, height: 32, borderRadius: "50%",
        background: "linear-gradient(135deg, #065f46, #047857)",
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14
      }}>🧠</div>
      <div>
        <div style={{ fontSize: 10, color: "#444", letterSpacing: "0.1em", marginBottom: 6 }}>SECOND BRAIN</div>
        <div style={{
          background: "#0f1a14", border: "1px solid #14532d",
          borderRadius: "4px 16px 16px 16px", padding: "14px 20px",
          display: "flex", gap: 6, alignItems: "center"
        }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{
              width: 7, height: 7, borderRadius: "50%", background: "#22c55e",
              animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`
            }} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SecondBrainDemo() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [newMsgIdx, setNewMsgIdx] = useState(-1);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Greeting on mount
  useEffect(() => {
    const greet = {
      role: "assistant",
      text: "Hey Sid. Second brain online. I've loaded your vault — goals, investments, routine, everything. What's on your mind?",
      tools: [],
      time: new Date().toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })
    };
    setMessages([greet]);
    setNewMsgIdx(0);
  }, []);

  const detectTools = (userMsg) => {
    const msg = userMsg.toLowerCase();
    const tools = [];
    if (msg.includes("invest") || msg.includes("igil") || msg.includes("stock") || msg.includes("money")) {
      tools.push({ name: "read_note", args: '"wiki/my-investments.md"' });
    }
    if (msg.includes("goal") || msg.includes("dream") || msg.includes("aspir") || msg.includes("plan")) {
      tools.push({ name: "read_note", args: '"wiki/personal-goals-aspirations.md"' });
    }
    if (msg.includes("meditat") || msg.includes("thursday") || msg.includes("archana")) {
      tools.push({ name: "read_note", args: '"wiki/meditation-sessions.md"' });
    }
    if (msg.includes("routine") || msg.includes("walk") || msg.includes("daily")) {
      tools.push({ name: "read_note", args: '"daily/routine.md"' });
    }
    if (msg.includes("professional") || msg.includes("career") || msg.includes("growth") || msg.includes("teach")) {
      tools.push({ name: "read_note", args: '"wiki/professional-growth-plan.md"' });
    }
    if (msg.includes("remarkable") || msg.includes("about me") || msg.includes("who am i")) {
      tools.push({ name: "search_vault", args: '"sid identity"' });
    }
    if (msg.includes("time") || msg.includes("today") || msg.includes("date")) {
      tools.push({ name: "get_time", args: "" });
    }
    if (msg.includes("weather") || msg.includes("news") || msg.includes("current") || msg.includes("latest")) {
      tools.push({ name: "web_search", args: `"${userMsg.slice(0, 30)}"` });
    }
    if (tools.length === 0 && msg.length > 5) {
      tools.push({ name: "search_vault", args: `"${userMsg.slice(0, 20)}"` });
    }
    return tools;
  };

  const sendMessage = async (text) => {
    if (!text.trim() || loading) return;
    setInput("");

    const userMsg = {
      role: "user",
      text: text.trim(),
      time: new Date().toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })
    };

    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const tools = detectTools(text);
      const history = messages.map(m => ({
        role: m.role,
        content: m.text
      }));

      const res = await fetch("/api/nvidia/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_NVIDIA_API_KEY}`,
        },
        body: JSON.stringify({
          model: "mistralai/mistral-7b-instruct-v0.3",
          max_tokens: 1000,
          temperature: 0.5,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...history,
            { role: "user", content: text },
          ],
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || `API error: ${res.status}`);
      }
      const reply = data.choices?.[0]?.message?.content || "Sorry, couldn't process that.";

      const assistantMsg = {
        role: "assistant",
        text: reply,
        tools,
        time: new Date().toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })
      };

      setMessages(prev => {
        setNewMsgIdx(prev.length);
        return [...prev, assistantMsg];
      });
    } catch (err) {
      const errorText = err instanceof Error
        ? `API error: ${err.message}`
        : "Connection error. Are you offline?";
      setMessages(prev => {
        setNewMsgIdx(prev.length);
        return [...prev, {
          role: "assistant",
          text: errorText,
          tools: [],
          time: new Date().toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })
        }];
      });
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  return (
    <div style={{
      height: "100vh", display: "flex", flexDirection: "column",
      background: "#050a07",
      fontFamily: "'DM Mono', 'Courier New', monospace",
      color: "#e0e8e4",
    }}>
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
        .blink { animation: blink 1s step-end infinite; }
        textarea { resize: none; }
        textarea:focus { outline: none; }
      `}</style>

      {/* Header */}
      <div style={{
        padding: "16px 20px", borderBottom: "1px solid #0d2018",
        background: "#050a07",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0, zIndex: 10
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: "linear-gradient(135deg, #064e3b, #065f46)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 18, boxShadow: "0 0 20px #04785430"
          }}>🧠</div>
          <div>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 18, letterSpacing: "0.1em", color: "#4ade80" }}>
              SECOND BRAIN
            </div>
            <div style={{ fontSize: 10, color: "#2d5a3d", letterSpacing: "0.1em" }}>
              SID'S VAULT · CLAUDE SONNET 4
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 6px #22c55e" }} />
          <span style={{ fontSize: 10, color: "#22c55e" }}>ONLINE</span>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px" }}>

        {/* Suggestions (show only at start) */}
        {messages.length <= 1 && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 10, color: "#2d5a3d", letterSpacing: "0.12em", marginBottom: 10 }}>
              TRY ASKING
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {SUGGESTIONS.map((s, i) => (
                <button key={i} onClick={() => sendMessage(s)} style={{
                  background: "transparent", border: "1px solid #1a3322",
                  borderRadius: 20, padding: "6px 14px",
                  color: "#4ade8080", fontSize: 11, cursor: "pointer",
                  transition: "all 0.2s", fontFamily: "inherit"
                }}
                  onMouseEnter={e => { e.target.style.borderColor = "#4ade80"; e.target.style.color = "#4ade80"; }}
                  onMouseLeave={e => { e.target.style.borderColor = "#1a3322"; e.target.style.color = "#4ade8080"; }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <Message key={i} msg={msg} isNew={i === newMsgIdx} />
        ))}

        {loading && <ThinkingDots />}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: "12px 16px 16px",
        borderTop: "1px solid #0d2018",
        background: "#050a07"
      }}>
        <div style={{
          display: "flex", gap: 10, alignItems: "flex-end",
          background: "#0a1a0f", border: "1px solid #1a3322",
          borderRadius: 14, padding: "10px 14px",
          transition: "border-color 0.2s",
        }}
          onFocus={() => {}}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage(input);
              }
            }}
            placeholder="Ask your second brain..."
            rows={1}
            style={{
              flex: 1, background: "transparent", border: "none",
              color: "#e0e8e4", fontSize: 13, lineHeight: 1.5,
              fontFamily: "inherit", maxHeight: 100, overflowY: "auto"
            }}
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={loading || !input.trim()}
            style={{
              width: 34, height: 34, borderRadius: 10, border: "none",
              background: input.trim() && !loading ? "#22c55e" : "#1a3322",
              color: input.trim() && !loading ? "#050a07" : "#2d5a3d",
              fontSize: 16, cursor: input.trim() && !loading ? "pointer" : "default",
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "all 0.2s", flexShrink: 0,
              boxShadow: input.trim() && !loading ? "0 0 12px #22c55e40" : "none"
            }}
          >
            ↑
          </button>
        </div>
        <div style={{ fontSize: 10, color: "#1a3322", textAlign: "center", marginTop: 8 }}>
          Vault loaded · 7 notes · Mistral 7B via NVIDIA
        </div>
      </div>
    </div>
  );
}
