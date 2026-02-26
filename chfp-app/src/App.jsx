import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase.js";

// ── Constants ──────────────────────────────────────────────
const LOCATIONS = ["North Coag", "South Coag", "Reaction #1", "Reaction #3", "Softened", "Finished"];
const ANALYTES = ["pH", "Alkalinity", "Calcium", "Hardness", "Conductivity", "Temperature"];
const UNITS = {
  pH: "S.U.", Alkalinity: "mg/L CaCO₃", Calcium: "mg/L CaCO₃",
  Hardness: "mg/L CaCO₃", Conductivity: "µS/cm", Temperature: "°C",
};
const DISABLED = new Set();
for (let l = 0; l < 5; l++) { DISABLED.add(`4-${l}`); DISABLED.add(`5-${l}`); }

const TEAM_PASSWORD = import.meta.env.VITE_TEAM_PASSWORD || "chfp2026";

// ── Helpers ────────────────────────────────────────────────
const fmtDate = (d) => {
  const dt = new Date(d + "T12:00:00");
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
};
const isWeekday = (d) => { const dt = new Date(d + "T12:00:00"); const day = dt.getDay(); return day !== 0 && day !== 6; };
const today = () => new Date().toISOString().split("T")[0];
const shiftDate = (d, n) => {
  const dt = new Date(d + "T12:00:00");
  dt.setDate(dt.getDate() + n);
  return dt.toISOString().split("T")[0];
};
const getEST = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "numeric", hour12: false, timeZone: "America/New_York"
  }).formatToParts(new Date());
  const h = (parts.find(p => p.type === "hour")?.value || "00").padStart(2, "0");
  const m = (parts.find(p => p.type === "minute")?.value || "00").padStart(2, "0");
  return `${h}:${m}`;
};
const emptyData = () => {
  const d = {};
  ANALYTES.forEach((a, ai) => {
    LOCATIONS.forEach((l, li) => {
      if (!DISABLED.has(`${ai}-${li}`)) d[`${a}::${l}`] = "";
    });
  });
  return d;
};
const emptyRecord = () => ({ analyst: "", sampleTime: getEST(), values: emptyData() });
const isMobile = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// ── Supabase Data Layer ────────────────────────────────────
async function loadSample(sampleDate) {
  const { data, error } = await supabase
    .from("samples")
    .select("*")
    .eq("sample_date", sampleDate)
    .maybeSingle();
  if (error) throw error;
  if (data) return { analyst: data.analyst, sampleTime: data.sample_time, values: data.values };
  return null;
}

async function saveSample(sampleDate, record) {
  const row = {
    sample_date: sampleDate,
    analyst: record.analyst,
    sample_time: record.sampleTime,
    values: record.values,
  };
  const { error } = await supabase
    .from("samples")
    .upsert(row, { onConflict: "sample_date" });
  if (error) throw error;
}

async function loadEntryLog() {
  const { data, error } = await supabase
    .from("samples")
    .select("sample_date, analyst, updated_at, values")
    .order("sample_date", { ascending: false })
    .limit(60);
  if (error) throw error;
  return (data || []).map(r => ({
    date: r.sample_date,
    analyst: r.analyst,
    savedAt: r.updated_at,
    filledCount: Object.values(r.values || {}).filter(v => v !== "").length,
  }));
}

// ── OCR ────────────────────────────────────────────────────
const OCR_SYSTEM = `You extract handwritten water quality data from a printed form photo. The form has tables for Monday, Wednesday, and Friday.
Each table: columns Analyte | North Coag | South Coag | Reaction #1 | Reaction #3 | Softened | Finished. Rows: pH, Alkalinity, Calcium, Hardness, Conductivity, Temperature. Conductivity and Temperature only at Finished.
Return ONLY valid JSON, no backticks:
{"days":[{"day":"Monday","date":"MM/DD/YYYY or empty","time":"HH:MM or empty","analyst":"name or empty","values":{"pH::North Coag":"value or empty","pH::South Coag":"","pH::Reaction #1":"","pH::Reaction #3":"","pH::Softened":"","pH::Finished":"","Alkalinity::North Coag":"","Alkalinity::South Coag":"","Alkalinity::Reaction #1":"","Alkalinity::Reaction #3":"","Alkalinity::Softened":"","Alkalinity::Finished":"","Calcium::North Coag":"","Calcium::South Coag":"","Calcium::Reaction #1":"","Calcium::Reaction #3":"","Calcium::Softened":"","Calcium::Finished":"","Hardness::North Coag":"","Hardness::South Coag":"","Hardness::Reaction #1":"","Hardness::Reaction #3":"","Hardness::Softened":"","Hardness::Finished":"","Conductivity::Finished":"","Temperature::Finished":""}}]}
Numbers only. Empty string for illegible. Include all three days.`;

