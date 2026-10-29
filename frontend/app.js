let instrument = "NIFTY";
let authToken = localStorage.getItem("oi_auth_token") || "";
let currentUser = localStorage.getItem("oi_username") || "";
let latestSnapshot = null;
let frontendEnv = {};

const CONFIG = window.OI_ANALYZER_CONFIG || {};
const API_BASE_KEY = "oi_api_base_url";
const STRIKE_RANGE = {
  NIFTY: { min: 15000, max: 35000 },
  BANKNIFTY: { min: 30000, max: 90000 },
};

document.addEventListener("DOMContentLoaded", async () => {
  frontendEnv = await loadFrontendEnv();
  initClock();
  bindLogin();
  bindUpload();
  bindActions();

  const apiInput = document.getElementById("apiBaseInput");
  apiInput.value = getApiBase();

  if (authToken) {
    showApp();
    checkBackend();
    loadHistory();
  } else {
    showLogin();
  }
});

function getApiBase() {
  return (
    localStorage.getItem(API_BASE_KEY) ||
    frontendEnv.BACKEND_BASE_URL ||
    frontendEnv.FRONTEND_API_BASE_URL ||
    CONFIG.apiBaseUrl ||
    "http://localhost:10000"
  ).replace(/\/$/, "");
}

async function loadFrontendEnv() {
  try {
    const res = await fetch(".env", { cache: "no-store" });
    if (!res.ok) return {};
    const text = await res.text();
    return text.split("\n").reduce((env, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return env;
      const [key, ...rest] = trimmed.split("=");
      env[key.trim()] = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
      return env;
    }, {});
  } catch (error) {
    return {};
  }
}

function apiUrl(path) {
  return `${getApiBase()}${path}`;
}

function authHeaders(extra = {}) {
  return {
    ...extra,
    Authorization: `Bearer ${authToken}`,
  };
}

function initClock() {
  const tick = () => {
    const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const p = (n) => String(n).padStart(2, "0");
    document.getElementById("clockEl").textContent =
      `${p(ist.getHours())}:${p(ist.getMinutes())}:${p(ist.getSeconds())} IST`;
  };
  tick();
  setInterval(tick, 1000);
}

