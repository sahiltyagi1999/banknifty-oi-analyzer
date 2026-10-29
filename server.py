"""
Simple local dev server for OI Analyzer.
Runs on http://localhost:8080
"""
import http.server
import json
import socketserver
import webbrowser
import os
from datetime import datetime, timezone

PORT = int(os.environ.get("PORT", 8080))

os.chdir(os.path.dirname(os.path.abspath(__file__)))

class OIAnalyzerHandler(http.server.SimpleHTTPRequestHandler):
    HEALTH_PATHS = {"/health", "/healthz", "/api/health"}

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
