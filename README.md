# Bank Nifty OI Analyzer

A dark-themed, browser-based tool to analyze NSE Bank Nifty options chain CSV files and generate AI-powered trade signals using OpenAI.

## Project Structure

```
oi-analyzer/
├── index.html      ← Main page (UI structure)
├── style.css       ← All styling (dark trading terminal theme)
├── app.js          ← Frontend logic: CSV parsing, calculations, rendering
├── server.py       ← HTTP server, health check, and OpenAI API proxy
└── .vscode/
    ├── launch.json ← F5 run config for VS Code
    └── settings.json ← Live Server config
```

## How to Run in VS Code

### Option 1 — Live Server Extension (Recommended)

1. Install the **Live Server** extension by Ritwick Dey
   - Open VS Code → Extensions (`Cmd+Shift+X`) → search `Live Server` → Install
2. Open the `oi-analyzer` folder in VS Code (`File → Open Folder`)
3. Right-click `index.html` in the Explorer → **"Open with Live Server"**
4. Browser opens automatically at `http://localhost:8080`

### Option 2 — Python Server (no extensions needed)

1. Open the `oi-analyzer` folder in VS Code
2. Open the integrated terminal (`Ctrl+\``)
3. Run:
   ```bash
   OPENAI_API_KEY=your_openai_key python3 server.py
   ```
4. Browser opens automatically at `http://localhost:8080`

You can also create a local `.env` file:

```bash
cp .env.example .env
```

Then edit `.env`:

```bash
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-6-luna
```

Optional: set `OPENAI_MODEL` to override the default fast model:

```bash
OPENAI_MODEL=gpt-6-luna OPENAI_API_KEY=your_openai_key python3 server.py
```

### Option 3 — F5 Debug Launch

1. Open the `oi-analyzer` folder in VS Code
2. Press **F5** (or Run → Start Debugging)
3. Select **"Run OI Analyzer Server"** if prompted
4. Browser opens at `http://localhost:8080`

> **Why a server?** You need a local HTTP server (not just opening the file directly) because the browser blocks certain features like drag-and-drop file reading when using `file://` URLs.

## How to Use

1. **Configure OpenAI** (required for AI signals):
   - Set `OPENAI_API_KEY` in the server environment
   - Optional: set `OPENAI_MODEL` to change the model
   - The API key is used only on the server and is never stored in the browser

2. **Download the NSE options chain CSV**:
   - Go to [nseindia.com/option-chain](https://www.nseindia.com/option-chain)
   - Select **BANKNIFTY** from the index dropdown
   - Choose the **nearest weekly expiry** date
   - Click the **Download (CSV)** button (top right of the table)

3. **Upload the CSV**:
   - Drag & drop the file onto the upload zone, or click **CHOOSE FILE**
   - The dashboard renders instantly with:
     - Market bias signal (Bullish / Bearish / Neutral) from PCR
     - 8 key metrics (PCR, total OI, max strike levels, ATM)
     - Visual OI bar chart for 10 strikes around ATM
     - Key support & resistance levels
     - AI trade plan with bull/bear scenarios (requires API key)

## What the Signals Mean

| PCR Range | Bias |
|-----------|------|
| > 1.5 | Strongly Bullish |
| 1.2 – 1.5 | Bullish |
| 0.9 – 1.2 | Neutral |
| 0.7 – 0.9 | Bearish |
| < 0.7 | Strongly Bearish |

- **Max Call OI Strike** = Strong resistance (market makers defending)
- **Max Put OI Strike** = Strong support (market makers defending)
- **ATM Strike** = Estimated current spot price area

## Disclaimer

For educational purposes only. Not SEBI-registered investment advice. Always use stop losses.