function bindLogin() {
  document.getElementById("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById("loginError");
    errorEl.textContent = "";

    const apiBase = document.getElementById("apiBaseInput").value.trim().replace(/\/$/, "");
    const username = document.getElementById("loginUsername").value.trim();
    const password = document.getElementById("loginPassword").value;
    if (apiBase) localStorage.setItem(API_BASE_KEY, apiBase);

    try {
      const res = await fetch(apiUrl("/api/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await readApiJson(res);
      if (!res.ok) throw new Error(data.error || "Login failed.");

      authToken = data.token;
      currentUser = data.username;
      localStorage.setItem("oi_auth_token", authToken);
      localStorage.setItem("oi_username", currentUser);
      document.getElementById("loginPassword").value = "";
      showApp();
      checkBackend();
      loadHistory();
    } catch (error) {
      errorEl.textContent = getLoginErrorMessage(error);
    }
  });
}

function getLoginErrorMessage(error) {
  if (error instanceof TypeError) {
    return `Backend unreachable at ${getApiBase()}. Start backend or check CORS/Backend URL.`;
  }
  return error.message || "Login failed.";
}

function bindActions() {
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.getElementById("refreshHistoryBtn").addEventListener("click", loadHistory);
  document.getElementById("advancedToggle").addEventListener("click", () => {
    document.getElementById("apiBaseField").classList.toggle("hidden");
  });
}

function bindUpload() {
  const dz = document.getElementById("dropZone");
  dz.addEventListener("dragover", (event) => {
    event.preventDefault();
    dz.classList.add("drag");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (event) => {
    event.preventDefault();
    dz.classList.remove("drag");
    handleFile(event.dataTransfer.files[0]);
  });
  document.getElementById("fileInput").addEventListener("change", (event) => {
    handleFile(event.target.files[0]);
  });
}

function showLogin() {
  document.getElementById("loginView").classList.remove("hidden");
  document.getElementById("appView").classList.add("hidden");
  document.getElementById("logoutBtn").classList.add("hidden");
  document.getElementById("userPill").textContent = "Not logged in";
}

function showApp() {
  document.getElementById("loginView").classList.add("hidden");
  document.getElementById("appView").classList.remove("hidden");
  document.getElementById("logoutBtn").classList.remove("hidden");
  document.getElementById("userPill").textContent = currentUser || "Logged in";
}

function logout() {
  authToken = "";
  currentUser = "";
  localStorage.removeItem("oi_auth_token");
  localStorage.removeItem("oi_username");
  showLogin();
}

async function checkBackend() {
  const el = document.getElementById("backendStatus");
  el.textContent = "Checking";
  try {
    const res = await fetch(apiUrl("/health"));
    if (!res.ok) throw new Error("Health check failed");
    el.textContent = "Online";
    el.className = "bull";
  } catch (error) {
    el.textContent = "Offline";
    el.className = "warn";
  }
}

function setInstrument(inst) {
  instrument = inst;
  document.getElementById("tabNifty").classList.toggle("active", inst === "NIFTY");
  document.getElementById("tabBankNifty").classList.toggle("active", inst === "BANKNIFTY");
  const name = inst === "NIFTY" ? "Nifty 50" : "Bank Nifty";
  document.getElementById("uploadSub").textContent =
    `${name} options-chain CSV downloaded from NSE`;
}

function handleFile(file) {
  if (!authToken) {
    showLogin();
    return;
  }
  if (!file || !file.name.toLowerCase().endsWith(".csv")) {
    alert("Please upload a CSV file from NSE.");
    return;
  }
  const reader = new FileReader();
  reader.onload = (event) => parseCSV(event.target.result);
  reader.readAsText(file);
}

function parseCSVRow(line) {
  const cols = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (ch === "," && !inQ) {
      cols.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

function numVal(s) {
  if (!s || s === "-") return 0;
  return parseFloat(String(s).replace(/,/g, "")) || 0;
}

function parseCSV(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  let headerIdx = lines.findIndex((line) => {
    const up = line.toUpperCase();
    return up.includes("STRIKE") && (up.includes(",OI,") || up.includes("VOLUME"));
  });
  if (headerIdx === -1) headerIdx = 1;

  const headers = parseCSVRow(lines[headerIdx] || "").map((h) => h.toUpperCase().trim());
  let strikeCol = headers.indexOf("STRIKE");
  if (strikeCol === -1) strikeCol = headers.findIndex((h) => h.includes("STRIKE"));

  const rows = [];
  let totalCallOI = 0;
  let totalPutOI = 0;
  const sr = STRIKE_RANGE[instrument];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]);
    if (cols.length < 12) continue;

    let strike = strikeCol !== -1 && strikeCol < cols.length ? numVal(cols[strikeCol]) : NaN;
    if (!strike || strike < sr.min || strike > sr.max) {
      strike = NaN;
      for (const col of cols) {
        const value = numVal(col);
        if (value >= sr.min && value <= sr.max && value % 50 === 0) {
          strike = value;
          break;
        }
      }
    }
    if (!strike || Number.isNaN(strike)) continue;

    const callOI = numVal(cols[1]);
    const callChg = numVal(cols[2]);
    const callLTP = numVal(cols[5]);
    const putOI = numVal(cols[21] ?? cols[cols.length - 2] ?? "");
    const putChg = numVal(cols[20] ?? cols[cols.length - 3] ?? "");
    const putLTP = numVal(cols[17] ?? cols[cols.length - 6] ?? "");

    rows.push({ strike, callOI, callChg, callLTP, putOI, putChg, putLTP });
    totalCallOI += callOI;
    totalPutOI += putOI;
  }

  if (!rows.length) {
    alert("Could not parse the CSV. Please upload the NSE options-chain CSV.");
    return;
  }

  rows.sort((a, b) => a.strike - b.strike);
  const maxCallRow = rows.reduce((max, row) => (row.callOI > max.callOI ? row : max), rows[0]);
  const maxPutRow = rows.reduce((max, row) => (row.putOI > max.putOI ? row : max), rows[0]);
  const liquid = rows.filter((row) => row.callLTP > 0 && row.putLTP > 0);
  const atmRow = liquid.length
    ? liquid.reduce((best, row) =>
        Math.abs(row.callLTP - row.putLTP) < Math.abs(best.callLTP - best.putLTP) ? row : best,
      liquid[0])
    : rows[Math.floor(rows.length / 2)];
  const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;

  const data = { rows, totalCallOI, totalPutOI, pcr, maxCallRow, maxPutRow, atmRow };
  latestSnapshot = buildSnapshot(data);
  renderDashboard(data);
}

function buildSnapshot(data) {
  const { rows, totalCallOI, totalPutOI, pcr, maxCallRow, maxPutRow, atmRow } = data;
  return {
    instrument,
    metrics: {
      pcr: Number(pcr.toFixed(2)),
      totalCallOI,
      totalPutOI,
    },
    levels: {
      atm: atmRow.strike,
      maxCallStrike: maxCallRow.strike,
      maxCallOI: maxCallRow.callOI,
      maxCallChg: maxCallRow.callChg,
      maxPutStrike: maxPutRow.strike,
      maxPutOI: maxPutRow.putOI,
      maxPutChg: maxPutRow.putChg,
    },
    topStrikes: [...rows]
      .sort((a, b) => b.callOI + b.putOI - (a.callOI + a.putOI))
      .slice(0, 12)
      .map(({ strike, callOI, callChg, putOI, putChg }) => ({
        strike,
        callOI,
        callChg,
        putOI,
        putChg,
      })),
  };
}

function fmt(n) {
  const value = Number(n || 0);
  if (value >= 10000000) return `${(value / 10000000).toFixed(2)}Cr`;
  if (value >= 100000) return `${(value / 100000).toFixed(2)}L`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return value.toFixed(0);
}

function renderDashboard(data) {
  const { rows, totalCallOI, totalPutOI, pcr, maxCallRow, maxPutRow, atmRow } = data;
  const { bias, biasClass } = getBias(pcr);

  const banner = document.getElementById("signalBanner");
  banner.className = `signal-banner ${biasClass}`;
  document.getElementById("sigWord").textContent = bias;
  document.getElementById("pcrBig").textContent = pcr.toFixed(2);
  document.getElementById("sigTag").textContent =
    `${instrument === "NIFTY" ? "Nifty 50" : "Bank Nifty"} Bias`;

  const pcrColor = biasClass === "bull" ? "bull" : biasClass === "bear" ? "bear" : "warn";
  document.getElementById("metricsGrid").innerHTML = [
    { label: "PCR", val: pcr.toFixed(2), cls: pcrColor },
    { label: "Total Call OI", val: fmt(totalCallOI), cls: "bear" },
    { label: "Total Put OI", val: fmt(totalPutOI), cls: "bull" },
    { label: "ATM Strike", val: atmRow.strike.toLocaleString(), cls: "blue" },
    { label: "Max Call Strike", val: maxCallRow.strike.toLocaleString(), cls: "bear" },
    { label: "Max Put Strike", val: maxPutRow.strike.toLocaleString(), cls: "bull" },
    { label: "Call OI at Max", val: fmt(maxCallRow.callOI), cls: "bear" },
    { label: "Put OI at Max", val: fmt(maxPutRow.putOI), cls: "bull" },
  ].map((m) => `
    <div class="metric">
      <div class="metric-label">${m.label}</div>
      <div class="metric-val ${m.cls}">${m.val}</div>
    </div>`).join("");

  renderOiChart(rows, atmRow, maxCallRow, maxPutRow);
  renderLevels(maxCallRow, maxPutRow, atmRow);

  document.getElementById("uploadSection").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");
  generateAISignal();
}

function getBias(pcr) {
  if (pcr > 1.5) return { bias: "Strongly Bullish", biasClass: "bull" };
  if (pcr > 1.2) return { bias: "Bullish", biasClass: "bull" };
  if (pcr > 0.9) return { bias: "Neutral", biasClass: "neut" };
  if (pcr > 0.7) return { bias: "Bearish", biasClass: "bear" };
  return { bias: "Strongly Bearish", biasClass: "bear" };
}

function renderOiChart(rows, atmRow, maxCallRow, maxPutRow) {
  const atmIdx = rows.indexOf(atmRow);
  const visible = rows.slice(Math.max(0, atmIdx - 5), Math.min(rows.length, atmIdx + 6));
  const maxOI = Math.max(...visible.map((row) => Math.max(row.callOI, row.putOI))) || 1;

  document.getElementById("oiChart").innerHTML = `
    <div class="oi-row header">
      <div>CALL OI</div><div></div><div>STRIKE</div><div></div><div>CHG</div><div>PUT OI</div>
    </div>
    ${visible.map((row) => {
      const callW = ((row.callOI / maxOI) * 100).toFixed(1);
      const putW = ((row.putOI / maxOI) * 100).toFixed(1);
      const isATM = row.strike === atmRow.strike;
      const isMaxC = row.strike === maxCallRow.strike;
      const isMaxP = row.strike === maxPutRow.strike;
      return `
        <div class="oi-row">
          <div class="call-num">${fmt(row.callOI)}</div>
          <div class="bar-wrap-call"><div class="bar call" style="width:${callW}%"></div></div>
          <div class="strike-label ${isATM ? "atm-tag" : ""}">
            ${row.strike.toLocaleString()}${isATM ? " ATM" : ""}${isMaxC ? " R" : ""}${isMaxP ? " S" : ""}
          </div>
          <div class="bar-wrap-put"><div class="bar put" style="width:${putW}%"></div></div>
          <div class="chg ${row.putChg > 0 ? "pos" : ""}">${row.putChg > 0 ? "+" : ""}${fmt(row.putChg)}</div>
          <div class="put-num">${fmt(row.putOI)}</div>
        </div>`;
    }).join("")}`;
}

function renderLevels(maxCallRow, maxPutRow, atmRow) {
  document.getElementById("levelList").innerHTML = [
    { name: "Strong Resistance", val: maxCallRow.strike.toLocaleString(), cls: "bear" },
    { name: "Resistance Zone", val: (maxCallRow.strike + 200).toLocaleString(), cls: "bear" },
    { name: "ATM Area", val: atmRow.strike.toLocaleString(), cls: "blue" },
    { name: "Support Zone", val: (maxPutRow.strike - 200).toLocaleString(), cls: "bull" },
    { name: "Strong Support", val: maxPutRow.strike.toLocaleString(), cls: "bull" },
  ].map((level) => `
    <div class="level-item">
      <div class="level-name">${level.name}</div>
      <div class="level-val ${level.cls}">${level.val}</div>
    </div>`).join("");
}

async function generateAISignal() {
  if (!latestSnapshot) return;
  setAiLoading("Generating and saving analysis...");

  try {
    const res = await fetch(apiUrl("/api/analyze"), {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ snapshot: latestSnapshot }),
    });
    const data = await readApiJson(res);
    if (!res.ok) throw new Error(data.error || "AI analysis failed.");

    renderTradeplan(data.analysis);
    await loadHistory();
  } catch (error) {
    showAiError(error.message || "AI analysis failed.");
  }
}

