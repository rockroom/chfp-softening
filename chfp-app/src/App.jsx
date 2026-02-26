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

// ── Rounding Rules ─────────────────────────────────────────
// Applied on blur: pH→2dp, Temperature→1dp, Conductivity→whole
function roundValue(analyte, raw) {
  if (raw === "" || raw == null) return "";
  const num = parseFloat(raw);
  if (isNaN(num)) return raw; // leave non-numeric as-is for user to fix
  switch (analyte) {
    case "pH": return num.toFixed(2);
    case "Temperature": return num.toFixed(1);
    case "Conductivity": return Math.round(num).toString();
    default: return raw; // Alkalinity, Calcium, Hardness — no rounding
  }
}

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
const emptyRecord = () => ({ analyst: "", sampleTime: getEST(), values: emptyData(), locked: false });

// ── Supabase Data Layer ────────────────────────────────────
async function loadSample(sampleDate) {
  const { data, error } = await supabase
    .from("samples")
    .select("*")
    .eq("sample_date", sampleDate)
    .maybeSingle();
  if (error) throw error;
  if (data) return { analyst: data.analyst, sampleTime: data.sample_time, values: data.values, locked: data.locked || false };
  return null;
}

async function saveSample(sampleDate, record) {
  const { error } = await supabase
    .from("samples")
    .upsert({
      sample_date: sampleDate,
      analyst: record.analyst,
      sample_time: record.sampleTime,
      values: record.values,
      locked: record.locked || false,
    }, { onConflict: "sample_date" });
  if (error) throw error;
}

async function lockSample(sampleDate) {
  const { error } = await supabase
    .from("samples")
    .update({ locked: true })
    .eq("sample_date", sampleDate);
  if (error) throw error;
}

async function unlockSample(sampleDate) {
  const { error } = await supabase
    .from("samples")
    .update({ locked: false })
    .eq("sample_date", sampleDate);
  if (error) throw error;
}

async function loadEntryLog() {
  const { data, error } = await supabase
    .from("samples")
    .select("sample_date, analyst, updated_at, values, locked")
    .order("sample_date", { ascending: false })
    .limit(60);
  if (error) throw error;
  return (data || []).map(r => ({
    date: r.sample_date,
    analyst: r.analyst,
    savedAt: r.updated_at,
    filledCount: Object.values(r.values || {}).filter(v => v !== "").length,
    locked: r.locked || false,
  }));
}

async function deleteSample(sampleDate) {
  const { error } = await supabase
    .from("samples")
    .delete()
    .eq("sample_date", sampleDate);
  if (error) throw error;
}

// ── CSV Export ─────────────────────────────────────────────
async function exportCSV() {
  const { data, error } = await supabase
    .from("samples")
    .select("*")
    .order("sample_date", { ascending: true });
  if (error) throw error;
  if (!data || data.length === 0) return null;

  // Build header
  const valueCols = [];
  ANALYTES.forEach((a, ai) => {
    LOCATIONS.forEach((l, li) => {
      if (!DISABLED.has(`${ai}-${li}`)) valueCols.push(`${a}::${l}`);
    });
  });
  const header = ["Sample Date", "Analyst", "Sample Time", "Locked", ...valueCols.map(c => c.replace("::", " - "))];

  // Build rows
  const rows = data.map(r => {
    const vals = valueCols.map(c => (r.values || {})[c] || "");
    return [r.sample_date, r.analyst || "", r.sample_time || "", r.locked ? "Yes" : "No", ...vals];
  });

  const csv = [header, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  return csv;
}

function downloadCSV(csv, filename) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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

// ── Main App ───────────────────────────────────────────────
export default function App() {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem("chfp_auth") === "1");
  if (!authed) return <PasswordGate onAuth={() => setAuthed(true)} />;
  return <DesktopApp />;
}

