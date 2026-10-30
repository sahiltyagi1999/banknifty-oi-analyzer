let instrument = "NIFTY";
let authToken = localStorage.getItem("oi_auth_token") || "";
let currentUser = localStorage.getItem("oi_username") || "";
let latestSnapshot = null;
let frontendEnv = {};
let activeHistoryId = "";
let aiEnabled = false;
let csvType = "chain";
let currentAnalysisId = "";
let currentFileName = "";
let savePromise = Promise.resolve();
let currentView = "oi";
let newsInstrument = "NIFTY";
let newsLoading = false;
let newsLoaded = {};
let newsFilter = "";
let lastNews = null;

const CONFIG = window.OI_ANALYZER_CONFIG || {};
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

    const username = document.getElementById("loginUsername").value.trim();
    const password = document.getElementById("loginPassword").value;

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
    return "Server unreachable. Please try again in a moment.";
  }
  return error.message || "Login failed.";
}

function bindActions() {
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });
  document.querySelectorAll("#newsView [data-inst]").forEach((btn) => {
    btn.addEventListener("click", () => {
      newsInstrument = btn.dataset.inst;
      document.getElementById("newsTabNifty").classList.toggle("active", newsInstrument === "NIFTY");
      document.getElementById("newsTabBank").classList.toggle("active", newsInstrument === "BANKNIFTY");
      loadNews();
    });
  });
  document.getElementById("newsFetchBtn").addEventListener("click", () => loadNews(true));
  document.getElementById("refreshHistoryBtn").addEventListener("click", loadHistory);
  document.getElementById("typeChain").addEventListener("click", () => setCsvType("chain"));
  document.getElementById("typeStrike").addEventListener("click", () => setCsvType("strike"));
  document.getElementById("aiToggle").addEventListener("change", (event) => {
    aiEnabled = event.target.checked;
    const state = document.getElementById("aiToggleState");
    state.textContent = aiEnabled ? "On" : "Off";
    state.className = aiEnabled ? "bull" : "";
  });
  document.getElementById("uploadNewBtn").addEventListener("click", () => {
    const input = document.getElementById("fileInput");
    input.value = "";
    input.click();
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

function setView(view) {
  currentView = view;
  document.getElementById("appView").classList.toggle("hidden", view !== "oi");
  document.getElementById("newsView").classList.toggle("hidden", view !== "news");
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  if (view === "news" && !newsLoaded[newsInstrument]) loadNews();
}

function showLogin() {
  document.getElementById("loginView").classList.remove("hidden");
  document.getElementById("appView").classList.add("hidden");
  document.getElementById("newsView").classList.add("hidden");
  document.getElementById("mainNav").classList.add("hidden");
  document.getElementById("logoutBtn").classList.add("hidden");
  document.getElementById("userPill").textContent = "Not logged in";
}

function showApp() {
  document.getElementById("loginView").classList.add("hidden");
  document.getElementById("mainNav").classList.remove("hidden");
  setView(currentView);
  document.getElementById("logoutBtn").classList.remove("hidden");
  document.getElementById("userPill").textContent = currentUser || "Logged in";
}

function logout() {
  authToken = "";
  currentUser = "";
  localStorage.removeItem("oi_auth_token");
  localStorage.removeItem("oi_username");
  reset();
  currentView = "oi";
  newsLoaded = {};
  document.getElementById("newsBody").innerHTML =
    '<div class="empty-state">Click <strong>Fetch Latest News</strong> to load headlines and a sentiment score.</div>';
  setView("oi");
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
  updateUploadSub();
}

function setCsvType(type) {
  csvType = type;
  document.getElementById("typeChain").classList.toggle("active", type === "chain");
  document.getElementById("typeStrike").classList.toggle("active", type === "strike");
  document.getElementById("strikeField").classList.toggle("hidden", type !== "strike");
  updateUploadSub();
}

function updateUploadSub() {
  const name = instrument === "NIFTY" ? "Nifty 50" : "Bank Nifty";
  document.getElementById("uploadSub").textContent = csvType === "strike"
    ? `${name} single-strike CSV (one strike, all expiries) from NSE`
    : `${name} options-chain CSV (all strikes, one expiry) from NSE`;
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
  reader.onload = (event) => {
    activeHistoryId = "";
    markActiveHistory();
    currentFileName = file.name;
    if (!parseCSV(event.target.result, file.name)) return;
    const name = instrument === "NIFTY" ? "Nifty 50" : "Bank Nifty";
    const strikePart = csvType === "strike" ? ` · Strike ${latestSnapshot.levels.strike.toLocaleString()}` : "";
    setSource(`${name}${strikePart} · ${file.name}`);
  };
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

function detectCsvType(lines) {
  for (const line of lines.slice(0, 6)) {
    const up = line.toUpperCase();
    if (up.includes("EXPIRY DATE")) return "strike";
    if (up.includes("STRIKE") && (up.includes(",OI,") || up.includes("VOLUME"))) return "chain";
  }
  return null;
}

function parseCSV(text, fileName = "") {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const detected = detectCsvType(lines);
  if (detected && detected !== csvType) setCsvType(detected);
  return csvType === "strike" ? parseStrikeCSV(lines, fileName) : parseChainCSV(lines);
}

function parseChainCSV(lines) {
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
  const otherInst = instrument === "NIFTY" ? "BANKNIFTY" : "NIFTY";
  const otherRange = STRIKE_RANGE[otherInst];
  let otherCount = 0;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]);
    if (cols.length < 12) continue;

    const rawStrike = strikeCol !== -1 && strikeCol < cols.length ? numVal(cols[strikeCol]) : 0;
    if (rawStrike >= otherRange.min && rawStrike <= otherRange.max && (rawStrike < sr.min || rawStrike > sr.max)) {
      otherCount++;
    }

    let strike = strikeCol !== -1 && strikeCol < cols.length ? numVal(cols[strikeCol]) : NaN;
    if (strikeCol === -1 || !strike) {
      strike = NaN;
      for (const col of cols) {
        const value = numVal(col);
        if (value >= sr.min && value <= sr.max && value % 50 === 0) {
          strike = value;
          break;
        }
      }
    }
    if (!strike || Number.isNaN(strike) || strike < sr.min || strike > sr.max) continue;

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
    if (otherCount) {
      const names = { NIFTY: "Nifty 50", BANKNIFTY: "Bank Nifty" };
      alert(`These strikes look like ${names[otherInst]}, but ${names[instrument]} is selected. Switch the instrument and upload again.`);
    } else {
      alert("Could not read any strikes from this CSV. Please upload the full NSE option-chain CSV (all strikes for one expiry).");
    }
    return false;
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
  return true;
}

/* ---------- Single-strike CSV (one strike across expiries) ---------- */

function guessStrikeFromName(fileName) {
  const base = String(fileName).replace(/\.csv$/i, "");
  for (const match of base.match(/\d[\d,]*(?:\.\d+)?/g) || []) {
    const value = numVal(match);
    if (value >= STRIKE_RANGE.NIFTY.min && value <= STRIKE_RANGE.BANKNIFTY.max) return value;
  }
  return 0;
}

function resolveStrike(fileName) {
  const typed = numVal(document.getElementById("strikeInput").value);
  let strike = typed || guessStrikeFromName(fileName);
  if (!strike) {
    strike = numVal(window.prompt("Enter the strike price of this CSV (e.g. 23050):") || "");
  }
  if (!strike) {
    document.getElementById("strikeInput").focus();
    alert("Strike price is needed for a single-strike CSV. Type it in the Strike Price box and upload again.");
    return 0;
  }
  const sr = STRIKE_RANGE[instrument];
  if (strike < sr.min || strike > sr.max) {
    const names = { NIFTY: "Nifty 50", BANKNIFTY: "Bank Nifty" };
    const other = instrument === "NIFTY" ? "BANKNIFTY" : "NIFTY";
    const otherRange = STRIKE_RANGE[other];
    alert(
      strike >= otherRange.min && strike <= otherRange.max
        ? `Strike ${strike.toLocaleString()} looks like ${names[other]}, but ${names[instrument]} is selected. Switch the instrument and upload again.`
        : `Strike ${strike.toLocaleString()} is outside the ${names[instrument]} range. Check the Strike Price box.`,
    );
    return 0;
  }
  return strike;
}

function parseStrikeCSV(lines, fileName) {
  const headerIdx = lines.findIndex((line) => line.toUpperCase().includes("EXPIRY DATE"));
  const rows = [];
  for (let i = (headerIdx === -1 ? 1 : headerIdx) + 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]);
    if (cols.length < 22 || !/\d{1,2}-[A-Za-z]{3}-\d{4}/.test(cols[11])) continue;
    rows.push({
      expiry: cols[11],
      callOI: numVal(cols[1]),
      callChg: numVal(cols[2]),
      callVol: numVal(cols[3]),
      callIV: numVal(cols[4]),
      callLTP: numVal(cols[5]),
      putLTP: numVal(cols[17]),
      putIV: numVal(cols[18]),
      putVol: numVal(cols[19]),
      putChg: numVal(cols[20]),
      putOI: numVal(cols[21]),
    });
  }
  if (!rows.length) {
    alert("Could not read any expiries from this CSV. Please upload the NSE single-strike CSV (one strike, all expiries).");
    return false;
  }

  const strike = resolveStrike(fileName);
  if (!strike) return false;

  const data = computeStrikeData(strike, rows);
  latestSnapshot = buildStrikeSnapshot(data);
  renderDashboard(data);
  return true;
}