function setAiLoading(message) {
  const loading = document.getElementById("aiLoading");
  loading.style.display = "flex";
  loading.innerHTML = `<div class="spin"></div>${escHtml(message)}`;
  document.getElementById("aiContent").classList.remove("show");
}

function showAiError(message) {
  document.getElementById("aiLoading").style.display = "flex";
  document.getElementById("aiLoading").innerHTML =
    `<span class="warn">AI signal unavailable (${escHtml(message)}) - OI data above is still valid.</span>`;
}

function renderTradeplan(r) {
  const dir = String(r.primary_direction || "WAIT").toUpperCase();
  const isBull = dir === "BUY CALL";
  const isBear = dir === "BUY PUT";
  const cardClass = isBull ? "call-trade" : isBear ? "put-trade" : "wait-trade";
  const entColor = isBull ? "bull" : isBear ? "bear" : "warn";

  document.getElementById("primaryTrade").innerHTML = `
    <div class="primary-trade ${cardClass}">
      <div class="pt-left">
        <div class="pt-action">Primary Signal</div>
        <div class="pt-type ${entColor}">${escHtml(dir)}</div>
        <div class="pt-sub">
          ${isBull ? `Buy <strong>${escHtml(r.suggested_strike)} CE</strong>` : isBear ? `Buy <strong>${escHtml(r.suggested_strike)} PE</strong>` : "No clear edge - stand aside"}
          &nbsp; R:R <strong>${escHtml(r.risk_reward || "-")}</strong>
        </div>
      </div>
      <div class="pt-right">
        ${statBox("Entry", r.entry_zone, entColor)}
        ${statBox("Stop", formatMaybeNumber(r.stop_loss), "bear")}
        ${statBox("Target 1", formatMaybeNumber(r.target_1), "bull")}
        ${statBox("Target 2", formatMaybeNumber(r.target_2), "bull")}
      </div>
    </div>`;

  document.getElementById("tradeTableWrap").innerHTML = `
    <table class="trade-table">
      <thead><tr><th>Parameter</th><th>Value</th><th>Rule</th></tr></thead>
      <tbody>
        ${ruleRow("Entry Trigger", r.entry_zone, r.entry_trigger, entColor)}
        ${ruleRow("Stop Loss", formatMaybeNumber(r.stop_loss), "Hard invalidation level.", "bear")}
        ${ruleRow("Target 1", formatMaybeNumber(r.target_1), "Book partial profit.", "bull")}
        ${ruleRow("Target 2", formatMaybeNumber(r.target_2), "Final target.", "bull")}
        ${ruleRow("Early Exit", "Time / Price", r.exit_rule, "warn")}
      </tbody>
    </table>`;

  document.getElementById("tradeScenarios").innerHTML = `
    <div class="scenario">
      <div class="scenario-tag">Bull Scenario</div>
      <div class="scenario-text">${escHtml(r.bull_scenario)}</div>
    </div>
    <div class="scenario">
      <div class="scenario-tag">Bear Scenario</div>
      <div class="scenario-text">${escHtml(r.bear_scenario)}</div>
    </div>`;

  document.getElementById("aiAnalysis").textContent = r.oi_analysis || "";
  document.getElementById("whyBox").innerHTML = `
    <div class="why-box-title">Why This Trade</div>
    ${escHtml(r.reasoning)}`;
  document.getElementById("riskBox").innerHTML = `Risk to avoid: ${escHtml(r.risk_warning)}`;

  document.getElementById("aiLoading").style.display = "none";
  document.getElementById("aiContent").classList.add("show");
}

