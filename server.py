"""
Simple local dev server for OI Analyzer.
Runs on http://localhost:8080
"""
import http.server
import json
import socketserver
import webbrowser
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone

def load_env_file(path=".env"):
    if not os.path.exists(path):
        return

    with open(path, "r", encoding="utf-8") as env_file:
        for line in env_file:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


os.chdir(os.path.dirname(os.path.abspath(__file__)))
load_env_file()

PORT = int(os.environ.get("PORT", 8080))
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-6-luna")
MAX_PROMPT_BYTES = 50000

class OIAnalyzerHandler(http.server.SimpleHTTPRequestHandler):
    HEALTH_PATHS = {"/health", "/healthz", "/api/health"}
    ANALYZE_PATH = "/api/analyze"

    def do_GET(self):
        if self.path.split("?", 1)[0] in self.HEALTH_PATHS:
            body = json.dumps({
                "status": "ok",
                "service": "banknifty-oi-analyzer",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }).encode("utf-8")

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        super().do_GET()

    def do_POST(self):
        if self.path.split("?", 1)[0] != self.ANALYZE_PATH:
            self.send_error(404, "Not found")
            return

        api_key = os.environ.get("OPENAI_API_KEY", "").strip()
        if not api_key:
            self.send_json({
                "error": "OPENAI_API_KEY is not configured on the server."
            }, status=500)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0

        if length <= 0 or length > MAX_PROMPT_BYTES:
            self.send_json({"error": "Invalid prompt size."}, status=400)
            return

        try:
            request_body = json.loads(self.rfile.read(length).decode("utf-8"))
            prompt = request_body.get("prompt", "").strip()
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json({"error": "Request body must be valid JSON."}, status=400)
            return

        if not prompt:
            self.send_json({"error": "Prompt is required."}, status=400)
            return

        payload = json.dumps({
            "model": OPENAI_MODEL,
            "instructions": (
                "You are an expert intraday options analyst. Return exactly one "
                "valid JSON object and nothing else. Do not use markdown, comments, "
                "code fences, trailing commas, NaN, Infinity, undefined, or unquoted keys."
            ),
            "input": prompt,
            "max_output_tokens": 1200,
        }).encode("utf-8")

        request = urllib.request.Request(
            "https://api.openai.com/v1/responses",
            data=payload,
            method="POST",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                openai_data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            message = e.read().decode("utf-8", errors="replace")
            self.send_json({"error": f"OpenAI API error: {message}"}, status=e.code)
            return
        except (urllib.error.URLError, TimeoutError) as e:
            self.send_json({"error": f"OpenAI request failed: {e}"}, status=502)
            return

        output_text = extract_openai_text(openai_data)
        if not output_text:
            self.send_json({"error": "OpenAI returned an empty response."}, status=502)
            return

        self.send_json({"text": output_text, "model": OPENAI_MODEL})

    def send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def extract_openai_text(data):
    if data.get("output_text"):
        return data["output_text"]

    chunks = []
    for item in data.get("output", []):
        for content in item.get("content", []):
            text = content.get("text")
            if text:
                chunks.append(text)
    return "".join(chunks).strip()


Handler = OIAnalyzerHandler
Handler.extensions_map.update({
    '.js':  'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
})

print(f"✓ OI Analyzer running at http://localhost:{PORT}")
print("  Press Ctrl+C to stop\n")

if "PORT" not in os.environ:
    webbrowser.open(f"http://localhost:{PORT}")

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    httpd.serve_forever()
