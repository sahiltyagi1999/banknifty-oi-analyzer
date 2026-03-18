// ── API KEY MANAGEMENT ──
let apiKey = '';

function loadSavedKey() {
  try {
    const saved = localStorage.getItem('oi_analyzer_api_key');
    if (saved) {
      apiKey = saved;
      document.getElementById('apiKeyInput').value = saved;
      showApiStatus('ok', 'KEY SAVED');
    }
  } catch (e) {}
}

function onApiKeyChange() {
  const val = document.getElementById('apiKeyInput').value.trim();
  if (!val) {
    hideApiStatus();
  } else if (val.startsWith('sk-ant-')) {
    showApiStatus('ok', 'LOOKS GOOD');
  } else {
    showApiStatus('err', 'INVALID FORMAT');
  }
}

function saveApiKey() {
  const val = document.getElementById('apiKeyInput').value.trim();
  if (!val) { showApiStatus('err', 'EMPTY KEY'); return; }
  if (!val.startsWith('sk-ant-')) { showApiStatus('err', 'INVALID FORMAT'); return; }
  apiKey = val;
  try { localStorage.setItem('oi_analyzer_api_key', val); } catch (e) {}
  showApiStatus('ok', 'SAVED ✓');
}

function showApiStatus(type, msg) {
  const el = document.getElementById('apiStatus');
  el.className = `api-status ${type}`;
  el.textContent = msg;
}

function hideApiStatus() {
  document.getElementById('apiStatus').className = 'api-status';
}

function toggleApiVisibility() {
  const inp = document.getElementById('apiKeyInput');
  const btn = document.getElementById('eyeBtn');
  if (inp.type === 'password') { inp.type = 'text';     btn.textContent = '🙈'; }
  else                          { inp.type = 'password'; btn.textContent = '👁'; }
}

// ── LIVE CLOCK (IST) ──
setInterval(() => {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const p = n => String(n).padStart(2, '0');
  document.getElementById('clockEl').textContent =
    `${p(ist.getHours())}:${p(ist.getMinutes())}:${p(ist.getSeconds())} IST`;
}, 1000);

// Load saved API key on page load
loadSavedKey();

// ── DRAG & DROP ──
const dz = document.getElementById('dropZone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', e => {
  e.preventDefault();
  dz.classList.remove('drag');
  handleFile(e.dataTransfer.files[0]);
});
document.getElementById('fileInput').addEventListener('change', e => handleFile(e.target.files[0]));

