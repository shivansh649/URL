import React, { useState, useEffect, useMemo, useCallback } from "react";
import { BrowserRouter, Routes, Route, useNavigate, useParams, Link } from "react-router-dom";

/*
  Single-file React app for URL Shortener with client-side routing and analytics.
  - Uses a custom LoggingMiddleware (Logger) instead of console.log or built-in loggers.
  - Stores URL mappings and logs in localStorage so they persist across reloads.
  - Default validity: 30 minutes when not provided.
  - Supports custom shortcodes (alphanumeric, 3-20 chars) and ensures uniqueness.
  - Redirects are handled client-side at route /:code and update analytics.

  How to use this file in a React project:
  1. Create a new React app (e.g., using Vite or CRA).
  2. Install react-router-dom: npm install react-router-dom
  3. Replace your src/App.jsx (or src/main.jsx entry) with this file and render <App />.
*/

/* ------------------ LoggingMiddleware (Custom Logger) ------------------ */

// The logger stores structured log entries in localStorage under 'ru_logger' key.
// It provides middleware-like wrappers to record actions and their payloads.
const LOG_KEY = "ru_logger_v1";

function readLogs() {
  try {
    const raw = localStorage.getItem(LOG_KEY) || "[]";
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}
function writeLogs(arr) {
  localStorage.setItem(LOG_KEY, JSON.stringify(arr));
}

export const Logger = {
  log(eventType, payload = {}) {
    // eventType: string, payload: object
    const entry = {
      id: Math.random().toString(36).slice(2, 9),
      ts: new Date().toISOString(),
      eventType,
      payload,
    };
    const logs = readLogs();
    logs.unshift(entry);
    // Keep logs capped to 1000 entries
    if (logs.length > 1000) logs.length = 1000;
    writeLogs(logs);
    return entry;
  },
  getAll() {
    return readLogs();
  },
  clear() {
    writeLogs([]);
  },
  middleware(actionName, fn) {
    // Returns a wrapped function that logs before/after running fn
    return async function (...args) {
      Logger.log("action.start", { actionName, argsLength: args.length });
      try {
        const result = await fn.apply(this, args);
        Logger.log("action.success", { actionName });
        return result;
      } catch (err) {
        Logger.log("action.error", { actionName, message: err?.message });
        throw err;
      }
    };
  },
};

/* ------------------ Storage / URL mapping logic ------------------ */

const STORAGE_KEY = "ru_mappings_v1";

function readMappings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || "{}";
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}
function writeMappings(obj) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
}

function generateCode(length = 6) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < length; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function isValidCustom(code) {
  if (!code) return false;
  if (typeof code !== "string") return false;
  if (code.length < 3 || code.length > 20) return false;
  return /^[a-zA-Z0-9_-]+$/.test(code);
}

const StorageAPI = {
  list() {
    return readMappings();
  },
  get(code) {
    const map = readMappings();
    return map[code] || null;
  },
  save(code, record) {
    const map = readMappings();
    map[code] = record;
    writeMappings(map);
  },
  delete(code) {
    const map = readMappings();
    delete map[code];
    writeMappings(map);
  },
  exists(code) {
    const map = readMappings();
    return !!map[code];
  },
  findUnique(baseLength = 6) {
    // try generating unique codes (with backoff)
    let attempt = 0;
    while (attempt < 10) {
      const candidate = generateCode(baseLength + Math.floor(attempt / 3));
      if (!this.exists(candidate)) return candidate;
      attempt++;
    }
    // fallback to timestamp-based
    let candidate;
    do {
      candidate = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
    } while (this.exists(candidate));
    return candidate;
  },
};

/* ------------------ Business Logic (wrapped with Logger.middleware) ------------------ */

const DEFAULT_VALIDITY_MIN = 30; // minutes

async function _createShortLink({ longUrl, customCode, validityMins }) {
  if (!longUrl) throw new Error("Missing longUrl");
  const sanitizedUrl = longUrl.trim();

  let codeToUse = null;
  if (customCode) {
    if (!isValidCustom(customCode)) throw new Error("Custom code invalid. Use 3-20 alphanumeric/underscore/dash.");
    if (StorageAPI.exists(customCode)) throw new Error("Custom code already in use.");
    codeToUse = customCode;
  } else {
    codeToUse = StorageAPI.findUnique(6);
  }

  const now = Date.now();
  const validity = Number.isInteger(validityMins) ? validityMins : DEFAULT_VALIDITY_MIN;
  const expiresAt = now + validity * 60 * 1000;

  const record = {
    code: codeToUse,
    longUrl: sanitizedUrl,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    validityMins: validity,
    clicks: 0,
    lastAccessed: null,
    history: [], // stores {ts, referrer}
  };

  StorageAPI.save(codeToUse, record);
  Logger.log("shortlink.created", { code: codeToUse, longUrl: sanitizedUrl, validityMins: validity });
  return record;
}

const createShortLink = Logger.middleware("createShortLink", _createShortLink);

