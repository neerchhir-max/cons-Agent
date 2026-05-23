import { useState, useRef, useEffect, useCallback } from "react";

// ─── Robust HTML extractor ────────────────────────────────────────────────────
// Strategy: ask the model to wrap HTML in a special delimiter so we never
// rely on JSON escaping of a huge HTML blob.
const CODE_START = "<<CODE_START>>";
const CODE_END   = "<<CODE_END>>";

const SYSTEM_PROMPT = `You are DevAgent, an elite AI that builds fully-functional apps, websites, dashboards, games, and tools.

RESPONSE FORMAT — follow EXACTLY:

For BUILDING or UPDATING something, reply in this structure (no markdown, no extra text):
TITLE: <title here>
DESCRIPTION: <one line description>
TECH: <comma separated tech stack>
MESSAGE: <brief message to user>
${CODE_START}
<!DOCTYPE html>
... full self-contained HTML/CSS/JS here ...
${CODE_END}

For ANSWERING a question (no code needed), reply:
ANSWER: <your detailed response here>

CRITICAL RULES:
1. HTML must be 100% complete, self-contained, and run perfectly in a sandboxed iframe
2. Embed ALL CSS in <style> tags, ALL JS in <script> tags — no external file references
3. Use CDNs from unpkg.com or cdnjs.cloudflare.com for libraries (Chart.js, Three.js, etc.)
4. Make things BEAUTIFUL — use gradients, animations, modern fonts from Google Fonts
5. Games must be fully playable with keyboard/mouse
6. Dashboards must have real interactive charts with sample data
7. NEVER use placeholder content — everything must be real and functional
8. When updating, keep ALL existing features and add the new ones
9. No markdown fences around the code — just raw HTML between the delimiters`;

function extractResponse(text) {
  // Check if it's an answer
  const answerMatch = text.match(/^ANSWER:\s*([\s\S]+)/m);
  if (answerMatch && !text.includes(CODE_START)) {
    return { type: "answer", message: answerMatch[1].trim() };
  }

  // Extract fields
  const titleMatch       = text.match(/^TITLE:\s*(.+)/m);
  const descMatch        = text.match(/^DESCRIPTION:\s*(.+)/m);
  const techMatch        = text.match(/^TECH:\s*(.+)/m);
  const msgMatch         = text.match(/^MESSAGE:\s*(.+)/m);
  const codeStart        = text.indexOf(CODE_START);
  const codeEnd          = text.indexOf(CODE_END);

  if (codeStart !== -1 && codeEnd !== -1 && codeEnd > codeStart) {
    const code = text.slice(codeStart + CODE_START.length, codeEnd).trim();
    return {
      type: "build",
      title: titleMatch?.[1]?.trim() || "Project",
      description: descMatch?.[1]?.trim() || "",
      techStack: techMatch?.[1]?.split(",").map(s => s.trim()) || [],
      message: msgMatch?.[1]?.trim() || "Built successfully!",
      code
    };
  }

  // Fallback: look for <!DOCTYPE html> or <html anywhere in text
  const htmlStart = text.search(/<!DOCTYPE html>|<html/i);
  if (htmlStart !== -1) {
    const code = text.slice(htmlStart).replace(/```[\s\S]*?```/g, s => {
      const inner = s.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
      return inner;
    });
    return {
      type: "build",
      title: titleMatch?.[1]?.trim() || "Project",
      description: descMatch?.[1]?.trim() || "",
      techStack: ["HTML", "CSS", "JavaScript"],
      message: msgMatch?.[1]?.trim() || msgMatch?.[0] || "Here's what I built!",
      code: code.trim()
    };
  }

  // Pure answer fallback
  return { type: "answer", message: text.trim() };
}

const STORAGE_KEY = "devagent-v2-projects";