function handleFile(file) {
  if (!file || !file.name.endsWith('.csv')) {
    alert('Please upload a CSV file from NSE.');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => parseCSV(e.target.result);
  reader.readAsText(file);
}

// ── RFC-4180 CSV row parser — handles quoted fields containing commas ──
function parseCSVRow(line) {
  const cols = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

// Strip commas and parse float; return 0 for dashes / blanks
function numVal(s) {
  if (!s || s === '-') return 0;
  return parseFloat(s.replace(/,/g, '')) || 0;
}

// ── PARSE NSE OPTIONS CHAIN CSV ──
// Actual NSE download format:
//   Line 0: CALLS,,PUTS
//   Line 1: ,OI,CHNG IN OI,VOLUME,IV,LTP,CHNG,BID QTY,BID,ASK,ASK QTY,STRIKE,BID QTY,BID,ASK,ASK QTY,CHNG,LTP,IV,VOLUME,CHNG IN OI,OI,
//   Line 2+: data  (col 0 blank, col 1=callOI, col 2=callChgOI, col 5=callLTP,
//                   col 11=STRIKE, col 16=putChng, col 17=putLTP,
//                   col 20=putChgOI, col 21=putOI, col 22 blank)
function parseCSV(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);

  // Find the header row (contains both STRIKE and OI/VOLUME)
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const up = lines[i].toUpperCase();
    if (up.includes('STRIKE') && (up.includes(',OI,') || up.includes('VOLUME'))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) headerIdx = 1; // fallback: skip title row

  // Locate STRIKE column from header
  const headers = parseCSVRow(lines[headerIdx]).map(h => h.toUpperCase().trim());
  let strikeCol = headers.indexOf('STRIKE');
  if (strikeCol === -1) strikeCol = headers.findIndex(h => h.includes('STRIKE'));

  const rows = [];
  let totalCallOI = 0, totalPutOI = 0;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]);
    if (cols.length < 12) continue;

    // Resolve strike value
    let strike = NaN;
    if (strikeCol !== -1 && strikeCol < cols.length) {
      strike = numVal(cols[strikeCol]);
    }
    // If still not valid, scan for a round number in the index range
    if (!strike || strike < 30000 || strike > 120000) {
      strike = NaN;
      for (let c = 0; c < cols.length; c++) {
        const v = numVal(cols[c]);
        if (v >= 30000 && v <= 120000 && v % 100 === 0) { strike = v; break; }
      }
    }
    if (!strike || isNaN(strike)) continue;

    // Call side (fixed positions from left)
    const callOI  = numVal(cols[1]);
    const callChg = numVal(cols[2]);
    const callLTP = numVal(cols[5]);

    // Put side (fixed positions: col 17=putLTP, col 20=putChgOI, col 21=putOI)
    // Guard against shorter rows by using fallbacks
    const putOI  = numVal(cols[21] ?? cols[cols.length - 2] ?? '');
    const putChg = numVal(cols[20] ?? cols[cols.length - 3] ?? '');
    const putLTP = numVal(cols[17] ?? cols[cols.length - 6] ?? '');

    rows.push({ strike, callOI, callChg, callLTP, putOI, putChg, putLTP });
    totalCallOI += callOI;
    totalPutOI  += putOI;
  }

  if (rows.length === 0) {
    alert('Could not parse the CSV. Please make sure it is the Bank Nifty options chain CSV from NSE.');
    return;
  }

  rows.sort((a, b) => a.strike - b.strike);

  const maxCallRow = rows.reduce((m, r) => r.callOI > m.callOI ? r : m, rows[0]);
  const maxPutRow  = rows.reduce((m, r) => r.putOI  > m.putOI  ? r : m, rows[0]);

  // ATM: strike where |callLTP - putLTP| is minimised (put-call parity)
  const liquid = rows.filter(r => r.callLTP > 0 && r.putLTP > 0);
  const atmRow = liquid.length > 0
    ? liquid.reduce((m, r) =>
        Math.abs(r.callLTP - r.putLTP) < Math.abs(m.callLTP - m.putLTP) ? r : m, liquid[0])
    : rows[Math.floor(rows.length / 2)];

  const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;

  renderDashboard({ rows, totalCallOI, totalPutOI, pcr, maxCallRow, maxPutRow, atmRow });
}

// ── FORMAT NUMBERS ──
function fmt(n) {
  if (n >= 10000000) return (n / 10000000).toFixed(2) + 'Cr';
  if (n >= 100000)   return (n / 100000).toFixed(2) + 'L';
  if (n >= 1000)     return (n / 1000).toFixed(1) + 'K';
  return n.toFixed(0);
}

