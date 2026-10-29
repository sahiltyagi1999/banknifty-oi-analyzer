const fs = require("fs");

const apiBaseUrl = (process.env.FRONTEND_API_BASE_URL || "http://localhost:10000").replace(/\/$/, "");
const payload = `window.OI_ANALYZER_CONFIG = ${JSON.stringify({ apiBaseUrl })};\n`;

fs.writeFileSync("frontend/config.js", payload, "utf8");