async function ocrImage(base64, mediaType) {
  const resp = await fetch("/.netlify/functions/ocr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: OCR_SYSTEM,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: "Extract all handwritten data. Return only JSON." }
      ]}]
    })
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  const text = (data.content || []).map(b => b.text || "").join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ── QR Code ────────────────────────────────────────────────
function QRCode({ url, size = 200 }) {
  return <img src={`https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(url)}&margin=8`}
    alt="QR Code" width={size} height={size} style={{ borderRadius: 8 }} />;
}

// ── Password Gate ──────────────────────────────────────────
function PasswordGate({ onAuth }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState(false);
  const submit = () => {
    if (pw === TEAM_PASSWORD) {
      sessionStorage.setItem("chfp_auth", "1");
      onAuth();
    } else {
      setError(true);
      setTimeout(() => setError(false), 2000);
    }
  };
  return (
    <div style={{ minHeight: "100vh", background: "#0B1D33", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'IBM Plex Sans', -apple-system, sans-serif" }}>
      <div style={{ background: "#fff", borderRadius: 16, padding: "40px 36px", maxWidth: 380, width: "90%", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#4FC3F7", margin: "0 auto 16px" }} />
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "#1E293B", marginBottom: 4 }}>CHFP Softening Project</h1>
        <p style={{ fontSize: 13, color: "#64748B", marginBottom: 24 }}>Enter the team password to continue</p>
        <input type="password" value={pw} onChange={e => setPw(e.target.value)}
          onKeyDown={e => e.key === "Enter" && submit()}
          placeholder="Password"
          style={{
            width: "100%", padding: "10px 14px", fontSize: 15, border: `1.5px solid ${error ? "#EF4444" : "#CBD5E1"}`,
            borderRadius: 8, fontFamily: "inherit", marginBottom: 12, outline: "none",
            transition: "border-color 0.2s",
          }} />
        {error && <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 8 }}>Incorrect password</div>}
        <button onClick={submit} style={{
          width: "100%", padding: "10px", borderRadius: 8, border: "none", cursor: "pointer",
          background: "#0B1D33", color: "#fff", fontSize: 14, fontWeight: 600,
        }}>Sign In</button>
      </div>
    </div>
  );
}