// ── RENDER DASHBOARD ──
function renderDashboard(data) {
  const { rows, totalCallOI, totalPutOI, pcr, maxCallRow, maxPutRow, atmRow } = data;

  // Bias signal from PCR
  let bias, biasClass;
  if (pcr > 1.5)      { bias = 'STRONGLY BULLISH'; biasClass = 'bull'; }
  else if (pcr > 1.2) { bias = 'BULLISH';          biasClass = 'bull'; }
  else if (pcr > 0.9) { bias = 'NEUTRAL';           biasClass = 'neut'; }
  else if (pcr > 0.7) { bias = 'BEARISH';           biasClass = 'bear'; }
  else                 { bias = 'STRONGLY BEARISH';  biasClass = 'bear'; }

  const banner = document.getElementById('signalBanner');
  banner.className = `signal-banner ${biasClass}`;
  document.getElementById('sigWord').textContent = bias;
  document.getElementById('pcrBig').textContent  = pcr.toFixed(2);

  // Metrics grid
  const pcrColor = biasClass === 'bull' ? 'bull' : biasClass === 'bear' ? 'bear' : 'warn';
  document.getElementById('metricsGrid').innerHTML = [
    { label: 'PCR',             val: pcr.toFixed(2),                   cls: pcrColor },
    { label: 'Total Call OI',   val: fmt(totalCallOI),                  cls: 'bear'   },
    { label: 'Total Put OI',    val: fmt(totalPutOI),                   cls: 'bull'   },
    { label: 'Max Call Strike', val: maxCallRow.strike.toLocaleString(), cls: 'bear'   },
    { label: 'Max Put Strike',  val: maxPutRow.strike.toLocaleString(),  cls: 'bull'   },
    { label: 'ATM Strike',      val: atmRow.strike.toLocaleString(),     cls: 'blue'   },
    { label: 'Call OI at Max',  val: fmt(maxCallRow.callOI),             cls: 'bear'   },
    { label: 'Put OI at Max',   val: fmt(maxPutRow.putOI),               cls: 'bull'   },
  ].map(m => `
    <div class="metric">
      <div class="metric-label">${m.label}</div>
      <div class="metric-val ${m.cls}">${m.val}</div>
    </div>`).join('');

  // OI bar chart — 10 strikes centred on ATM
  const atmIdx  = rows.indexOf(atmRow);
  const start   = Math.max(0, atmIdx - 5);
  const end     = Math.min(rows.length, atmIdx + 6);
  const visible = rows.slice(start, end);
  const maxOI   = Math.max(...visible.map(r => Math.max(r.callOI, r.putOI))) || 1;

  document.getElementById('oiChart').innerHTML = `
    <div class="oi-row header">
      <div style="text-align:right">CALL OI</div>
      <div></div>
      <div style="text-align:center">STRIKE</div>
      <div></div>
      <div></div>
      <div>PUT OI</div>
    </div>` +
  visible.map(r => {
    const callW     = (r.callOI / maxOI * 100).toFixed(1);
    const putW      = (r.putOI  / maxOI * 100).toFixed(1);
    const isATM     = r.strike === atmRow.strike;
    const isMaxC    = r.strike === maxCallRow.strike;
    const isMaxP    = r.strike === maxPutRow.strike;
    const rowCls    = isATM ? 'atm' : isMaxC ? 'max-call' : isMaxP ? 'max-put' : '';
    const stkCls    = isATM ? 'atm-tag' : '';
    const putChgCls = r.putChg > 0 ? 'pos' : r.putChg < 0 ? 'neg' : '';
    return `
    <div class="oi-row ${rowCls}">
      <div class="call-num">${fmt(r.callOI)}</div>
      <div class="bar-wrap-call"><div class="bar call" style="width:${callW}%"></div></div>
      <div class="strike-label ${stkCls}">${r.strike.toLocaleString()}${isATM ? ' ATM' : ''}${isMaxC ? ' ◀' : ''}${isMaxP ? ' ▶' : ''}</div>
      <div class="bar-wrap-put"><div class="bar put" style="width:${putW}%"></div></div>
      <div class="chg ${putChgCls}">${r.putChg > 0 ? '+' : ''}${fmt(r.putChg)}</div>
      <div class="put-num">${fmt(r.putOI)}</div>
    </div>`;
  }).join('');

  // Key levels
  document.getElementById('levelList').innerHTML = [
    { name: 'Strong Resistance (Max Call OI)', val: maxCallRow.strike.toLocaleString(),         cls: 'bear' },
    { name: 'Resistance Zone',                 val: (maxCallRow.strike + 200).toLocaleString(), cls: 'bear' },
    { name: 'ATM (Current Price Area)',         val: atmRow.strike.toLocaleString(),             cls: 'blue' },
    { name: 'Support Zone',                     val: (maxPutRow.strike - 200).toLocaleString(), cls: 'bull' },
    { name: 'Strong Support (Max Put OI)',      val: maxPutRow.strike.toLocaleString(),          cls: 'bull' },
  ].map(l => `
    <div class="level-item">
      <div class="level-name">${l.name}</div>
      <div class="level-val ${l.cls}">${l.val}</div>
    </div>`).join('');

  // Show dashboard
  document.getElementById('uploadSection').style.display = 'none';
  document.getElementById('dashboard').classList.add('show');

  generateAISignal(data);
}

