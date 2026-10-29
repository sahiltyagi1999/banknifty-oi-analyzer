import base64
import hashlib
import hmac
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from bson import ObjectId
from flask import Flask, jsonify, request
from flask_cors import CORS
from pymongo import MongoClient, DESCENDING


def load_env_file(path):
    if not path.exists():
        return

    with path.open("r", encoding="utf-8") as env_file:
        for line in env_file:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


BASE_DIR = os.path.dirname(os.path.abspath(__file__))

backend_dir = Path(BASE_DIR)
repo_dir = backend_dir.parent
load_env_file(repo_dir / ".env")
load_env_file(backend_dir / ".env")

APP_NAME = "banknifty-oi-analyzer"
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-6-luna")
TOKEN_TTL_SECONDS = int(os.environ.get("TOKEN_TTL_SECONDS", str(60 * 60 * 12)))
MAX_ROWS_FOR_AI = int(os.environ.get("MAX_ROWS_FOR_AI", "12"))
LOCAL_FRONTEND_ORIGINS = {
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
}


def get_allowed_origins():
    configured = os.environ.get("FRONTEND_ORIGIN", "*").strip()
    if configured == "*":
        return "*"

    origins = {origin.strip().rstrip("/") for origin in configured.split(",") if origin.strip()}
    origins.update(LOCAL_FRONTEND_ORIGINS)
    return sorted(origins)


app = Flask(__name__)
CORS(
    app,
    resources={
        r"/api/*": {"origins": get_allowed_origins()},
        r"/health": {"origins": "*"},
    },
    supports_credentials=False,
)

mongo_client = None
analyses_collection = None
if os.environ.get("MONGO_URI"):
    mongo_client = MongoClient(os.environ["MONGO_URI"])
    db = mongo_client[os.environ.get("MONGO_DB_NAME", "oi_analyzer")]
    analyses_collection = db["analyses"]
    analyses_collection.create_index([("username", 1), ("created_at", DESCENDING)])


@app.get("/health")
@app.get("/api/health")
def health():
    mongo_ok = analyses_collection is not None
    if analyses_collection is not None:
        try:
            mongo_client.admin.command("ping")
            mongo_ok = True
        except Exception:
            mongo_ok = False

    return jsonify({
        "status": "ok",
        "service": APP_NAME,
        "mongo": "ok" if mongo_ok else "not_configured",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


@app.post("/api/login")
def login():
    body = request.get_json(silent=True) or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))

    expected_username = os.environ.get("LOGIN_USERNAME", "").strip()
    expected_password = os.environ.get("LOGIN_PASSWORD", "")
    if not expected_username or not expected_password:
        return jsonify({"error": "LOGIN_USERNAME and LOGIN_PASSWORD are not configured."}), 500

    valid = hmac.compare_digest(username, expected_username) and hmac.compare_digest(
        password, expected_password
    )
    if not valid:
        return jsonify({"error": "Invalid username or password."}), 401

    return jsonify({
        "token": create_token(username),
        "username": username,
        "expires_in": TOKEN_TTL_SECONDS,
    })


@app.get("/api/me")
def me():
    username = require_user()
    if not username:
        return jsonify({"error": "Unauthorized."}), 401
    return jsonify({"username": username})


@app.post("/api/analyze")
def analyze():
    username = require_user()
    if not username:
        return jsonify({"error": "Please login before generating AI analysis."}), 401

    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not openai_key:
        return jsonify({"error": "OPENAI_API_KEY is not configured on the backend."}), 500

    body = request.get_json(silent=True) or {}
    snapshot = body.get("snapshot") or {}
    prompt = build_prompt(snapshot)
    if not prompt:
        return jsonify({"error": "Invalid analysis payload."}), 400

    try:
        ai_text = call_openai(prompt, openai_key)
        result = parse_json_object(ai_text)
    except requests.HTTPError as exc:
        return jsonify({"error": f"OpenAI API error: {exc.response.text}"}), exc.response.status_code
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502

    saved_id = None
    if analyses_collection is not None:
        doc = {
            "username": username,
            "created_at": datetime.now(timezone.utc),
            "instrument": snapshot.get("instrument"),
            "metrics": snapshot.get("metrics"),
            "levels": snapshot.get("levels"),
            "top_strikes": snapshot.get("topStrikes"),
            "analysis": result,
            "model": OPENAI_MODEL,
        }
        saved_id = str(analyses_collection.insert_one(doc).inserted_id)

    return jsonify({
        "id": saved_id,
        "analysis": result,
        "model": OPENAI_MODEL,
        "saved": saved_id is not None,
    })


@app.get("/api/analyses")
def list_analyses():
    username = require_user()
    if not username:
        return jsonify({"error": "Unauthorized."}), 401
    if analyses_collection is None:
        return jsonify({"items": [], "mongo": "not_configured"})

    try:
        limit = max(1, min(int(request.args.get("limit", "25")), 100))
    except ValueError:
        limit = 25

    docs = analyses_collection.find({"username": username}).sort("created_at", DESCENDING).limit(limit)
    return jsonify({"items": [serialize_analysis(doc, compact=True) for doc in docs]})