function DesktopApp() {
  const [date, setDate] = useState(today());
  const [record, setRecord] = useState(emptyRecord());
  const [status, setStatus] = useState("idle");
  const [entries, setEntries] = useState([]);
  const [view, setView] = useState("entry");
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const saveTimer = useRef(null);
  const inputRefs = useRef({});

  const isLocked = record.locked;

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

  useEffect(() => {
    if (view !== "log") return;
    (async () => { try { setEntries(await loadEntryLog()); } catch { setEntries([]); } })();
  }, [view]);

  const save = useCallback(async (rec) => {
    if (rec.locked) return; // don't autosave locked records
    setStatus("saving");
    try { await saveSample(date, rec); setStatus("saved"); }
    catch { setStatus("error"); }
  }, [date]);

  const handleChange = (key, value) => {
    if (isLocked) return;
    const updated = { ...record, values: { ...record.values, [key]: value } };
    setRecord(updated);
    setStatus("idle");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(updated), 1200);
  };

  // Apply rounding when user leaves a cell
  const handleBlur = (key) => {
    if (isLocked) return;
    const analyte = key.split("::")[0];
    const raw = record.values[key];
    const rounded = roundValue(analyte, raw);
    if (rounded !== raw) {
      const updated = { ...record, values: { ...record.values, [key]: rounded } };
      setRecord(updated);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => save(updated), 600);
    }
  };

  const handleMeta = (field, value) => {
    if (isLocked) return;
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

  const handleLock = async () => {
    const filledCount = Object.values(record.values).filter(v => v !== "").length;
    if (filledCount === 0) { alert("No data to finalize."); return; }
    if (!window.confirm(`Finalize entry for ${fmtDate(date)}? This will lock the data from further edits.`)) return;

    // Apply rounding to all values before locking
    const rounded = { ...record.values };
    for (const key of Object.keys(rounded)) {
      const analyte = key.split("::")[0];
      rounded[key] = roundValue(analyte, rounded[key]);
    }
    const finalRecord = { ...record, values: rounded, locked: true };
    try {
      await saveSample(date, finalRecord);
      setRecord(finalRecord);
      setStatus("saved");
    } catch { setStatus("error"); }
  };

  const handleUnlock = async () => {
    if (!window.confirm(`Unlock ${fmtDate(date)} for editing?`)) return;
    try {
      await unlockSample(date);
      setRecord({ ...record, locked: false });
    } catch {}
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const csv = await exportCSV();
      if (csv) {
        downloadCSV(csv, `chfp_softening_data_${today()}.csv`);
      } else {
        alert("No data to export.");
      }
    } catch { alert("Export failed."); }
    setExporting(false);
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
          {/* Locked banner */}
          {isLocked && (
            <div style={{ background: "#FEF9C3", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 16px", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13, color: "#92400E", fontWeight: 500 }}>🔒 This entry is finalized and locked from editing.</span>
              <button onClick={handleUnlock} style={{ fontSize: 12, color: "#92400E", background: "none", border: "1px solid #FDE68A", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontWeight: 600 }}>Unlock</button>
            </div>
          )}

          {/* Date nav + meta */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => handleNav(-1)} style={navBtn}>◄</button>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                style={{ fontSize: 14, padding: "7px 12px", border: "1.5px solid #CBD5E1", borderRadius: 8, fontFamily: "inherit", color: "#1E293B", background: "#fff" }} />
              <button onClick={() => handleNav(1)} style={navBtn}>►</button>
              <span style={{ fontSize: 15, fontWeight: 600, color: "#334155", marginLeft: 6 }}>{fmtDate(date)}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <label style={metaLabel}>Initials
                <input value={record.analyst} onChange={e => handleMeta("analyst", e.target.value.toUpperCase().slice(0, 2))} placeholder="XX" maxLength={2}
                  disabled={isLocked}
                  style={{ ...metaInput, minWidth: 60, width: 60, textAlign: "center", textTransform: "uppercase", letterSpacing: 2, opacity: isLocked ? 0.6 : 1 }} />
              </label>
              <label style={metaLabel}>Sample Time
                <input type="text" value={record.sampleTime} onChange={e => handleMeta("sampleTime", e.target.value)} placeholder="HH:MM" maxLength={5}
                  disabled={isLocked}
                  style={{ ...metaInput, opacity: isLocked ? 0.6 : 1 }} />
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%",
                  background: isLocked ? "#F59E0B" : status === "saved" ? "#22C55E" : status === "saving" ? "#F59E0B" : status === "error" ? "#EF4444" : "#CBD5E1" }} />
                <span style={{ fontSize: 12, color: "#94A3B8" }}>
                  {isLocked ? "Locked" : status === "saved" ? "Saved" : status === "saving" ? "Saving…" : status === "error" ? "Error" : filledCount > 0 ? "Unsaved" : "No data"}
                </span>
              </div>
            </div>
          </div>

          {/* Progress */}
          <div style={{ height: 3, background: "#E2E8F0", borderRadius: 2, marginBottom: 16, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(filledCount / totalCells) * 100}%`, background: isLocked ? "#F59E0B" : filledCount === totalCells ? "#22C55E" : "#3B82F6", borderRadius: 2, transition: "width 0.4s ease" }} />
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
                        const cellKey = `${a}::${l}`;
                        return (
                          <td key={l} style={{ ...td, background: dis ? "#EDEFF2" : isLocked ? "#FAFAFA" : "#fff" }}>
                            {dis ? <span style={{ color: "#B0B8C4", fontSize: 16, fontWeight: 600 }}>✕</span> : (
                              <input ref={el => { inputRefs.current[`${ai}-${li}`] = el; }}
                                type="text" inputMode="decimal"
                                value={record.values[cellKey] || ""}
                                onChange={e => handleChange(cellKey, e.target.value)}
                                onBlur={() => handleBlur(cellKey)}
                                onKeyDown={e => handleCellKeyDown(e, ai, li)}
                                onFocus={e => e.target.select()}
                                disabled={isLocked}
                                style={{ ...cellInput, opacity: isLocked ? 0.7 : 1, cursor: isLocked ? "default" : "text" }} />
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
            <div style={{ fontSize: 11, color: "#94A3B8" }}>
              {!isLocked && "pH rounds to 2 dp · Temp to 1 dp · Conductivity to whole number"}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {!isLocked && (
                <>
                  <button onClick={() => { if (window.confirm("Clear all values for this date?")) { setRecord(emptyRecord()); setStatus("idle"); } }}
                    style={{ ...actionBtn, color: "#94A3B8", borderColor: "#E2E8F0" }}>Clear</button>
                  <button onClick={async () => {
                    if (window.confirm(`Delete entry for ${fmtDate(date)}? This cannot be undone.`)) {
                      try { await deleteSample(date); setRecord(emptyRecord()); setStatus("idle"); } catch {}
                    }
                  }} style={{ ...actionBtn, color: "#EF4444", borderColor: "#FECACA" }}>Delete</button>
                  <button onClick={() => save(record)} style={{ ...actionBtn, background: "#fff" }}>Save</button>
                  <button onClick={handleLock} style={{ padding: "8px 20px", borderRadius: 8, border: "none", cursor: "pointer", background: "#0B1D33", color: "#fff", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                    🔒 Finalize
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* Entry Log */
        <div style={{ maxWidth: 800, margin: "0 auto", padding: "24px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: "#1E293B", margin: 0 }}>Entry Log</h2>
            <button onClick={handleExport} disabled={exporting}
              style={{ padding: "8px 18px", borderRadius: 8, border: "1.5px solid #CBD5E1", background: "#fff", color: "#334155", fontSize: 13, fontWeight: 500, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, opacity: exporting ? 0.6 : 1 }}>
              📥 {exporting ? "Exporting…" : "Export CSV"}
            </button>
          </div>
          {entries.length === 0 ? <div style={{ textAlign: "center", padding: 40, color: "#94A3B8" }}>No entries yet</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {entries.map(e => (
                <div key={e.date} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button onClick={() => { setDate(e.date); setView("entry"); }}
                    style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "#fff", border: `1px solid ${e.locked ? "#FDE68A" : "#E2E8F0"}`, borderRadius: 8, cursor: "pointer", textAlign: "left", fontFamily: "inherit", fontSize: 13 }}
                    onMouseOver={ev => ev.currentTarget.style.borderColor = "#93C5FD"}
                    onMouseOut={ev => ev.currentTarget.style.borderColor = e.locked ? "#FDE68A" : "#E2E8F0"}>
                    <div>
                      <div style={{ fontWeight: 600, color: "#1E293B" }}>
                        {e.locked && <span style={{ marginRight: 6 }}>🔒</span>}
                        {fmtDate(e.date)}
                      </div>
                      <div style={{ color: "#64748B", fontSize: 12 }}>{e.analyst || "—"}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 12, color: "#64748B" }}>{e.filledCount} values{e.locked ? " · Finalized" : ""}</div>
                      {e.savedAt && <div style={{ fontSize: 11, color: "#94A3B8" }}>{new Date(e.savedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>}
                    </div>
                  </button>
                  {!e.locked && (
                    <button onClick={async () => {
                      if (window.confirm(`Delete ${fmtDate(e.date)}?`)) {
                        try { await deleteSample(e.date); setEntries(prev => prev.filter(x => x.date !== e.date)); } catch {}
                      }
                    }} style={{ width: 32, height: 32, borderRadius: 6, border: "1px solid #FECACA", background: "#FFF", color: "#EF4444", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                      title="Delete entry">✕</button>
                  )}
                </div>
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