function statBox(label, value, cls) {
  return `
    <div class="pt-stat">
      <div class="pt-stat-label">${escHtml(label)}</div>
      <div class="pt-stat-val ${cls}">${escHtml(value || "-")}</div>
    </div>`;
}

function ruleRow(label, value, rule, cls) {
  return `
    <tr>
      <td class="label-col">${escHtml(label)}</td>
      <td class="val-col ${cls}">${escHtml(value || "-")}</td>
      <td class="reason-col">${escHtml(rule || "-")}</td>
    </tr>`;
}

function formatMaybeNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) !== 0
    ? Number(value).toLocaleString()
    : value || "-";
}

async function loadHistory() {
  if (!authToken) return;
  const list = document.getElementById("historyList");
  list.innerHTML = '<div class="empty-state">Loading history...</div>';

  try {
    const res = await fetch(apiUrl("/api/analyses?limit=30"), {
      headers: authHeaders(),
    });
    const data = await readApiJson(res);
    if (!res.ok) throw new Error(data.error || "Could not load history.");
    renderHistory(data.items || []);
  } catch (error) {
    list.innerHTML = `<div class="empty-state">${escHtml(error.message || "Could not load history.")}</div>`;
  }
}

function renderHistory(items) {
  const list = document.getElementById("historyList");
  if (!items.length) {
    list.innerHTML = '<div class="empty-state">No saved analysis yet.</div>';
    return;
  }

  list.innerHTML = items.map((item) => `
    <button class="history-item" type="button" data-id="${escAttr(item.id)}">
      <div class="history-meta">
        <span>${escHtml(item.instrument || "-")}</span>
        <span>${formatTime(item.created_at)}</span>
      </div>
      <div class="history-signal">${escHtml(item.primary_direction || "WAIT")}</div>
      <div class="history-meta">
        <span>Strike ${escHtml(item.suggested_strike || "-")}</span>
        <span>PCR ${escHtml(item.metrics?.pcr ?? "-")}</span>
      </div>
    </button>`).join("");

  list.querySelectorAll(".history-item").forEach((button) => {
    button.addEventListener("click", () => loadHistoryDetail(button.dataset.id));
  });
}