function expiryTime(text) {
  const time = new Date(String(text).replace(/-/g, " ")).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function computeStrikeData(strike, rawRows) {
  const rows = [...rawRows].sort((a, b) => expiryTime(a.expiry) - expiryTime(b.expiry));
  const sum = (key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  const totalCallOI = sum("callOI");
  const totalPutOI = sum("putOI");
  const nearest = rows.find((row) => row.callLTP > 0 && row.putLTP > 0) || rows[0];
  const hasPremium = nearest.callLTP > 0 && nearest.putLTP > 0;
  const straddle = hasPremium ? nearest.callLTP + nearest.putLTP : 0;
  return {
    mode: "strike",
    strike,
    rows,
    totalCallOI,
    totalPutOI,
    totalCallChg: sum("callChg"),
    totalPutChg: sum("putChg"),
    pcr: totalCallOI > 0 ? totalPutOI / totalCallOI : 1,
    nearest,
    nearestPcr: nearest.callOI > 0 ? nearest.putOI / nearest.callOI : 0,
    straddle,
    impliedSpot: hasPremium ? strike + nearest.callLTP - nearest.putLTP : 0,
    upperBE: straddle ? strike + straddle : 0,
    lowerBE: straddle ? strike - straddle : 0,
  };
}

function buildStrikeSnapshot(data) {
  const round = (n) => Number(Number(n).toFixed(2));
  return {
    instrument,
    mode: "strike",
    fileName: currentFileName,
    metrics: { pcr: round(data.pcr), totalCallOI: data.totalCallOI, totalPutOI: data.totalPutOI },
    levels: {
      strike: data.strike,
      nearestExpiry: data.nearest.expiry,
      straddle: round(data.straddle),
      impliedSpot: round(data.impliedSpot),
      upperBE: round(data.upperBE),
      lowerBE: round(data.lowerBE),
    },
    expiryRows: data.rows,
  };
}

function guessExpiryFromName(fileName) {
  const match = String(fileName).match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  return match ? `${match[1].padStart(2, "0")} ${match[2]} ${match[3]}` : "";
}

function buildSnapshot(data) {
  const { rows, totalCallOI, totalPutOI, pcr, maxCallRow, maxPutRow, atmRow } = data;
  return {
    instrument,
    expiry: guessExpiryFromName(currentFileName),
    fileName: currentFileName,
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
    chartRows: getChartRows(rows, atmRow).map(({ strike, callOI, callChg, putOI, putChg }) => ({
      strike,
      callOI,
      callChg,
      putOI,
      putChg,
    })),
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
  renderOiSections(data, instrument);
  showDashboard(true);
  saveSnapshot();
  if (aiEnabled) {
    generateAISignal();
  } else {
    showAiPrompt();
  }
}

function renderOiSections(data, inst) {
  const isStrike = data.mode === "strike";
  document.getElementById("expiryTablePanel").classList.toggle("hidden", !isStrike);
  document.getElementById("oiPanelTitle").textContent = isStrike
    ? `Open Interest By Expiry · Strike ${data.strike.toLocaleString()}`
    : "Open Interest By Strike";
  document.getElementById("levelsPanelTitle").textContent = isStrike ? "Breakevens & Spot" : "Key Levels";
  if (isStrike) {
    renderStrikeSections(data, inst);
    return;
  }

  const { rows, totalCallOI, totalPutOI, pcr, maxCallRow, maxPutRow, atmRow } = data;
  const { bias, biasClass } = getBias(pcr);

  const banner = document.getElementById("signalBanner");
  banner.className = `signal-banner ${biasClass}`;
  document.getElementById("sigWord").textContent = bias;
  document.getElementById("pcrBig").textContent = pcr.toFixed(2);
  document.getElementById("sigTag").textContent =
    `${inst === "BANKNIFTY" ? "Bank Nifty" : "Nifty 50"} Bias`;

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
}

function showAiPrompt(errorMessage = "") {
  const loading = document.getElementById("aiLoading");
  loading.className = "ai-loading prompt";
  loading.style.display = "flex";
  loading.innerHTML = `
    ${errorMessage ? `<span class="warn">AI signal unavailable (${escHtml(errorMessage)}) - OI data above is still valid.</span>` : ""}
    <button class="ai-cta" id="aiRunBtn" type="button">
      <span class="ai-cta-inner"><span class="ai-spark">&#10022;</span>${errorMessage ? "Retry with AI" : "Analyse with AI"}</span>
    </button>
    ${errorMessage ? "" : '<span class="ai-hint">Adds an AI trade plan to this saved analysis.</span>'}`;
  document.getElementById("aiContent").classList.remove("show");
  document.getElementById("aiRunBtn").addEventListener("click", generateAISignal);
}

function showDashboard(withCsvPanels) {
  document.getElementById("uploadSection").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");
  document.getElementById("uploadNewBtn").classList.remove("hidden");
  document.getElementById("metricsGrid").classList.toggle("hidden", !withCsvPanels);
  document.getElementById("csvPanels").classList.toggle("hidden", !withCsvPanels);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setSource(text) {
  const info = document.getElementById("sourceInfo");
  info.classList.toggle("hidden", !text);
  document.getElementById("sourceName").textContent = text || "--";
  document.getElementById("sourceName").title = text || "";
}

function directionClass(dir) {
  const d = String(dir || "").toUpperCase();
  if (d === "BUY CALL") return "bull";
  if (d === "BUY PUT") return "bear";
  return "warn";
}

function markActiveHistory() {
  document.querySelectorAll(".history-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.id === String(activeHistoryId));
  });
}

function getBias(pcr) {
  if (pcr > 1.5) return { bias: "Strongly Bullish", biasClass: "bull" };
  if (pcr > 1.2) return { bias: "Bullish", biasClass: "bull" };
  if (pcr > 0.9) return { bias: "Neutral", biasClass: "neut" };
  if (pcr > 0.7) return { bias: "Bearish", biasClass: "bear" };
  return { bias: "Strongly Bearish", biasClass: "bear" };
}

function getChartRows(rows, atmRow) {
  const atmIdx = rows.indexOf(atmRow);
  return rows.slice(Math.max(0, atmIdx - 5), Math.min(rows.length, atmIdx + 6));
}

function renderOiChart(rows, atmRow, maxCallRow, maxPutRow) {
  const visible = getChartRows(rows, atmRow);
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
        <div class="oi-row ${isATM ? "is-atm" : ""}">
          <div class="call-num">${fmt(row.callOI)}</div>
          <div class="bar-wrap-call"><div class="bar call" style="width:${callW}%"></div></div>
          <div class="strike-label ${isATM ? "atm-tag" : ""}">
            ${row.strike.toLocaleString()}${isATM ? '<em class="tag atm">ATM</em>' : ""}${isMaxC ? '<em class="tag res">R</em>' : ""}${isMaxP ? '<em class="tag sup">S</em>' : ""}
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

function setSaveBadge(state) {
  const badge = document.getElementById("saveBadge");
  const labels = {
    saving: "Saving...",
    saved: "Saved",
    ai: "Saved + AI plan",
    failed: "Not saved",
  };
  badge.classList.toggle("hidden", !state);
  badge.textContent = labels[state] || "";
  badge.className = `save-badge ${state || "hidden"}`;
}

function saveSnapshot() {
  const snap = latestSnapshot;
  currentAnalysisId = "";
  setSaveBadge("saving");
  savePromise = (async () => {
    try {
      const res = await fetch(apiUrl("/api/analyses"), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ snapshot: snap }),
      });
      const data = await readApiJson(res);
      if (!res.ok || !data.id) throw new Error(data.error || "Not saved.");
      if (latestSnapshot === snap) {
        currentAnalysisId = data.id;
        activeHistoryId = data.id;
        setSaveBadge("saved");
      }
      await loadHistory();
    } catch (error) {
      if (latestSnapshot === snap) setSaveBadge("failed");
    }
  })();
  return savePromise;
}

function snapshotFromSaved(item) {
  return {
    instrument: item.instrument,
    expiry: item.expiry || undefined,
    fileName: item.file_name || undefined,
    mode: item.mode === "strike" ? "strike" : undefined,
    metrics: item.metrics,
    levels: item.levels,
    topStrikes: item.top_strikes,
    chartRows: item.chart_rows,
    expiryRows: item.expiry_rows,
  };
}

async function generateAISignal() {
  if (!latestSnapshot) return;
  setAiLoading("Generating AI analysis...");

  try {
    await savePromise;
    const res = await fetch(apiUrl("/api/analyze"), {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ snapshot: latestSnapshot, analysis_id: currentAnalysisId || undefined }),
    });
    const data = await readApiJson(res);
    if (!res.ok) throw new Error(data.error || "AI analysis failed.");

    renderTradeplan(data.analysis);
    if (data.id) {
      currentAnalysisId = data.id;
      activeHistoryId = data.id;
      setSaveBadge("ai");
    }
    await loadHistory();
  } catch (error) {
    showAiError(error.message || "AI analysis failed.");
  }
}