// ── AI SIGNAL via Claude API ──
async function generateAISignal(data) {
  const { rows, totalCallOI, totalPutOI, pcr, maxCallRow, maxPutRow, atmRow } = data;

  const liveKey  = document.getElementById('apiKeyInput').value.trim();
  const keyToUse = liveKey || apiKey;

  if (!keyToUse || !keyToUse.startsWith('sk-ant-')) {
    document.getElementById('aiLoading').innerHTML =
      `<span style="color:var(--warn);font-family:'JetBrains Mono',monospace;font-size:0.8rem">
        ⚠ Enter your Anthropic API key above to get the full AI trade plan — OI data above is still valid.
      </span>`;
    return;
  }

  // Build top-10 strikes by OI for richer context
  const top10 = [...rows]
    .sort((a, b) => (b.callOI + b.putOI) - (a.callOI + a.putOI))
    .slice(0, 10)
    .map(r => `  Strike ${r.strike}: CallOI=${r.callOI.toLocaleString()}, PutOI=${r.putOI.toLocaleString()}, CallChg=${r.callChg > 0 ? '+' : ''}${r.callChg}, PutChg=${r.putChg > 0 ? '+' : ''}${r.putChg}`)
    .join('\n');

  const prompt = `You are an expert Bank Nifty intraday options trader with 15 years of experience. Analyze this live options chain data and give a precise, actionable trade plan.

=== OPTIONS CHAIN SNAPSHOT ===
PCR (Put-Call Ratio): ${pcr.toFixed(2)}
ATM Strike (spot price area): ${atmRow.strike}
Max Call OI Strike (KEY RESISTANCE): ${maxCallRow.strike}  [OI: ${maxCallRow.callOI.toLocaleString()}, Chg: ${maxCallRow.callChg > 0 ? '+' : ''}${maxCallRow.callChg}]
Max Put OI Strike (KEY SUPPORT): ${maxPutRow.strike}  [OI: ${maxPutRow.putOI.toLocaleString()}, Chg: ${maxPutRow.putChg > 0 ? '+' : ''}${maxPutRow.putChg}]
Total Call OI: ${totalCallOI.toLocaleString()}
Total Put OI: ${totalPutOI.toLocaleString()}

Top 10 strikes by total OI:
${top10}

=== YOUR TASK ===
Based on this OI data give me ONE primary trade recommendation (the highest conviction setup right now), PLUS full bull and bear conditional plans.

Rules for your response:
- primary_direction must be exactly one of: "BUY CALL", "BUY PUT", or "WAIT"
- All strike prices must be realistic Bank Nifty option strikes (multiples of 100)
- Entry, SL, target must all be INDEX LEVELS (not option premium prices)
- entry_zone: exact index level range to enter (e.g. "55050–55100")
- stop_loss: index level where the trade is invalidated (hard SL)
- target_1: first exit level (partial profit)
- target_2: final exit level (full exit)
- risk_reward: ratio string like "1:2.5"
- entry_trigger: the specific price action or condition that must happen BEFORE entering (e.g. "break and close above 55200 on 5-min candle")
- exit_rule: exact condition to exit early (e.g. "exit if 15-min candle closes below 55000")
- reasoning: 4-5 sentences explaining EXACTLY WHY — reference specific OI levels, PCR interpretation, which strikes are walls, what the max pain is, and what smart money positioning suggests
- bull_scenario: what happens if bulls take control — entry, SL, target with specific numbers
- bear_scenario: what happens if bears take control — entry, SL, target with specific numbers
- oi_analysis: 3-4 sentences on what the OI distribution tells us about WHERE market makers want price to go, mention max pain, OI walls, and any notable OI changes
- risk_warning: the single biggest trap or risk specific to THIS setup today

Respond ONLY with valid JSON, no markdown, no extra text:
{
  "primary_direction": "BUY CALL" | "BUY PUT" | "WAIT",
  "suggested_strike": 55000,
  "entry_zone": "55050–55100",
  "stop_loss": 54800,
  "target_1": 55400,
  "target_2": 55700,
  "risk_reward": "1:2.5",
  "entry_trigger": "...",
  "exit_rule": "...",
  "reasoning": "...",
  "bull_scenario": "...",
  "bear_scenario": "...",
  "oi_analysis": "...",
  "risk_warning": "..."
}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keyToUse,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const d = await resp.json();
    if (d.error) throw new Error(d.error.message || 'API error');

    const raw = d.content.map(i => i.text || '').join('').replace(/```json|```/g, '').trim();
    const r   = JSON.parse(raw);

    renderTradeplan(r);

    document.getElementById('aiLoading').style.display = 'none';
    document.getElementById('aiContent').classList.add('show');

  } catch (e) {
    console.error('AI signal error:', e);
    document.getElementById('aiLoading').innerHTML =
      `<span style="color:var(--warn);font-family:'JetBrains Mono',monospace;font-size:0.8rem">
        AI signal unavailable (${e.message || 'check API key'}) — OI data above is still valid
      </span>`;
  }
}

function renderTradeplan(r) {
  const dir = (r.primary_direction || 'WAIT').toUpperCase();
  const isBull = dir === 'BUY CALL';
  const isBear = dir === 'BUY PUT';
  const cardClass = isBull ? 'call-trade' : isBear ? 'put-trade' : 'wait-trade';
  const entColor  = isBull ? 'bull' : isBear ? 'bear' : 'warn';

  // ── Primary trade card ──
  document.getElementById('primaryTrade').innerHTML = `
    <div class="primary-trade ${cardClass}">
      <div class="pt-left">
        <div class="pt-action">// PRIMARY SIGNAL</div>
        <div class="pt-type">${dir}</div>
        <div class="pt-sub">
          ${isBull ? `Buy <strong>${r.suggested_strike} CE</strong>` : isBear ? `Buy <strong>${r.suggested_strike} PE</strong>` : 'No clear edge — stand aside'}
          &nbsp;·&nbsp; R:R <strong>${r.risk_reward || '—'}</strong>
        </div>
      </div>
      <div class="pt-right">
        <div class="pt-stat">
          <div class="pt-stat-label">ENTRY ZONE</div>
          <div class="pt-stat-val ${entColor}">${r.entry_zone || '—'}</div>
        </div>
        <div class="pt-stat">
          <div class="pt-stat-label">STOP LOSS</div>
          <div class="pt-stat-val bear">${r.stop_loss ? r.stop_loss.toLocaleString() : '—'}</div>
        </div>
        <div class="pt-stat">
          <div class="pt-stat-label">TARGET 1</div>
          <div class="pt-stat-val bull">${r.target_1 ? r.target_1.toLocaleString() : '—'}</div>
        </div>
        <div class="pt-stat">
          <div class="pt-stat-label">TARGET 2</div>
          <div class="pt-stat-val bull">${r.target_2 ? r.target_2.toLocaleString() : '—'}</div>
        </div>
      </div>
    </div>`;

  // ── Entry / Exit rules table ──
  document.getElementById('tradeTableWrap').innerHTML = `
    <table class="trade-table">
      <thead>
        <tr>
          <th>PARAMETER</th>
          <th>VALUE</th>
          <th>WHY / RULE</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="label-col">ENTRY TRIGGER</td>
          <td class="val-col ${entColor}">${r.entry_zone || '—'}</td>
          <td class="reason-col">${r.entry_trigger || '—'}</td>
        </tr>
        <tr>
          <td class="label-col">STOP LOSS</td>
          <td class="val-col bear">${r.stop_loss ? r.stop_loss.toLocaleString() : '—'}</td>
          <td class="reason-col">Hard invalidation level — exit immediately if price closes a candle beyond this</td>
        </tr>
        <tr>
          <td class="label-col">TARGET 1 (50% exit)</td>
          <td class="val-col bull">${r.target_1 ? r.target_1.toLocaleString() : '—'}</td>
          <td class="reason-col">Book half position here — move SL to cost for remaining lot</td>
        </tr>
        <tr>
          <td class="label-col">TARGET 2 (full exit)</td>
          <td class="val-col bull">${r.target_2 ? r.target_2.toLocaleString() : '—'}</td>
          <td class="reason-col">Full exit — do not hold options past 3:15 PM</td>
        </tr>
        <tr>
          <td class="label-col">EARLY EXIT RULE</td>
          <td class="val-col warn">TIME / PRICE</td>
          <td class="reason-col">${r.exit_rule || '—'}</td>
        </tr>
      </tbody>
    </table>`;

  // ── Bull / Bear scenarios ──
  document.getElementById('tradeScenarios').innerHTML = `
    <div class="scenario bull-s">
      <div class="scenario-tag">// IF BULLS WIN — CALL TRADE</div>
      <div class="scenario-text">${r.bull_scenario}</div>
    </div>
    <div class="scenario bear-s">
      <div class="scenario-tag">// IF BEARS WIN — PUT TRADE</div>
      <div class="scenario-text">${r.bear_scenario}</div>
    </div>`;

  // ── OI analysis ──
  document.getElementById('aiAnalysis').textContent = r.oi_analysis;

  // ── Why this trade ──
  document.getElementById('whyBox').innerHTML = `
    <div class="why-box-title">// WHY THIS TRADE — OI REASONING</div>
    ${escHtml(r.reasoning)}`;

  // ── Risk warning ──
  document.getElementById('riskBox').innerHTML = `⚠ TRAP TO AVOID: ${escHtml(r.risk_warning)}`;
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── RESET ──
function reset() {
  document.getElementById('uploadSection').style.display = 'block';
  document.getElementById('dashboard').classList.remove('show');
  document.getElementById('fileInput').value = '';
  document.getElementById('aiLoading').style.display = 'flex';
  document.getElementById('aiLoading').innerHTML = '<div class="spin"></div> GENERATING SIGNAL...';
  document.getElementById('aiContent').classList.remove('show');
}