@app.get("/api/analyses/<analysis_id>")
def get_analysis(analysis_id):
    username = require_user()
    if not username:
        return jsonify({"error": "Unauthorized."}), 401
    if analyses_collection is None:
        return jsonify({"error": "MongoDB is not configured."}), 500

    try:
        object_id = ObjectId(analysis_id)
    except Exception:
        return jsonify({"error": "Invalid analysis id."}), 400

    doc = analyses_collection.find_one({"_id": object_id, "username": username})
    if not doc:
        return jsonify({"error": "Analysis not found."}), 404

    return jsonify(serialize_analysis(doc))


def build_prompt(snapshot):
    instrument = snapshot.get("instrument")
    metrics = snapshot.get("metrics") or {}
    levels = snapshot.get("levels") or {}
    top_strikes = snapshot.get("topStrikes") or []
    if not instrument or not metrics or not levels:
        return ""

    inst_name = "Nifty 50" if instrument == "NIFTY" else "Bank Nifty"
    strike_step = 50 if instrument == "NIFTY" else 100
    lot_size = 75 if instrument == "NIFTY" else 15
    rows = top_strikes[:MAX_ROWS_FOR_AI]
    rows_text = "\n".join(
        f"Strike {r.get('strike')}: CallOI={r.get('callOI')}, PutOI={r.get('putOI')}, "
        f"CallChg={r.get('callChg')}, PutChg={r.get('putChg')}"
        for r in rows
    )

    return f"""
You are an expert {inst_name} intraday options trader. Analyze this NSE options-chain snapshot and produce one actionable trade plan.

Instrument: {inst_name}
Lot size: {lot_size}
Strike step: {strike_step}
PCR: {metrics.get("pcr")}
Total Call OI: {metrics.get("totalCallOI")}
Total Put OI: {metrics.get("totalPutOI")}
ATM Strike: {levels.get("atm")}
Max Call OI Resistance: {levels.get("maxCallStrike")} (OI: {levels.get("maxCallOI")}, Chg: {levels.get("maxCallChg")})
Max Put OI Support: {levels.get("maxPutStrike")} (OI: {levels.get("maxPutOI")}, Chg: {levels.get("maxPutChg")})

Top strikes:
{rows_text}

Return exactly one valid JSON object with these keys:
primary_direction, suggested_strike, entry_zone, stop_loss, target_1, target_2,
risk_reward, entry_trigger, exit_rule, reasoning, bull_scenario, bear_scenario,
oi_analysis, risk_warning.

Rules:
- primary_direction must be exactly "BUY CALL", "BUY PUT", or "WAIT".
- All levels must be index levels, not option premiums.
- All strike prices must be realistic {inst_name} strikes in multiples of {strike_step}.
- Use concise strings for reasoning and scenarios.
- Return JSON only. No markdown, no code fence, no comments.
""".strip()


def call_openai(prompt, api_key):
    response = requests.post(
        "https://api.openai.com/v1/responses",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": OPENAI_MODEL,
            "instructions": (
                "Return exactly one valid JSON object and nothing else. Do not use "
                "markdown, comments, code fences, trailing commas, NaN, Infinity, "
                "undefined, or unquoted keys."
            ),
            "input": prompt,
            "max_output_tokens": 1200,
        },
        timeout=60,
    )
    response.raise_for_status()
    data = response.json()
    return extract_openai_text(data)


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


def parse_json_object(text):
    cleaned = (text or "").replace("```json", "").replace("```", "").strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end != -1 and end > start:
        cleaned = cleaned[start : end + 1]
    if not cleaned:
        raise ValueError("AI returned an empty analysis.")
    return json.loads(cleaned)


def create_token(username):
    payload = {
        "username": username,
        "exp": int(time.time()) + TOKEN_TTL_SECONDS,
    }
    payload_b64 = b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = sign(payload_b64)
    return f"{payload_b64}.{signature}"


def require_user():
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    token = header.split(" ", 1)[1].strip()
    try:
        payload_b64, signature = token.split(".", 1)
    except ValueError:
        return None
    if not hmac.compare_digest(sign(payload_b64), signature):
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(pad_b64(payload_b64)))
    except Exception:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload.get("username")


def sign(value):
    secret = os.environ.get("SECRET_KEY") or os.environ.get("LOGIN_PASSWORD") or "dev-secret"
    return b64url(hmac.new(secret.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).digest())


def b64url(raw):
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def pad_b64(value):
    return value + "=" * (-len(value) % 4)


def serialize_analysis(doc, compact=False):
    analysis = doc.get("analysis") or {}
    created_at = doc.get("created_at")
    item = {
        "id": str(doc["_id"]),
        "created_at": created_at.isoformat() if created_at else None,
        "instrument": doc.get("instrument"),
        "primary_direction": analysis.get("primary_direction"),
        "suggested_strike": analysis.get("suggested_strike"),
        "metrics": doc.get("metrics"),
        "analysis": analysis,
    }
    if not compact:
        item.update({
            "levels": doc.get("levels"),
            "top_strikes": doc.get("top_strikes"),
            "model": doc.get("model"),
        })
    return item


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "10000")))