export default function AIDevAgent() {
  const [input, setInput]                       = useState("");
  const [messages, setMessages]                 = useState([]);
  const [isLoading, setIsLoading]               = useState(false);
  const [currentCode, setCurrentCode]           = useState(null);
  const [currentTitle, setCurrentTitle]         = useState(null);
  const [projects, setProjects]                 = useState([]);
  const [activeProject, setActiveProject]       = useState(null);
  const [attachments, setAttachments]           = useState([]);
  const [showSidebar, setShowSidebar]           = useState(true);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [previewMode, setPreviewMode]           = useState("preview");
  const [activeTab, setActiveTab]               = useState("preview");
  const [isMobile, setIsMobile]                 = useState(false);
  const [iframeKey, setIframeKey]               = useState(0);

  const fileInputRef  = useRef(null);
  const textareaRef   = useRef(null);
  const chatEndRef    = useRef(null);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 900);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    try { const s = localStorage.getItem(STORAGE_KEY); if (s) setProjects(JSON.parse(s)); } catch {}
  }, []);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(projects)); } catch {}
  }, [projects]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // ── File attach ──────────────────────────────────────────────────────────────
  const handleFileAttach = (e) => {
    Array.from(e.target.files || []).forEach(file => {
      const reader = new FileReader();
      reader.onload = ev => setAttachments(p => [...p, {
        name: file.name, type: file.type, data: ev.target.result
      }]);
      if (file.type.startsWith("image/")) reader.readAsDataURL(file);
      else reader.readAsText(file);
    });
    e.target.value = "";
  };

  const handleLinkAttach = () => {
    const url = prompt("Paste a URL:");
    if (url?.trim()) setAttachments(p => [...p, { name: url.trim(), type: "url", data: url.trim() }]);
  };

  // ── Send message ─────────────────────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    setInput("");
    const snap = [...attachments];
    setAttachments([]);
    if (isMobile) setActiveTab("chat");

    const userMsg = { role: "user", content: text, attachments: snap, timestamp: Date.now() };
    setMessages(p => [...p, userMsg]);
    setIsLoading(true);

    // Build the prompt, inject current code for updates
    let prompt = text;
    if (currentCode) {
      prompt += `\n\n[ACTIVE PROJECT: "${currentTitle}"]\n[EXISTING CODE — preserve all features when updating]:\n${currentCode}`;
    }
    snap.forEach(a => {
      if (a.type === "url") prompt += `\n[ATTACHED URL: ${a.data}]`;
      else if (a.type.startsWith("image/")) prompt += `\n[ATTACHED IMAGE: ${a.name}]`;
      else prompt += `\n[ATTACHED FILE: ${a.name}]\n${a.data}`;
    });

    const history = [...conversationHistory, { role: "user", content: prompt }];

    try {
      const res  = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 8000,
          system: SYSTEM_PROMPT,
          messages: history
        })
      });
      const data    = await res.json();
      const rawText = (data.content || []).map(b => b.text || "").join("");
      const parsed  = extractResponse(rawText);

      setConversationHistory([...history, { role: "assistant", content: rawText }]);
      setMessages(p => [...p, { role: "assistant", parsed, timestamp: Date.now() }]);

      if (parsed.code) {
        setCurrentCode(parsed.code);
        setCurrentTitle(parsed.title || "Project");
        setIframeKey(k => k + 1);           // force iframe reload
        if (isMobile) setActiveTab("preview");

        const proj = {
          id: activeProject?.id || Date.now(),
          title: parsed.title || "Project",
          description: parsed.description || "",
          code: parsed.code,
          techStack: parsed.techStack || [],
          createdAt: activeProject?.createdAt || Date.now(),
          updatedAt: Date.now()
        };
        setActiveProject(proj);
        setProjects(p => {
          const idx = p.findIndex(x => x.id === proj.id);
          if (idx >= 0) { const n = [...p]; n[idx] = proj; return n; }
          return [proj, ...p];
        });
      }
    } catch (err) {
      setMessages(p => [...p, {
        role: "assistant",
        parsed: { type: "answer", message: `❌ Error: ${err.message}` },
        timestamp: Date.now()
      }]);
    }
    setIsLoading(false);
  }, [input, attachments, currentCode, currentTitle, conversationHistory, activeProject, isMobile]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const loadProject = (proj) => {
    setActiveProject(proj);
    setCurrentCode(proj.code);
    setCurrentTitle(proj.title);
    setConversationHistory([]);
    setIframeKey(k => k + 1);
    setMessages([{ role: "assistant", parsed: { type: "answer", message: `Loaded "${proj.title}". Ask me anything or request changes!` }, timestamp: Date.now() }]);
    if (isMobile) { setShowSidebar(false); setActiveTab("preview"); }
  };

  const newProject = () => {
    setActiveProject(null); setCurrentCode(null); setCurrentTitle(null);
    setConversationHistory([]); setMessages([]);
  };

  const copyCode    = () => currentCode && navigator.clipboard.writeText(currentCode);
  const downloadCode = () => {
    if (!currentCode) return;
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([currentCode], { type: "text/html" })),
      download: `${(currentTitle || "project").replace(/\s+/g, "-").toLowerCase()}.html`
    });
    a.click();
  };

  const quickPrompts = [
    { icon: "🎮", label: "Snake game" },
    { icon: "📊", label: "Sales dashboard with charts" },
    { icon: "🌐", label: "SaaS landing page" },
    { icon: "⏱", label: "Pomodoro timer" },
    { icon: "🧮", label: "Scientific calculator" },
    { icon: "📝", label: "Kanban board" },
    { icon: "🎨", label: "Color palette generator" },
    { icon: "🌤", label: "Weather app UI" },
    { icon: "🏪", label: "E-commerce product page" },
    { icon: "💬", label: "Real-time chat UI" },
  ];

  // ── Styles ───────────────────────────────────────────────────────────────────
  const S = {
    root: { fontFamily: "'DM Sans','Segoe UI',sans-serif", background: "#080810", color: "#e2e8f0", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" },
    header: { height: 52, background: "rgba(12,12,22,0.97)", borderBottom: "1px solid rgba(99,102,241,0.18)", display: "flex", alignItems: "center", gap: 10, padding: "0 14px", flexShrink: 0, zIndex: 60 },
    logo: { width: 30, height: 30, borderRadius: 9, background: "linear-gradient(135deg,#6366f1,#a855f7)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, boxShadow: "0 0 14px rgba(99,102,241,0.45)" },
    body: { flex: 1, display: "flex", overflow: "hidden" },
    sidebar: { width: isMobile ? "100%" : 210, background: "rgba(10,10,20,0.98)", borderRight: "1px solid rgba(99,102,241,0.12)", display: "flex", flexDirection: "column", flexShrink: 0, position: isMobile ? "absolute" : "relative", height: "100%", zIndex: isMobile ? 200 : 1, overflowY: "auto" },
    main: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 },
    splitRow: { flex: 1, display: "flex", overflow: "hidden" },
    previewPane: { flex: "1.4 1 0", display: "flex", flexDirection: "column", borderRight: "1px solid rgba(99,102,241,0.12)", background: "#0c0c18", minWidth: 0 },
    chatPane: { flex: "1 1 0", display: "flex", flexDirection: "column", background: "#080810", minWidth: 0 },
    previewBar: { height: 42, background: "rgba(10,10,20,0.9)", borderBottom: "1px solid rgba(99,102,241,0.1)", display: "flex", alignItems: "center", gap: 8, padding: "0 12px", flexShrink: 0 },
    iframe: { flex: 1, border: "none", background: "#fff", display: "block" },
    messages: { flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 },
    inputWrap: { padding: "10px 12px", borderTop: "1px solid rgba(99,102,241,0.14)", background: "rgba(10,10,20,0.95)", flexShrink: 0 },
    inputBox: { display: "flex", alignItems: "flex-end", gap: 8, background: "rgba(25,25,45,0.9)", border: "1px solid rgba(99,102,241,0.22)", borderRadius: 14, padding: "8px 10px" },
    sendBtn: (disabled) => ({ background: disabled ? "rgba(99,102,241,0.2)" : "linear-gradient(135deg,#6366f1,#a855f7)", border: "none", borderRadius: 10, width: 36, height: 36, cursor: disabled ? "default" : "pointer", flexShrink: 0, fontSize: 16, opacity: disabled ? 0.5 : 1, display: "flex", alignItems: "center", justifyContent: "center", transition: "all .2s" }),
    tag: (active) => ({ background: active ? "rgba(99,102,241,0.18)" : "none", border: active ? "1px solid rgba(99,102,241,0.4)" : "1px solid transparent", color: active ? "#a5b4fc" : "#4b5563", padding: "3px 10px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontFamily: "inherit", fontWeight: 600 }),
    projItem: (active) => ({ padding: "9px 11px", cursor: "pointer", borderRadius: 8, margin: "2px 8px", background: active ? "rgba(99,102,241,0.14)" : "transparent", borderLeft: active ? "2px solid #6366f1" : "2px solid transparent", transition: "all .15s" }),
    chip: { background: "rgba(99,102,241,0.12)", color: "#818cf8", padding: "1px 7px", borderRadius: 4, fontSize: 10 },
    iconBtn: { background: "rgba(99,102,241,0.09)", border: "1px solid rgba(99,102,241,0.2)", color: "#818cf8", width: 30, height: 30, borderRadius: 8, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" },
    attachBtn: { background: "none", border: "none", cursor: "pointer", fontSize: 16, padding: "2px 5px", color: "#4b5563", lineHeight: 1 },
  };

  const userBubble  = { maxWidth: "80%", background: "rgba(99,102,241,0.11)", border: "1px solid rgba(99,102,241,0.2)", borderRadius: "12px 12px 3px 12px", padding: "10px 14px", fontSize: 13, lineHeight: 1.6, color: "#c7d2fe" };
  const aiBubble    = { maxWidth: "82%", background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.15)", borderRadius: "12px 12px 12px 3px", padding: "10px 14px", fontSize: 13, lineHeight: 1.6, color: "#cbd5e1" };

  const mobileTabs = isMobile ? (
    <div style={{ display: "flex", background: "rgba(12,12,22,0.97)", borderBottom: "1px solid rgba(99,102,241,0.14)" }}>
      {["preview","chat"].map(t => (
        <button key={t} onClick={() => setActiveTab(t)} style={{ flex: 1, padding: "10px", background: "none", border: "none", borderBottom: activeTab === t ? "2px solid #6366f1" : "2px solid transparent", color: activeTab === t ? "#a5b4fc" : "#4b5563", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit", letterSpacing: 1, textTransform: "uppercase" }}>
          {t === "preview" ? "🖥 Preview" : "💬 Chat"}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div style={S.root}>
      {/* ── HEADER ── */}
      <header style={S.header}>
        <button onClick={() => setShowSidebar(s => !s)} style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "0 4px" }}>☰</button>
        <div style={S.logo}>⚡</div>
        <span style={{ fontWeight: 800, fontSize: 15, color: "#f1f5f9", letterSpacing: "-0.5px" }}>DevAgent <span style={{ color: "#818cf8" }}>AI</span></span>
        <div style={{ flex: 1 }} />
        {currentTitle && <div style={{ background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.25)", borderRadius: 20, padding: "3px 12px", fontSize: 11, color: "#a5b4fc", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📁 {currentTitle}</div>}
        {currentCode && <>
          <button onClick={copyCode} title="Copy code" style={S.iconBtn}>📋</button>
          <button onClick={downloadCode} title="Download HTML" style={S.iconBtn}>⬇</button>
        </>}
        <button onClick={newProject} style={{ background: "linear-gradient(135deg,#6366f1,#a855f7)", border: "none", color: "#fff", padding: "6px 14px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>+ New</button>
      </header>

      <div style={S.body}>
        {/* ── SIDEBAR ── */}
        {showSidebar && (
          <aside style={S.sidebar}>
            <div style={{ padding: "12px 12px 6px", fontSize: 10, color: "#374151", letterSpacing: 2, fontWeight: 700 }}>PROJECTS ({projects.length})</div>
            {projects.length === 0 && <div style={{ padding: "20px 12px", fontSize: 12, color: "#374151", textAlign: "center" }}>No projects yet.<br />Start building!</div>}
            {projects.map(p => (
              <div key={p.id} onClick={() => loadProject(p)} style={S.projItem(activeProject?.id === p.id)}>
                <div style={{ fontSize: 12, color: activeProject?.id === p.id ? "#a5b4fc" : "#94a3b8", fontWeight: 600, marginBottom: 2 }}>{p.title}</div>
                <div style={{ fontSize: 10, color: "#374151" }}>{new Date(p.updatedAt).toLocaleDateString()}</div>
                {p.techStack?.length > 0 && (
                  <div style={{ display: "flex", gap: 3, marginTop: 4, flexWrap: "wrap" }}>
                    {p.techStack.slice(0, 3).map(t => <span key={t} style={S.chip}>{t}</span>)}
                  </div>
                )}
              </div>
            ))}
          </aside>
        )}

        {/* ── MAIN ── */}
        <main style={S.main}>
          {mobileTabs}
          <div style={S.splitRow}>

            {/* ── PREVIEW PANE ── */}
            {(!isMobile || activeTab === "preview") && (
              <div style={isMobile ? { flex: 1, display: "flex", flexDirection: "column", background: "#0c0c18" } : S.previewPane}>
                <div style={S.previewBar}>
                  <div style={{ display: "flex", gap: 5 }}>
                    {["#ef4444","#f59e0b","#10b981"].map(c => <div key={c} style={{ width: 11, height: 11, borderRadius: "50%", background: c }} />)}
                  </div>
                  <div style={{ flex: 1, background: "rgba(99,102,241,0.07)", borderRadius: 6, padding: "3px 10px", fontSize: 11, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {currentTitle ? `preview • ${currentTitle}` : "devagent • ready"}
                  </div>
                  <button onClick={() => setPreviewMode("preview")} style={S.tag(previewMode === "preview")}>▶ App</button>
                  <button onClick={() => setPreviewMode("code")}    style={S.tag(previewMode === "code")}>{"</>"} Code</button>
                </div>

                {/* Content */}
                {!currentCode ? (
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 28, padding: 32, background: "#0c0c18" }}>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ width: 80, height: 80, borderRadius: 22, background: "linear-gradient(135deg,rgba(99,102,241,0.15),rgba(168,85,247,0.15))", border: "1px solid rgba(99,102,241,0.25)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 36, margin: "0 auto 16px", boxShadow: "0 0 50px rgba(99,102,241,0.12)" }}>⚡</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: "#f1f5f9", marginBottom: 6 }}>DevAgent AI</div>
                      <div style={{ fontSize: 13, color: "#374151", maxWidth: 340, lineHeight: 1.7 }}>Describe anything — apps, games, dashboards, websites. I'll build a fully working version instantly.</div>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", maxWidth: 480 }}>
                      {quickPrompts.map(q => (
                        <button key={q.label} onClick={() => { setInput(q.label); textareaRef.current?.focus(); if (isMobile) setActiveTab("chat"); }}
                          style={{ background: "rgba(99,102,241,0.07)", border: "1px solid rgba(99,102,241,0.18)", color: "#6b7280", padding: "7px 13px", borderRadius: 20, cursor: "pointer", fontSize: 12, fontFamily: "inherit", transition: "all .15s" }}
                          onMouseEnter={e => Object.assign(e.currentTarget.style, { borderColor: "#6366f1", color: "#a5b4fc", background: "rgba(99,102,241,0.12)" })}
                          onMouseLeave={e => Object.assign(e.currentTarget.style, { borderColor: "rgba(99,102,241,0.18)", color: "#6b7280", background: "rgba(99,102,241,0.07)" })}>
                          {q.icon} {q.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : previewMode === "preview" ? (
                  <iframe
                    key={iframeKey}
                    srcDoc={currentCode}
                    style={S.iframe}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
                    title="Live Preview"
                  />
                ) : (
                  <pre style={{ flex: 1, overflow: "auto", margin: 0, padding: 16, fontSize: 11, lineHeight: 1.65, color: "#94a3b8", background: "#080810", fontFamily: "'Fira Code',monospace" }}>
                    {currentCode}
                  </pre>
                )}
              </div>
            )}

            {/* ── CHAT PANE ── */}
            {(!isMobile || activeTab === "chat") && (
              <div style={isMobile ? { flex: 1, display: "flex", flexDirection: "column", background: "#080810" } : S.chatPane}>
                {/* Messages */}
                <div style={S.messages}>
                  {messages.length === 0 && (
                    <div style={{ textAlign: "center", padding: "48px 20px", color: "#374151" }}>
                      <div style={{ fontSize: 32, marginBottom: 10 }}>💬</div>
                      <div style={{ fontSize: 13 }}>Describe what you want to build</div>
                    </div>
                  )}
                  {messages.map((msg, i) => (
                    <div key={i} style={{ display: "flex", gap: 9, flexDirection: msg.role === "user" ? "row-reverse" : "row", alignItems: "flex-start" }}>
                      <div style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0, background: msg.role === "user" ? "linear-gradient(135deg,#6366f1,#a855f7)" : "linear-gradient(135deg,#10b981,#059669)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>
                        {msg.role === "user" ? "U" : "⚡"}
                      </div>
                      <div style={msg.role === "user" ? userBubble : aiBubble}>
                        {msg.role === "user" ? (
                          <>
                            <div style={{ whiteSpace: "pre-wrap" }}>{msg.content}</div>
                            {msg.attachments?.length > 0 && (
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                                {msg.attachments.map((a, j) => (
                                  <span key={j} style={{ background: "rgba(99,102,241,0.15)", color: "#a5b4fc", padding: "2px 8px", borderRadius: 4, fontSize: 11 }}>
                                    {a.type === "url" ? "🔗" : a.type.startsWith("image") ? "🖼" : "📄"} {a.name.length > 24 ? a.name.slice(0, 24) + "…" : a.name}
                                  </span>
                                ))}
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <div style={{ whiteSpace: "pre-wrap" }}>{msg.parsed?.message || ""}</div>
                            {msg.parsed?.code && (
                              <div style={{ marginTop: 8, background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.18)", borderRadius: 8, padding: "7px 10px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 11, color: "#10b981", fontWeight: 700 }}>✓ {msg.parsed.title}</span>
                                {msg.parsed.techStack?.map(t => <span key={t} style={{ background: "rgba(16,185,129,0.1)", color: "#34d399", padding: "1px 6px", borderRadius: 4, fontSize: 10 }}>{t}</span>)}
                              </div>
                            )}
                          </>
                        )}
                        <div style={{ fontSize: 10, color: "#374151", marginTop: 4 }}>{new Date(msg.timestamp).toLocaleTimeString()}</div>
                      </div>
                    </div>
                  ))}

                  {isLoading && (
                    <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                      <div style={{ width: 28, height: 28, borderRadius: "50%", background: "linear-gradient(135deg,#10b981,#059669)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>⚡</div>
                      <div style={{ background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.15)", borderRadius: 12, padding: "12px 16px", display: "flex", gap: 5, alignItems: "center" }}>
                        {[0,1,2].map(j => <div key={j} style={{ width: 7, height: 7, borderRadius: "50%", background: "#10b981", animation: `bounce 1.1s ${j*0.18}s ease-in-out infinite` }} />)}
                        <span style={{ fontSize: 12, color: "#10b981", marginLeft: 6 }}>Building your app…</span>
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Attachment chips */}
                {attachments.length > 0 && (
                  <div style={{ padding: "8px 12px", borderTop: "1px solid rgba(99,102,241,0.1)", display: "flex", gap: 7, flexWrap: "wrap" }}>
                    {attachments.map((a, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 8, padding: "4px 10px", fontSize: 11, color: "#a5b4fc" }}>
                        {a.type === "url" ? "🔗" : a.type.startsWith("image") ? "🖼" : "📄"} {a.name.length > 22 ? a.name.slice(0, 22) + "…" : a.name}
                        <button onClick={() => setAttachments(p => p.filter((_, j) => j !== i))} style={{ background: "none", border: "none", color: "#6366f1", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Input */}
                <div style={S.inputWrap}>
                  <div style={S.inputBox}>
                    <button onClick={() => fileInputRef.current?.click()} title="Attach file" style={S.attachBtn}>📎</button>
                    <button onClick={handleLinkAttach} title="Attach link" style={S.attachBtn}>🔗</button>
                    <input ref={fileInputRef} type="file" multiple accept="image/*,.pdf,.txt,.json,.csv,.html,.js,.css,.md" style={{ display: "none" }} onChange={handleFileAttach} />
                    <textarea
                      ref={textareaRef}
                      value={input}
                      onChange={e => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={currentCode ? "Ask about it or request changes…" : "What do you want to build?"}
                      rows={1}
                      style={{ flex: 1, background: "none", border: "none", outline: "none", color: "#e2e8f0", fontSize: 13, resize: "none", lineHeight: 1.55, fontFamily: "inherit", minHeight: 22, maxHeight: 130, overflowY: "auto" }}
                      onInput={e => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 130) + "px"; }}
                    />
                    <button onClick={sendMessage} disabled={isLoading || (!input.trim() && !attachments.length)} style={S.sendBtn(isLoading || (!input.trim() && !attachments.length))}>
                      {isLoading ? "⏳" : "↑"}
                    </button>
                  </div>
                  <div style={{ fontSize: 10, color: "#374151", marginTop: 5, textAlign: "center" }}>Enter to send · Shift+Enter newline · 📎 files · 🔗 links</div>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700;800&display=swap');
        *{box-sizing:border-box;}
        ::-webkit-scrollbar{width:4px;height:4px;}
        ::-webkit-scrollbar-thumb{background:rgba(99,102,241,0.28);border-radius:4px;}
        ::-webkit-scrollbar-track{background:transparent;}
        @keyframes bounce{0%,100%{transform:translateY(0);opacity:.35}50%{transform:translateY(-5px);opacity:1}}
      `}</style>
    </div>
  );
}