async function _accessShortLink(code, referrer = null) {
  const rec = StorageAPI.get(code);
  if (!rec) {
    Logger.log("shortlink.miss", { code });
    return { found: false };
  }
  const now = Date.now();
  if (new Date(rec.expiresAt).getTime() < now) {
    Logger.log("shortlink.expired", { code });
    return { found: false, expired: true };
  }
  // update analytics
  rec.clicks = (rec.clicks || 0) + 1;
  rec.lastAccessed = new Date().toISOString();
  rec.history = rec.history || [];
  rec.history.unshift({ ts: rec.lastAccessed, referrer });
  StorageAPI.save(code, rec);
  Logger.log("shortlink.access", { code, referrer });
  return { found: true, record: rec };
}
const accessShortLink = Logger.middleware("accessShortLink", _accessShortLink);

/* ------------------ React UI Components ------------------ */

function useMappings() {
  const [mappings, setMappings] = useState(() => StorageAPI.list());
  useEffect(() => {
    const onStorage = () => setMappings(StorageAPI.list());
    // simple polling to reflect changes in other tabs
    const id = setInterval(onStorage, 1000);
    return () => clearInterval(id);
  }, []);
  return [mappings, () => setMappings(StorageAPI.list())];
}

function ShortenForm({ onCreated }) {
  const [longUrl, setLongUrl] = useState("");
  const [customCode, setCustomCode] = useState("");
  const [validity, setValidity] = useState("");
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const val = validity === "" ? undefined : parseInt(validity, 10);
      const rec = await createShortLink({ longUrl, customCode: customCode || undefined, validityMins: val });
      setLongUrl("");
      setCustomCode("");
      setValidity("");
      onCreated && onCreated(rec);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="card">
      <h3>Create Short Link</h3>
      <label>
        Long URL
        <input required value={longUrl} onChange={(e) => setLongUrl(e.target.value)} placeholder="https://example.com/very/long/path" />
      </label>
      <label>
        Custom shortcode (optional)
        <input value={customCode} onChange={(e) => setCustomCode(e.target.value)} placeholder="e.g. my-link1" />
      </label>
      <label>
        Validity (minutes, optional — default 30)
        <input value={validity} onChange={(e) => setValidity(e.target.value)} placeholder="30" type="number" min="1" />
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" disabled={creating}>Create</button>
        <button type="button" onClick={() => { setLongUrl(""); setCustomCode(""); setValidity(""); setError(null); }}>Reset</button>
      </div>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

function LinkRow({ rec }) {
  const host = window.location.origin;
  const shortUrl = `${host}/${rec.code}`;
  return (
    <div className="link-row">
      <div className="col">
        <strong>{rec.code}</strong>
        <div className="muted">{shortUrl}</div>
      </div>
      <div className="col">
        <div className="muted">To: <a href={rec.longUrl} target="_blank" rel="noreferrer">{rec.longUrl}</a></div>
        <div className="muted">Clicks: {rec.clicks}</div>
        <div className="muted">Expires: {new Date(rec.expiresAt).toLocaleString()}</div>
      </div>
      <div className="col actions">
        <Link to={`/stats/${rec.code}`} className="btn">Stats</Link>
        <a className="btn" href={shortUrl}>Open</a>
      </div>
    </div>
  );
}

function Dashboard() {
  const [mappings, refresh] = useMappings();
  const [created, setCreated] = useState(null);

  useEffect(() => {
    if (created) {
      // refresh to pick up new mapping
      refresh();
      setCreated(null);
    }
  }, [created, refresh]);

  const all = Object.values(mappings).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return (
    <div>
      <h2>URL Shortener</h2>
      <div className="grid">
        <div>
          <ShortenForm onCreated={(r) => setCreated(r)} />
        </div>
        <div>
          <div className="card">
            <h3>All Short Links</h3>
            {all.length === 0 && <div className="muted">No links yet.</div>}
            {all.map((r) => (
              <LinkRow rec={r} key={r.code} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatsPage() {
  const { code } = useParams();
  const [rec, setRec] = useState(null);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    const map = StorageAPI.get(code);
    if (!map) setStatus("notfound");
    else setRec(map);
  }, [code]);

  const handleDelete = () => {
    StorageAPI.delete(code);
    Logger.log("shortlink.delete", { code });
    window.location.href = "/";
  };

  if (status === "notfound") return (
    <div className="card">
      <h3>Stats: {code}</h3>
      <div className="error">Short link not found.</div>
      <Link to="/">Back</Link>
    </div>
  );

  if (!rec) return <div className="muted">Loading...</div>;

  const host = window.location.origin;
  const shortUrl = `${host}/${rec.code}`;

  return (
    <div className="card">
      <h3>Statistics for {rec.code}</h3>
      <div><strong>Short URL:</strong> <a href={shortUrl}>{shortUrl}</a></div>
      <div><strong>Original URL:</strong> <a href={rec.longUrl} target="_blank" rel="noreferrer">{rec.longUrl}</a></div>
      <div><strong>Created:</strong> {new Date(rec.createdAt).toLocaleString()}</div>
      <div><strong>Expires:</strong> {new Date(rec.expiresAt).toLocaleString()}</div>
      <div><strong>Validity (mins):</strong> {rec.validityMins}</div>
      <div><strong>Clicks:</strong> {rec.clicks}</div>
      <div><strong>Last accessed:</strong> {rec.lastAccessed || "—"}</div>

      <h4>Access history</h4>
      {!(rec.history && rec.history.length) && <div className="muted">No history yet.</div>}
      <ul>
        {(rec.history || []).slice(0, 50).map((h, idx) => (
          <li key={idx}>{new Date(h.ts).toLocaleString()} — referrer: {h.referrer || "—"}</li>
        ))}
      </ul>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={() => { navigator.clipboard?.writeText(shortUrl); Logger.log("shortlink.copy", { code }); }}>Copy Short URL</button>
        <button onClick={() => { window.open(shortUrl, "_blank"); }}>Open in new tab</button>
        <button onClick={handleDelete}>Delete</button>
        <Link to="/">Back</Link>
      </div>
    </div>
  );
}

function LogsViewer() {
  const [logs, setLogs] = useState(Logger.getAll());
  useEffect(() => {
    const id = setInterval(() => setLogs(Logger.getAll()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="card">
      <h3>Logger</h3>
      <div style={{ maxHeight: 300, overflow: "auto" }}>
        {logs.length === 0 && <div className="muted">No logs yet.</div>}
        <ul>
          {logs.map((l) => (
            <li key={l.id}><small>{new Date(l.ts).toLocaleString()}</small> — <strong>{l.eventType}</strong> — <code>{JSON.stringify(l.payload)}</code></li>
          ))}
        </ul>
      </div>
      <div style={{ marginTop: 8 }}>
        <button onClick={() => { Logger.clear(); setLogs([]); }}>Clear logs</button>
      </div>
    </div>
  );
}

function RedirectHandler() {
  const { code } = useParams();
  const navigate = useNavigate();
  useEffect(() => {
    let mounted = true;
    (async () => {
      const referrer = document.referrer || null;
      const result = await accessShortLink(code, referrer);
      if (!mounted) return;
      if (!result.found) {
        // Show not found / expired page inside app
        navigate(`/notfound/${code}`, { replace: true });
      } else {
        // perform client-side redirect
        // use location.href to actually navigate (this will leave the React app)
        const target = result.record.longUrl;
        // small delay to allow logging to be visible in UI if user stays
        window.location.href = target;
      }
    })();
    return () => { mounted = false; };
  }, [code, navigate]);

  return (
    <div className="card">
      <h3>Redirecting...</h3>
      <div className="muted">Resolving short code: {code}</div>
    </div>
  );
}

function NotFoundPage() {
  const { code } = useParams();
  const rec = StorageAPI.get(code);
  const expired = rec ? (new Date(rec.expiresAt).getTime() < Date.now()) : false;
  return (
    <div className="card">
      <h3>Short link not available</h3>
      <div className="muted">Code: {code}</div>
      {expired && <div className="error">This link has expired.</div>}
      {!rec && <div className="error">This code does not exist.</div>}
      <Link to="/">Back to app</Link>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div style={{ padding: 18, fontFamily: "Inter, Arial, sans-serif" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h1 style={{ margin: 0 }}><Link to="/">React URL Shortener</Link></h1>
          <nav>
            <Link to="/">Home</Link> | <Link to="/logs">Logs</Link>
          </nav>
        </header>

        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/stats/:code" element={<StatsPage />} />
          <Route path="/logs" element={<LogsViewer />} />
          <Route path="/notfound/:code" element={<NotFoundPage />} />

          {/* Catch-all for short codes: treat as redirect handler */}
          <Route path=":code" element={<RedirectHandler />} />
        </Routes>

        <footer style={{ marginTop: 28, paddingTop: 8, borderTop: "1px solid #eee" }}>
          <small className="muted">Client-side URL shortener • Default validity: {DEFAULT_VALIDITY_MIN} minutes • Uses Logging Middleware (no console logs)</small>
        </footer>

        {/* Minimal styles */}
        <style>{`
          .card { background: #fff; border: 1px solid #e6e6e6; padding: 12px; border-radius: 8px; margin-bottom: 12px; }
          .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
          input { width: 100%; padding: 8px; margin: 6px 0; border-radius: 6px; border: 1px solid #ddd; }
          button { padding: 8px 10px; border-radius: 6px; border: 1px solid #bbb; background: #f7f7f7; cursor: pointer; }
          .muted { color: #666; font-size: 13px; }
          .error { color: #a33; margin-top: 8px; }
          .link-row { display:flex; gap:12px; align-items:center; padding:8px 0; border-bottom:1px solid #f0f0f0; }
          .link-row .col { flex:1 }
          .link-row .actions { display:flex; gap:8px; justify-content:flex-end }
          .btn { padding:6px 8px; border-radius:6px; background:#eee; text-decoration:none; border:1px solid #ddd }
        `}</style>
      </div>
    </BrowserRouter>
  );
}