async function loadHistoryDetail(id) {
  try {
    const res = await fetch(apiUrl(`/api/analyses/${id}`), { headers: authHeaders() });
    const data = await readApiJson(res);
    if (!res.ok) throw new Error(data.error || "Could not load analysis.");
    renderSavedAnalysis(data);
  } catch (error) {
    showAiError(error.message || "Could not load analysis.");
  }
}

function renderSavedAnalysis(item) {
  document.getElementById("uploadSection").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");
  document.getElementById("metricsGrid").innerHTML = "";
  document.getElementById("oiChart").innerHTML = '<div class="empty-state">CSV chart is only shown for the current upload.</div>';
  document.getElementById("levelList").innerHTML = "";
  document.getElementById("sigTag").textContent = `${item.instrument || "Saved"} Analysis`;
  document.getElementById("sigWord").textContent = item.analysis?.primary_direction || "Saved";
  document.getElementById("pcrBig").textContent = item.metrics?.pcr ?? "--";
  document.getElementById("signalBanner").className = "signal-banner neut";
  renderTradeplan(item.analysis || {});
}

function reset() {
  latestSnapshot = null;
  document.getElementById("uploadSection").classList.remove("hidden");
  document.getElementById("dashboard").classList.add("hidden");
  document.getElementById("fileInput").value = "";
  document.getElementById("aiLoading").style.display = "flex";
  document.getElementById("aiLoading").innerHTML = '<div class="spin"></div>Generating and saving analysis...';
  document.getElementById("aiContent").classList.remove("show");
  ["primaryTrade", "tradeTableWrap", "tradeScenarios", "whyBox", "riskBox"].forEach((id) => {
    document.getElementById(id).innerHTML = "";
  });
  document.getElementById("aiAnalysis").textContent = "";
}

async function readApiJson(resp) {
  const text = await resp.text();
  if (!text.trim()) {
    throw new Error(`Empty response from backend (${resp.status}).`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Non-JSON response from backend (${resp.status}).`);
  }
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escAttr(value) {
  return escHtml(value).replace(/`/g, "&#96;");
}