// ── Mobile Upload View ─────────────────────────────────────
function MobileUploadView() {
  const [ocrStatus, setOcrStatus] = useState("idle");
  const [ocrResult, setOcrResult] = useState(null);
  const [ocrError, setOcrError] = useState("");
  const [savedDays, setSavedDays] = useState([]);
  const fileRef = useRef(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setOcrStatus("reading"); setOcrError(""); setOcrResult(null);
    try {
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.onerror = () => rej(new Error("Read failed"));
        r.readAsDataURL(file);
      });
      const result = await ocrImage(base64, file.type || "image/jpeg");
      if (result?.days?.length) { setOcrResult(result.days); setOcrStatus("picking"); }
      else { setOcrError("No data found."); setOcrStatus("error"); }
    } catch (err) { setOcrError(err.message || "Failed"); setOcrStatus("error"); }
  };

  const saveDayData = async (dayData) => {
    let targetDate = today();
    if (dayData.date) {
      const p = dayData.date.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (p) targetDate = `${p[3]}-${p[1].padStart(2,"0")}-${p[2].padStart(2,"0")}`;
    }
    const newValues = { ...emptyData() };
    for (const [k, v] of Object.entries(dayData.values || {})) { if (v && k in newValues) newValues[k] = v; }
    await saveSample(targetDate, { analyst: dayData.analyst || "", sampleTime: dayData.time || getEST(), values: newValues });
    setSavedDays(prev => [...prev, { day: dayData.day, date: targetDate }]);
  };

  return (
    <div style={{ minHeight: "100vh", background: "#F7F8FA", fontFamily: "'IBM Plex Sans', -apple-system, sans-serif" }}>
      <div style={{ background: "#0B1D33", color: "#fff", padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4FC3F7" }} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>CHFP — Upload Form</span>
        </div>
      </div>
      <div style={{ padding: "24px 20px", maxWidth: 480, margin: "0 auto" }}>
        {ocrStatus === "idle" && savedDays.length === 0 && (
          <div style={{ textAlign: "center", paddingTop: 32 }}>
            <div style={{ fontSize: 56, marginBottom: 16 }}>📋</div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: "#1E293B", marginBottom: 8 }}>Upload Data Sheet Photo</h2>
            <p style={{ fontSize: 14, color: "#64748B", marginBottom: 28, lineHeight: 1.5 }}>
              Take a photo of the completed weekly data sheet. Values will be read and saved automatically.
            </p>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handleFile} style={{ display: "none" }} />
            <button onClick={() => fileRef.current?.click()}
              style={{ padding: "14px 32px", borderRadius: 10, border: "none", cursor: "pointer", background: "#0B1D33", color: "#fff", fontSize: 16, fontWeight: 600, width: "100%", display: "inline-flex", alignItems: "center", gap: 10, justifyContent: "center" }}>
              <span style={{ fontSize: 20 }}>📷</span> Take Photo or Choose Image
            </button>
          </div>
        )}
        {ocrStatus === "idle" && savedDays.length > 0 && (
          <div style={{ textAlign: "center", paddingTop: 24 }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "#1E293B", marginBottom: 12 }}>Data Saved</h2>
            {savedDays.map((s, i) => <div key={i} style={{ fontSize: 14, color: "#334155", marginBottom: 4 }}>{s.day} → {fmtDate(s.date)}</div>)}
            <p style={{ fontSize: 13, color: "#64748B", marginTop: 16, marginBottom: 24 }}>Review imported values on the desktop app.</p>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handleFile} style={{ display: "none" }} />
            <button onClick={() => { setSavedDays([]); fileRef.current?.click(); }}
              style={{ padding: "12px 28px", borderRadius: 10, border: "1.5px solid #CBD5E1", background: "#fff", color: "#334155", fontSize: 14, fontWeight: 600, cursor: "pointer", width: "100%" }}>Upload Another</button>
          </div>
        )}
        {ocrStatus === "reading" && (
          <div style={{ textAlign: "center", paddingTop: 48 }}>
            <div style={{ fontSize: 48, marginBottom: 16, animation: "pulse 1.5s ease-in-out infinite" }}>🔍</div>
            <div style={{ fontSize: 17, fontWeight: 600, color: "#1E293B", marginBottom: 6 }}>Reading form…</div>
            <div style={{ fontSize: 14, color: "#64748B" }}>5–10 seconds</div>
            <style>{`@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }`}</style>
          </div>
        )}
        {ocrStatus === "error" && (
          <div style={{ textAlign: "center", paddingTop: 40 }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>⚠️</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#EF4444", marginBottom: 8 }}>{ocrError}</div>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handleFile} style={{ display: "none" }} />
            <button onClick={() => { setOcrStatus("idle"); fileRef.current?.click(); }}
              style={{ padding: "10px 24px", borderRadius: 8, border: "1.5px solid #CBD5E1", background: "#fff", color: "#334155", fontSize: 14, cursor: "pointer", marginTop: 12 }}>Try Again</button>
          </div>
        )}
        {ocrStatus === "picking" && ocrResult && (
          <div>
            <h3 style={{ fontSize: 17, fontWeight: 700, color: "#1E293B", marginBottom: 4 }}>Data Detected</h3>
            <p style={{ fontSize: 13, color: "#64748B", marginBottom: 16 }}>Tap each day to save.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {ocrResult.map((day, i) => {
                const vc = Object.values(day.values || {}).filter(v => v !== "").length;
                const saved = savedDays.some(s => s.day === day.day);
                return (
                  <button key={i} onClick={() => { if (!saved && vc > 0) saveDayData(day); }} disabled={vc === 0 || saved}
                    style={{ padding: "14px 16px", borderRadius: 10, border: saved ? "1.5px solid #22C55E" : "1.5px solid #E2E8F0", background: saved ? "#F0FDF4" : vc > 0 ? "#fff" : "#FAFAFA", cursor: vc > 0 && !saved ? "pointer" : "default", opacity: vc > 0 ? 1 : 0.5, textAlign: "left", fontFamily: "inherit", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 15, color: "#1E293B" }}>{saved ? "✅ " : ""}{day.day}</div>
                      <div style={{ fontSize: 12, color: "#64748B" }}>{day.date || "No date"} · {day.analyst || "No analyst"}</div>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: saved ? "#22C55E" : vc > 0 ? "#3B82F6" : "#94A3B8" }}>{saved ? "Saved" : `${vc} values`}</div>
                  </button>
                );
              })}
            </div>
            {savedDays.length > 0 && (
              <button onClick={() => { setOcrResult(null); setOcrStatus("idle"); }}
                style={{ marginTop: 16, padding: "12px 24px", borderRadius: 10, border: "none", background: "#0B1D33", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer", width: "100%" }}>Done</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────
export default function App() {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem("chfp_auth") === "1");

  if (!authed) return <PasswordGate onAuth={() => setAuthed(true)} />;
  if (isMobile()) return <MobileUploadView />;
  return <DesktopApp />;
}

// ── Desktop App ────────────────────────────────────────────
function DesktopApp() {
  const [date, setDate] = useState(today());
  const [record, setRecord] = useState(emptyRecord());
  const [status, setStatus] = useState("idle");
  const [entries, setEntries] = useState([]);
  const [view, setView] = useState("entry");
  const [loading, setLoading] = useState(true);
  const [ocrStatus, setOcrStatus] = useState("idle");
  const [ocrResult, setOcrResult] = useState(null);
  const [ocrError, setOcrError] = useState("");
  const [showQR, setShowQR] = useState(false);
  const [appUrl, setAppUrl] = useState("");
  const saveTimer = useRef(null);
  const inputRefs = useRef({});
  const fileRef = useRef(null);

  useEffect(() => { setAppUrl(window.location.href); }, []);

  // Load sample for current date
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const data = await loadSample(date);
        if (!cancelled) setRecord(data || emptyRecord());
      } catch { if (!cancelled) setRecord(emptyRecord()); }
      if (!cancelled) { setLoading(false); setStatus("idle"); }
    })();
    return () => { cancelled = true; };
  }, [date]);

  // Load entry log
  useEffect(() => {
    if (view !== "log") return;
    (async () => { try { setEntries(await loadEntryLog()); } catch { setEntries([]); } })();
  }, [view]);

  const save = useCallback(async (rec) => {
    setStatus("saving");
    try { await saveSample(date, rec); setStatus("saved"); }
    catch { setStatus("error"); }
  }, [date]);

  const handleChange = (key, value) => {
    const updated = { ...record, values: { ...record.values, [key]: value } };
    setRecord(updated);
    setStatus("idle");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(updated), 1200);
  };

  const handleMeta = (field, value) => {
    const updated = { ...record, [field]: value };
    setRecord(updated);
    setStatus("idle");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(updated), 1200);
  };

  const handleNav = (dir) => {
    let d = date;
    for (let i = 0; i < 7; i++) { d = shiftDate(d, dir); if (isWeekday(d)) { setDate(d); return; } }
  };

  const handleCellKeyDown = (e, ai, li) => {
    if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      let nai = ai, nli = li;
      const fwd = !e.shiftKey;
      while (true) {
        if (fwd) { nli++; if (nli >= LOCATIONS.length) { nli = 0; nai++; } }
        else { nli--; if (nli < 0) { nli = LOCATIONS.length - 1; nai--; } }
        if (nai < 0 || nai >= ANALYTES.length) break;
        if (!DISABLED.has(`${nai}-${nli}`)) {
          const ref = inputRefs.current[`${nai}-${nli}`];
          if (ref) { ref.focus(); ref.select(); }
          return;
        }
      }
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setOcrStatus("reading"); setOcrError(""); setOcrResult(null);
    try {
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.onerror = () => rej(new Error("Read failed"));
        r.readAsDataURL(file);
      });
      const result = await ocrImage(base64, file.type || "image/jpeg");
      if (result?.days?.length) { setOcrResult(result.days); setOcrStatus("picking"); }
      else { setOcrError("No data found."); setOcrStatus("error"); }
    } catch (err) { setOcrError(err.message || "Failed"); setOcrStatus("error"); }
  };

  const applyOcrDay = async (dayData) => {
    let targetDate = date;
    if (dayData.date) {
      const p = dayData.date.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (p) targetDate = `${p[3]}-${p[1].padStart(2,"0")}-${p[2].padStart(2,"0")}`;
    }
    const newValues = { ...emptyData() };
    for (const [k, v] of Object.entries(dayData.values || {})) { if (v && k in newValues) newValues[k] = v; }
    const newRec = { analyst: dayData.analyst || record.analyst, sampleTime: dayData.time || record.sampleTime, values: newValues };
    setDate(targetDate); setRecord(newRec);
    await saveSample(targetDate, newRec);
    setOcrResult(null); setOcrStatus("idle"); setStatus("saved");
  };

  const refreshData = async () => {
    setLoading(true);
    try { const data = await loadSample(date); setRecord(data || emptyRecord()); }
    catch { setRecord(emptyRecord()); }
    setLoading(false); setStatus("idle");
  };

  const filledCount = Object.values(record.values).filter(v => v !== "").length;
  const totalCells = Object.keys(record.values).length;

  return (
    <div style={{ minHeight: "100vh", background: "#F7F8FA", fontFamily: "'IBM Plex Sans', 'SF Pro Text', -apple-system, sans-serif" }}>
      {/* Top bar */}
      <div style={{ background: "#0B1D33", color: "#fff", padding: "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4FC3F7" }} />
          <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: 0.4 }}>CHFP Softening Project</span>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {["entry", "log"].map(v => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: "6px 16px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500,
              background: view === v ? "#1A3A5C" : "transparent", color: view === v ? "#fff" : "#8BA4BE",
            }}>{v === "entry" ? "Data Entry" : "Entry Log"}</button>
          ))}
          <button onClick={() => { sessionStorage.removeItem("chfp_auth"); window.location.reload(); }}
            style={{ marginLeft: 8, padding: "5px 12px", borderRadius: 6, border: "1px solid #334155", background: "transparent", color: "#8BA4BE", fontSize: 11, cursor: "pointer" }}>Sign Out</button>
        </div>
      </div>

      {view === "entry" ? (
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "20px 16px" }}>
          {/* Date nav + meta */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => handleNav(-1)} style={navBtn}>◄</button>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                style={{ fontSize: 14, padding: "7px 12px", border: "1.5px solid #CBD5E1", borderRadius: 8, fontFamily: "inherit", color: "#1E293B", background: "#fff" }} />
              <button onClick={() => handleNav(1)} style={navBtn}>►</button>
              <span style={{ fontSize: 15, fontWeight: 600, color: "#334155", marginLeft: 6 }}>{fmtDate(date)}</span>
              <button onClick={refreshData} title="Refresh" style={{ ...navBtn, marginLeft: 4, fontSize: 14 }}>↻</button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <label style={metaLabel}>Analyst
                <input value={record.analyst} onChange={e => handleMeta("analyst", e.target.value)} placeholder="Name" style={metaInput} />
              </label>
              <label style={metaLabel}>Sample Time
                <input type="text" value={record.sampleTime} onChange={e => handleMeta("sampleTime", e.target.value)} placeholder="HH:MM" maxLength={5} style={metaInput} />
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: status === "saved" ? "#22C55E" : status === "saving" ? "#F59E0B" : status === "error" ? "#EF4444" : "#CBD5E1" }} />
                <span style={{ fontSize: 12, color: "#94A3B8" }}>
                  {status === "saved" ? "Saved" : status === "saving" ? "Saving…" : status === "error" ? "Error" : filledCount > 0 ? "Unsaved" : "No data"}
                </span>
              </div>
            </div>
          </div>

          {/* Progress */}
          <div style={{ height: 3, background: "#E2E8F0", borderRadius: 2, marginBottom: 16, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(filledCount / totalCells) * 100}%`, background: filledCount === totalCells ? "#22C55E" : "#3B82F6", borderRadius: 2, transition: "width 0.4s ease" }} />
          </div>

          {/* Grid */}
          {loading ? <div style={{ textAlign: "center", padding: 40, color: "#94A3B8" }}>Loading…</div> : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
                <thead><tr>
                  <th style={{ ...th, width: 120, textAlign: "left", paddingLeft: 12 }}>Analyte</th>
                  {LOCATIONS.map(l => <th key={l} style={th}>{l}</th>)}
                </tr></thead>
                <tbody>
                  {ANALYTES.map((a, ai) => (
                    <tr key={a}>
                      <td style={analyteCell}><div>{a}</div><div style={{ fontSize: 10, color: "#94A3B8", fontWeight: 400 }}>{UNITS[a]}</div></td>
                      {LOCATIONS.map((l, li) => {
                        const dis = DISABLED.has(`${ai}-${li}`);
                        return (
                          <td key={l} style={{ ...td, background: dis ? "#EDEFF2" : "#fff" }}>
                            {dis ? <span style={{ color: "#B0B8C4", fontSize: 16, fontWeight: 600 }}>✕</span> : (
                              <input ref={el => { inputRefs.current[`${ai}-${li}`] = el; }}
                                type="text" inputMode="decimal"
                                value={record.values[`${a}::${l}`] || ""}
                                onChange={e => handleChange(`${a}::${l}`, e.target.value)}
                                onKeyDown={e => handleCellKeyDown(e, ai, li)}
                                onFocus={e => e.target.select()} style={cellInput} />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input ref={fileRef} type="file" accept="image/*" onChange={handleFileUpload} style={{ display: "none" }} />
              <button onClick={() => fileRef.current?.click()} disabled={ocrStatus === "reading"} style={{ ...actionBtn, opacity: ocrStatus === "reading" ? 0.6 : 1 }}>
                <span style={{ fontSize: 16 }}>📷</span> {ocrStatus === "reading" ? "Reading…" : "Upload Photo"}
              </button>
              <button onClick={() => setShowQR(true)} style={actionBtn}><span style={{ fontSize: 15 }}>⊞</span> Scan QR</button>
              {ocrStatus === "error" && <span style={{ fontSize: 12, color: "#EF4444" }}>{ocrError}</span>}
            </div>
            <button onClick={() => save(record)} style={{ padding: "8px 24px", borderRadius: 8, border: "none", cursor: "pointer", background: "#0B1D33", color: "#fff", fontSize: 13, fontWeight: 600 }}>Save Entry</button>
          </div>

          {/* QR Modal */}
          {showQR && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={() => setShowQR(false)}>
              <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: 32, maxWidth: 380, width: "90%", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
                <h3 style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 700, color: "#1E293B" }}>Mobile Upload</h3>
                <p style={{ margin: "0 0 20px", fontSize: 13, color: "#64748B", lineHeight: 1.5 }}>Scan with your phone to upload a form photo. Data saves directly to the database.</p>
                {appUrl && <QRCode url={appUrl} size={200} />}
                <p style={{ margin: "16px 0 0", fontSize: 11, color: "#94A3B8" }}>Click <strong>↻</strong> to refresh after mobile upload.</p>
                <button onClick={() => setShowQR(false)} style={{ marginTop: 16, padding: "8px 24px", borderRadius: 8, border: "1.5px solid #CBD5E1", background: "#fff", color: "#64748B", fontSize: 13, cursor: "pointer" }}>Close</button>
              </div>
            </div>
          )}

          {/* OCR picker */}
          {ocrStatus === "picking" && ocrResult && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
              <div style={{ background: "#fff", borderRadius: 12, padding: 24, maxWidth: 480, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
                <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: "#1E293B" }}>Form Data Detected</h3>
                <p style={{ margin: "0 0 16px", fontSize: 13, color: "#64748B" }}>Select which day to import.</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {ocrResult.map((day, i) => {
                    const vc = Object.values(day.values || {}).filter(v => v !== "").length;
                    return (
                      <button key={i} onClick={() => applyOcrDay(day)} disabled={vc === 0}
                        style={{ padding: "12px 16px", borderRadius: 8, border: "1.5px solid #E2E8F0", background: vc > 0 ? "#F8FAFC" : "#FAFAFA", cursor: vc > 0 ? "pointer" : "default", opacity: vc > 0 ? 1 : 0.5, textAlign: "left", fontFamily: "inherit", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div><div style={{ fontWeight: 600, fontSize: 14, color: "#1E293B" }}>{day.day}</div><div style={{ fontSize: 12, color: "#64748B" }}>{day.date || "No date"} · {day.analyst || "No analyst"}</div></div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: vc > 0 ? "#3B82F6" : "#94A3B8" }}>{vc} values</div>
                      </button>
                    );
                  })}
                </div>
                <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
                  <button onClick={() => { setOcrResult(null); setOcrStatus("idle"); }} style={{ padding: "7px 18px", borderRadius: 7, border: "1.5px solid #CBD5E1", background: "#fff", color: "#64748B", fontSize: 13, cursor: "pointer" }}>Cancel</button>
                </div>
              </div>
            </div>
          )}

          {/* Reading overlay */}
          {ocrStatus === "reading" && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(11,29,51,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
              <div style={{ background: "#fff", borderRadius: 12, padding: "32px 40px", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#1E293B", marginBottom: 4 }}>Reading form…</div>
                <div style={{ fontSize: 13, color: "#64748B" }}>5–10 seconds</div>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Entry Log */
        <div style={{ maxWidth: 800, margin: "0 auto", padding: "24px 16px" }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: "#1E293B", marginBottom: 16 }}>Entry Log</h2>
          {entries.length === 0 ? <div style={{ textAlign: "center", padding: 40, color: "#94A3B8" }}>No entries yet</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {entries.map(e => (
                <button key={e.date} onClick={() => { setDate(e.date); setView("entry"); }}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "#fff", border: "1px solid #E2E8F0", borderRadius: 8, cursor: "pointer", textAlign: "left", fontFamily: "inherit", fontSize: 13 }}
                  onMouseOver={ev => ev.currentTarget.style.borderColor = "#93C5FD"}
                  onMouseOut={ev => ev.currentTarget.style.borderColor = "#E2E8F0"}>
                  <div><div style={{ fontWeight: 600, color: "#1E293B" }}>{fmtDate(e.date)}</div><div style={{ color: "#64748B", fontSize: 12 }}>{e.analyst || "No analyst"}</div></div>
                  <div style={{ textAlign: "right" }}><div style={{ fontSize: 12, color: "#64748B" }}>{e.filledCount} values</div>
                    {e.savedAt && <div style={{ fontSize: 11, color: "#94A3B8" }}>{new Date(e.savedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────
const navBtn = { width: 32, height: 32, borderRadius: 8, border: "1.5px solid #CBD5E1", background: "#fff", cursor: "pointer", fontSize: 13, color: "#475569", display: "flex", alignItems: "center", justifyContent: "center" };
const metaLabel = { display: "flex", flexDirection: "column", gap: 3, fontSize: 11, fontWeight: 600, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.6 };
const metaInput = { fontSize: 14, padding: "6px 10px", border: "1.5px solid #CBD5E1", borderRadius: 7, fontFamily: "inherit", color: "#1E293B", background: "#fff", minWidth: 120 };
const th = { padding: "10px 8px", background: "#0B1D33", color: "#fff", fontWeight: 600, fontSize: 12, textAlign: "center", letterSpacing: 0.3, position: "sticky", top: 0, borderBottom: "2px solid #1A3A5C" };
const analyteCell = { padding: "10px 12px", fontWeight: 600, color: "#1E293B", background: "#F8FAFC", borderBottom: "1px solid #E2E8F0", whiteSpace: "nowrap" };
const td = { padding: 3, borderBottom: "1px solid #E2E8F0", borderRight: "1px solid #F1F5F9", textAlign: "center" };
const cellInput = { width: "100%", padding: "8px 4px", border: "1.5px solid transparent", borderRadius: 5, textAlign: "center", fontSize: 14, fontFamily: "inherit", color: "#1E293B", background: "transparent", outline: "none", transition: "border-color 0.15s, background 0.15s", boxSizing: "border-box" };
const actionBtn = { padding: "8px 16px", borderRadius: 8, border: "1.5px solid #CBD5E1", cursor: "pointer", background: "#fff", color: "#334155", fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 7 };