function setAiLoading(message) {
  const loading = document.getElementById("aiLoading");
  loading.className = "ai-loading";
  loading.style.display = "flex";
  loading.innerHTML = `<div class="spin"></div>${escHtml(message)}`;
  document.getElementById("aiContent").classList.remove("show");
}

function showAiError(message) {
  if (latestSnapshot) {
    showAiPrompt(message);
    return;
  }
  document.getElementById("aiLoading").className = "ai-loading";
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

function csvTypeLabel(item) {
  if (item.mode === "strike") {
    const strike = item.strike ? Number(item.strike).toLocaleString() : "";
    return { kind: "strike", head: "STRIKE", detail: strike || "single strike", sub: "all expiries" };
  }
  return { kind: "expiry", head: "EXPIRY", detail: item.expiry || "full chain", sub: item.expiry ? "all strikes" : "all strikes" };
}

function hasAnalysis(item) {
  return item.has_analysis ?? Object.keys(item.analysis || {}).length > 0;
}

function renderHistory(items) {
  const list = document.getElementById("historyList");
  if (!items.length) {
    list.innerHTML = '<div class="empty-state">No saved analysis yet.</div>';
    return;
  }

  list.innerHTML = items.map((item) => `
    <button class="history-item ${hasAnalysis(item) ? directionClass(item.primary_direction) : "none"}-item" type="button" data-id="${escAttr(item.id)}">
      <div class="history-meta">
        <span class="inst-chip">${escHtml(item.instrument || "-")}</span>
        <span>${formatTime(item.created_at)}</span>
      </div>
      ${(() => {
        const t = csvTypeLabel(item);
        return `<div class="type-row"><span class="type-tag ${t.kind}"><b>${t.head}</b> ${escHtml(t.detail)}</span><span class="type-sub">${t.sub}</span></div>`;
      })()}
      <div class="history-signal ${hasAnalysis(item) ? directionClass(item.primary_direction) : "muted"}">${hasAnalysis(item) ? escHtml(item.primary_direction || "WAIT") : "No AI plan yet"}</div>
      <div class="history-meta">
        <span>${hasAnalysis(item) ? `AI pick ${escHtml(item.suggested_strike || "-")}` : "Not analysed"}</span>
        <span>PCR ${escHtml(item.metrics?.pcr ?? "-")}</span>
      </div>
    </button>`).join("");

  list.querySelectorAll(".history-item").forEach((button) => {
    button.addEventListener("click", () => loadHistoryDetail(button.dataset.id));
  });
  markActiveHistory();
}

async function loadHistoryDetail(id) {
  try {
    const res = await fetch(apiUrl(`/api/analyses/${id}`), { headers: authHeaders() });
    const data = await readApiJson(res);
    if (!res.ok) throw new Error(data.error || "Could not load analysis.");
    activeHistoryId = id;
    markActiveHistory();
    renderSavedAnalysis(data);
  } catch (error) {
    showAiError(error.message || "Could not load analysis.");
  }
}

function buildSavedData(item) {
  if (item.mode === "strike") {
    const strike = Number(item.levels?.strike);
    return strike && item.expiry_rows?.length ? computeStrikeData(strike, item.expiry_rows) : null;
  }
  const levels = item.levels || {};
  const metrics = item.metrics || {};
  const source = item.chart_rows?.length ? item.chart_rows : item.top_strikes;
  if (!levels.atm || !source?.length) return null;

  const rows = source
    .map((row) => ({
      strike: Number(row.strike),
      callOI: Number(row.callOI) || 0,
      callChg: Number(row.callChg) || 0,
      putOI: Number(row.putOI) || 0,
      putChg: Number(row.putChg) || 0,
    }))
    .sort((a, b) => a.strike - b.strike);

  let atmRow = rows.find((row) => row.strike === levels.atm);
  if (!atmRow) {
    atmRow = { strike: levels.atm, callOI: 0, callChg: 0, putOI: 0, putChg: 0 };
    rows.push(atmRow);
    rows.sort((a, b) => a.strike - b.strike);
  }

  const totalCallOI = Number(metrics.totalCallOI) || 0;
  const totalPutOI = Number(metrics.totalPutOI) || 0;
  const pcr = Number(metrics.pcr) || (totalCallOI ? totalPutOI / totalCallOI : 1);
  return {
    rows,
    totalCallOI,
    totalPutOI,
    pcr,
    atmRow,
    maxCallRow: { strike: levels.maxCallStrike, callOI: levels.maxCallOI || 0, callChg: levels.maxCallChg || 0 },
    maxPutRow: { strike: levels.maxPutStrike, putOI: levels.maxPutOI || 0, putChg: levels.maxPutChg || 0 },
  };
}

function renderSavedAnalysis(item) {
  const data = buildSavedData(item);
  const kind = csvTypeLabel(item);
  setSource(`Saved · ${item.instrument || "-"} · ${kind.head[0]}${kind.head.slice(1).toLowerCase()} ${kind.detail} · ${formatTime(item.created_at)}`);

  if (data) {
    renderOiSections(data, item.instrument);
    showDashboard(true);
    if (data.mode !== "strike" && !item.chart_rows?.length) {
      document.getElementById("oiChart").insertAdjacentHTML(
        "beforeend",
        '<div class="chart-note">Older save: showing the highest-OI strikes only.</div>',
      );
    }
  } else {
    showDashboard(false);
    const dirCls = directionClass(item.analysis?.primary_direction);
    document.getElementById("sigTag").textContent = `${item.instrument || "Saved"} Analysis`;
    document.getElementById("sigWord").textContent = item.analysis?.primary_direction || "Saved";
    document.getElementById("pcrBig").textContent = item.metrics?.pcr ?? "--";
    document.getElementById("signalBanner").className =
      `signal-banner ${dirCls === "warn" ? "neut" : dirCls}`;
  }
  latestSnapshot = snapshotFromSaved(item);
  currentAnalysisId = item.id;
  savePromise = Promise.resolve();
  setSaveBadge(hasAnalysis(item) ? "ai" : "saved");
  if (hasAnalysis(item)) {
    renderTradeplan(item.analysis);
  } else {
    showAiPrompt();
  }
}

function reset() {
  currentAnalysisId = "";
  setSaveBadge(null);
  latestSnapshot = null;
  activeHistoryId = "";
  markActiveHistory();
  setSource("");
  document.getElementById("uploadNewBtn").classList.add("hidden");
  document.getElementById("uploadSection").classList.remove("hidden");
  document.getElementById("dashboard").classList.add("hidden");
  document.getElementById("fileInput").value = "";
  document.getElementById("aiLoading").className = "ai-loading";
  document.getElementById("aiLoading").style.display = "flex";
  document.getElementById("aiLoading").innerHTML = '<div class="spin"></div>Generating AI analysis...';
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

function parseServerDate(value) {
  if (!value) return null;
  let text = String(value);
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) text += "Z";
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timeAgo(value) {
  const date = parseServerDate(value);
  if (!date) return "-";
  const mins = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatTime(value) {
  const date = parseServerDate(value);
  if (!date) return "-";
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
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

/* ---------- News sentiment ---------- */

async function loadNews(forceRefresh = false) {
  if (newsLoading || !authToken) return;
  newsLoading = true;
  const body = document.getElementById("newsBody");
  const btn = document.getElementById("newsFetchBtn");
  const instName = newsInstrument === "BANKNIFTY" ? "Bank Nifty" : "Nifty 50";
  btn.disabled = true;
  body.innerHTML = `<div class="ai-loading"><div class="spin"></div>Fetching ${escHtml(instName)} news and scoring sentiment...</div>`;

  try {
    const query = `instrument=${newsInstrument}${forceRefresh ? "&refresh=1" : ""}`;
    const res = await fetch(apiUrl(`/api/news?${query}`), { headers: authHeaders() });
    const data = await readApiJson(res);
    if (!res.ok) throw new Error(data.error || "Could not load news.");
    newsLoaded[newsInstrument] = true;
    newsFilter = data.scope;
    renderNews(data);
  } catch (error) {
    body.innerHTML = `<div class="empty-state warn">${escHtml(error.message || "Could not load news.")}</div>`;
  } finally {
    newsLoading = false;
    btn.disabled = false;
  }
}

function renderNews(data) {
  const instName = data.instrument === "BANKNIFTY" ? "Bank Nifty" : "Nifty 50";
  const total = data.counts.bullish + data.counts.bearish + data.counts.neutral || 1;
  const pct = (n) => ((n / total) * 100).toFixed(0);

  document.getElementById("newsUpdated").classList.remove("hidden");
  document.getElementById("newsUpdatedAt").textContent = formatTime(data.fetched_at);

  const categories = data.categories.map((c) => {
    const cls = c.score >= 54 ? "bull" : c.score <= 46 ? "bear" : "warn";
    return `
      <div class="cat-row">
        <div class="cat-name">${escHtml(c.name)}<span>${c.count} headlines</span></div>
        <div class="cat-bar"><i class="${cls}-fill" style="width:${c.score}%"></i></div>
        <div class="cat-score ${cls}">${c.score}</div>
      </div>`;
  }).join("");

  lastNews = data;
  const topics = [data.scope, "All", ...data.categories.map((c) => c.name).filter((n) => n !== data.scope)];
  const filterChips = topics.map((name) => `
    <button class="filter-chip ${name === newsFilter ? "active" : ""}" type="button" data-filter="${escAttr(name)}">${escHtml(name)}</button>`).join("");
  const shown = data.items.filter((item) => newsFilter === "All" || item.category === newsFilter);

  const items = shown.map((item) => `
    <a class="news-item" href="${escAttr(item.link)}" target="_blank" rel="noopener noreferrer">
      <span class="news-pill ${escAttr(item.label)}">${escHtml(item.label)}</span>
      <div class="news-main">
        <div class="news-title">${escHtml(item.title)}</div>
        <div class="news-meta">
          <span>${escHtml(item.source)}</span>
          <span>${escHtml(item.category)}${item.inverse ? " (inverse)" : ""}</span>
          <span>${formatTime(item.published_at)} IST &middot; ${timeAgo(item.published_at)}</span>
        </div>
      </div>
    </a>`).join("");

  document.getElementById("newsBody").innerHTML = `
    <div class="news-summary">
      <section class="sentiment-card ${escAttr(data.bias_class)}">
        <div class="section-label">Overall Sentiment &middot; ${escHtml(instName)}</div>
        <div class="sent-score"><strong>${data.score}</strong><span>/ 100</span></div>
        <div class="sent-bias">${escHtml(data.bias)}</div>
        <div class="sent-meter"><i style="left:${Math.max(2, Math.min(98, data.score))}%"></i></div>
        <div class="sent-meter-labels"><span>Bearish</span><span>Neutral</span><span>Bullish</span></div>
        <div class="sent-counts">
          <div><strong class="bull">${data.counts.bullish}</strong><span>Bullish (${pct(data.counts.bullish)}%)</span></div>
          <div><strong class="warn">${data.counts.neutral}</strong><span>Neutral (${pct(data.counts.neutral)}%)</span></div>
          <div><strong class="bear">${data.counts.bearish}</strong><span>Bearish (${pct(data.counts.bearish)}%)</span></div>
        </div>
        <div class="drv-note">Based only on <strong>${escHtml(data.scope)}</strong> headlines (${data.counts.bullish + data.counts.bearish + data.counts.neutral}). The topics on the right are extra context and are not part of this score.</div>
      </section>
      <section class="panel">
        <div class="panel-title">Related Factors &middot; for context</div>
        <div class="cat-list">${categories || '<div class="empty-state">No topics.</div>'}</div>
        <div class="news-note">Scored from headline keywords, newer news counts more. Related topics are scored separately. Crude oil is inverse: a price rise is bearish for India. Indicative only, not financial advice.</div>
      </section>
    </div>
    <section class="panel">
      <div class="panel-title">Latest Headlines (${shown.length})</div>
      <div class="filter-row">${filterChips}</div>
      <div class="news-list">${items || '<div class="empty-state">No recent headlines found.</div>'}</div>
    </section>`;
}

function shortExpiry(text) {
  const [day, mon, year] = String(text).split("-");
  return year ? `${day} ${mon} ${year.slice(-2)}` : text;
}

function renderStrikeSections(data, inst) {
  const { bias, biasClass } = getBias(data.pcr);
  const name = inst === "BANKNIFTY" ? "Bank Nifty" : "Nifty 50";
  document.getElementById("signalBanner").className = `signal-banner ${biasClass}`;
  document.getElementById("sigWord").textContent = bias;
  document.getElementById("pcrBig").textContent = data.pcr.toFixed(2);
  document.getElementById("sigTag").textContent = `${name} · ${data.strike.toLocaleString()} Strike Bias`;

  const pcrColor = biasClass === "bull" ? "bull" : biasClass === "bear" ? "bear" : "warn";
  const money = (n) => (n > 0 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "-");
  document.getElementById("metricsGrid").innerHTML = [
    { label: "PCR (All Expiries)", val: data.pcr.toFixed(2), cls: pcrColor },
    { label: "Total Call OI", val: fmt(data.totalCallOI), cls: "bear" },
    { label: "Total Put OI", val: fmt(data.totalPutOI), cls: "bull" },
    { label: "Nearest Expiry PCR", val: data.nearestPcr ? data.nearestPcr.toFixed(2) : "-", cls: "warn" },
    { label: "Implied Spot", val: data.impliedSpot ? Math.round(data.impliedSpot).toLocaleString() : "-", cls: "blue" },
    { label: "Straddle Premium", val: money(data.straddle), cls: "warn" },
    { label: "Call IV (Nearest)", val: data.nearest.callIV ? `${data.nearest.callIV}%` : "-", cls: "bear" },
    { label: "Put IV (Nearest)", val: data.nearest.putIV ? `${data.nearest.putIV}%` : "-", cls: "bull" },
  ].map((m) => `
    <div class="metric">
      <div class="metric-label">${m.label}</div>
      <div class="metric-val ${m.cls}">${m.val}</div>
    </div>`).join("");

  const maxOI = Math.max(...data.rows.map((row) => Math.max(row.callOI, row.putOI))) || 1;
  document.getElementById("oiChart").innerHTML = `
    <div class="oi-row header">
      <div>CALL OI</div><div></div><div>EXPIRY</div><div></div><div>CHG</div><div>PUT OI</div>
    </div>
    ${data.rows.map((row) => `
      <div class="oi-row ${row === data.nearest ? "is-atm" : ""}">
        <div class="call-num">${fmt(row.callOI)}</div>
        <div class="bar-wrap-call"><div class="bar call" style="width:${((row.callOI / maxOI) * 100).toFixed(1)}%"></div></div>
        <div class="strike-label">${escHtml(shortExpiry(row.expiry))}${row === data.nearest ? '<em class="tag atm">NEAR</em>' : ""}</div>
        <div class="bar-wrap-put"><div class="bar put" style="width:${((row.putOI / maxOI) * 100).toFixed(1)}%"></div></div>
        <div class="chg ${row.putChg > 0 ? "pos" : ""}">${row.putChg > 0 ? "+" : ""}${fmt(row.putChg)}</div>
        <div class="put-num">${fmt(row.putOI)}</div>
      </div>`).join("")}`;

  const levels = [];
  if (data.upperBE) levels.push({ name: "Upper Breakeven", val: Math.round(data.upperBE).toLocaleString(), cls: "bear" });
  if (data.impliedSpot) levels.push({ name: "Implied Spot", val: Math.round(data.impliedSpot).toLocaleString(), cls: "blue" });
  levels.push({ name: "Strike", val: data.strike.toLocaleString(), cls: "warn" });
  if (data.lowerBE) levels.push({ name: "Lower Breakeven", val: Math.round(data.lowerBE).toLocaleString(), cls: "bull" });
  levels.push({ name: "Nearest Expiry", val: shortExpiry(data.nearest.expiry), cls: "" });
  document.getElementById("levelList").innerHTML = levels.map((level) => `
    <div class="level-item">
      <div class="level-name">${level.name}</div>
      <div class="level-val ${level.cls}">${level.val}</div>
    </div>`).join("") +
    '<div class="chart-note">Implied spot and breakevens come from nearest-expiry option prices (LTP), so treat them as approximate.</div>';

  document.getElementById("expiryTableTitle").textContent = `Expiry-wise Data · Strike ${data.strike.toLocaleString()}`;
  const num = (v) => (v ? fmt(v) : "-");
  const price = (v) => (v ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "-");
  const chg = (v) => (v ? `${v > 0 ? "+" : ""}${fmt(v)}` : "-");
  document.getElementById("expiryTableWrap").innerHTML = `
    <table class="trade-table expiry-table">
      <thead><tr>
        <th>Expiry</th><th>Call OI</th><th>Chg OI</th><th>Volume</th><th>IV</th><th>LTP</th>
        <th>Put LTP</th><th>IV</th><th>Volume</th><th>Chg OI</th><th>Put OI</th><th>PCR</th>
      </tr></thead>
      <tbody>${data.rows.map((row) => {
        const rowPcr = row.callOI > 0 ? row.putOI / row.callOI : 0;
        return `
        <tr class="${row === data.nearest ? "near-row" : ""}">
          <td class="label-col">${escHtml(row.expiry)}</td>
          <td class="num bear">${num(row.callOI)}</td>
          <td class="num ${row.callChg > 0 ? "bear" : ""}">${chg(row.callChg)}</td>
          <td class="num">${num(row.callVol)}</td>
          <td class="num">${row.callIV || "-"}</td>
          <td class="num">${price(row.callLTP)}</td>
          <td class="num">${price(row.putLTP)}</td>
          <td class="num">${row.putIV || "-"}</td>
          <td class="num">${num(row.putVol)}</td>
          <td class="num ${row.putChg > 0 ? "bull" : ""}">${chg(row.putChg)}</td>
          <td class="num bull">${num(row.putOI)}</td>
          <td class="num ${rowPcr >= 1 ? "bull" : "bear"}">${rowPcr ? rowPcr.toFixed(2) : "-"}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>`;
}

document.addEventListener("click", (event) => {
  const chip = event.target.closest?.(".filter-chip");
  if (!chip || !lastNews) return;
  newsFilter = chip.dataset.filter;
  renderNews(lastNews);
});
