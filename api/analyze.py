import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler


OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-6-luna")
MAX_PROMPT_BYTES = 50000


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
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

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

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
