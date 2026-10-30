import base64
import hashlib
import hmac
import json
import math
import os
import re
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote_plus

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
        analysis_id = str(body.get("analysis_id") or "")
        updated = False
        if analysis_id:
            try:
                updated = analyses_collection.update_one(
                    {"_id": ObjectId(analysis_id), "username": username},
                    {"$set": {
                        "analysis": result,
                        "model": OPENAI_MODEL,
                        "analyzed_at": datetime.now(timezone.utc),
                    }},
                ).matched_count > 0
            except Exception:
                updated = False
        if updated:
            saved_id = analysis_id
        else:
            doc = snapshot_doc(username, snapshot)
            doc.update({"analysis": result, "model": OPENAI_MODEL})
            saved_id = str(analyses_collection.insert_one(doc).inserted_id)

    return jsonify({
        "id": saved_id,
        "analysis": result,
        "model": OPENAI_MODEL,
        "saved": saved_id is not None,
    })


def snapshot_doc(username, snapshot):
    return {
        "username": username,
        "created_at": datetime.now(timezone.utc),
        "instrument": snapshot.get("instrument"),
        "metrics": snapshot.get("metrics"),
        "levels": snapshot.get("levels"),
        "top_strikes": snapshot.get("topStrikes"),
        "chart_rows": snapshot.get("chartRows"),
        "mode": snapshot.get("mode") or "chain",
        "expiry_rows": (snapshot.get("expiryRows") or [])[:20],
        "expiry": str(snapshot.get("expiry") or "")[:40] or None,
        "file_name": str(snapshot.get("fileName") or "")[:160] or None,
    }


@app.post("/api/analyses")
def save_snapshot():
    username = require_user()
    if not username:
        return jsonify({"error": "Unauthorized."}), 401

    snapshot = (request.get_json(silent=True) or {}).get("snapshot") or {}
    if not snapshot.get("instrument") or not snapshot.get("metrics") or not snapshot.get("levels"):
        return jsonify({"error": "Invalid snapshot."}), 400
    if analyses_collection is None:
        return jsonify({"id": None, "saved": False})

    doc = snapshot_doc(username, snapshot)
    doc["analysis"] = None
    return jsonify({"id": str(analyses_collection.insert_one(doc).inserted_id), "saved": True})


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


# ---------------------------------------------------------------- News sentiment

NEWS_CACHE_TTL = 180
NEWS_MAX_AGE_HOURS = 72
NEWS_PER_FEED = 8
news_cache = {}

# (category, google news query, inverse) - inverse=True means a price rise is bad for Indian equities
NEWS_FEEDS = {
    "NIFTY": ("Nifty 50", "Nifty 50 Sensex stock market today"),
    "BANKNIFTY": ("Bank Nifty", "Bank Nifty banking stocks HDFC Bank ICICI Bank SBI"),
}
NEWS_COMMON_FEEDS = [
    ("Global Markets", "US stock market Wall Street Fed", False),
    ("FII / DII", "FII DII flows India stocks", False),
    ("RBI & Economy", "RBI India economy inflation GDP", False),
    ("Crude Oil", "crude oil price Brent", True),
    ("Geopolitics", "geopolitical tension tariff war markets", False),
]

PHRASE_SCORES = {
    "rate cut": 2, "rate hike": -2, "all-time high": 2, "all time high": 2, "record high": 2,
    "52-week high": 1.5, "sell-off": -2, "selloff": -2, "fii buying": 2, "fii selling": -2,
    "net buyers": 1.5, "net sellers": -1.5, "short covering": 1, "profit booking": -1,
    "gap up": 1.5, "gap down": -1.5, "ceasefire": 1.5, "trade deal": 1.5, "lower circuit": -2,
    "upper circuit": 1.5, "bear market": -2, "bull run": 2, "in the red": -1.5, "in the green": 1.5,
    "wipes out": -2, "under pressure": -1.5, "job cuts": -1.5,
}
POSITIVE_WORDS = {
    "rally": 1.5, "rallies": 1.5, "surge": 1.5, "soar": 1.5, "jump": 1, "gain": 1, "climb": 1,
    "rebound": 1.5, "recover": 1, "recovery": 1, "strong": 1, "boost": 1, "upbeat": 1.5,
    "optimism": 1.5, "optimistic": 1.5, "bullish": 2, "buying": 1, "inflow": 1, "inflows": 1,
    "upgrade": 1.5, "beat": 1, "beats": 1, "record": 1, "growth": 0.5, "positive": 1,
    "easing": 1, "relief": 1, "hope": 0.5, "hopes": 0.5, "resilient": 1, "advance": 1,
    "higher": 0.5, "stimulus": 1, "cheer": 1, "bounce": 1, "outperform": 1,
    "rise": 0.75, "rose": 0.75, "rising": 0.75,
}
NEGATIVE_WORDS = {
    "fall": -1, "fell": -1, "drop": -1, "plunge": -2, "slump": -2, "tumble": -2, "crash": -2.5,
    "slide": -1, "sink": -1.5, "decline": -1, "weak": -1, "weaken": -1, "loss": -1, "losses": -1,
    "fear": -1.5, "worry": -1, "worries": -1, "concern": -1, "concerns": -1, "risk": -0.5,
    "risks": -0.5, "tension": -1.5, "tensions": -1.5, "war": -1.5, "attack": -1.5, "tariff": -1,
    "sanction": -1, "sanctions": -1, "outflow": -1, "outflows": -1, "downgrade": -1.5,
    "slowdown": -1.5, "recession": -2, "default": -1.5, "fraud": -2, "probe": -1, "penalty": -1,
    "volatile": -0.5, "volatility": -0.5, "correction": -1, "pressure": -1, "bleed": -1.5,
    "bloodbath": -2.5, "panic": -2, "dip": -0.5, "slip": -0.5, "retreat": -1, "lower": -0.5,
    "bearish": -2, "selling": -1, "miss": -1, "misses": -1, "uncertainty": -1, "shock": -1.5,
}
# Price-movement words: for crude oil these are flipped (a price rise hurts Indian equities)
PRICE_MOVE_WORDS = {
    "rally", "rallie", "surge", "soar", "jump", "gain", "climb", "rise", "rose", "rising", "higher",
    "advance", "bounce", "rebound", "fall", "fell", "drop", "plunge", "slump", "tumble", "crash",
    "slide", "sink", "decline", "lower", "dip", "slip", "retreat", "bleed",
}
NEGATIONS = {"not", "no", "fails", "fail", "without", "never", "unlikely", "avoid", "avoids"}


def _token_variants(token):
    yield token
    if token.endswith("s"):
        yield token[:-1]
    if token.endswith("es"):
        yield token[:-2]
    if token.endswith("ed"):
        yield token[:-2]
        yield token[:-1]
    if token.endswith("ing"):
        yield token[:-3]
        yield token[:-3] + "e"


def _lexicon_score(token, table):
    for candidate in _token_variants(token):
        if candidate in table:
            return table[candidate]
    return 0


def score_headline(title, inverse=False):
    text = title.lower()
    raw = 0.0
    for phrase, weight in PHRASE_SCORES.items():
        if phrase in text:
            raw += weight
            text = text.replace(phrase, " ")

    tokens = re.findall(r"[a-z]+", text)
    for idx, token in enumerate(tokens):
        weight = _lexicon_score(token, POSITIVE_WORDS) or _lexicon_score(token, NEGATIVE_WORDS)
        if not weight:
            continue
        if any(prev in NEGATIONS for prev in tokens[max(0, idx - 2):idx]):
            weight = -weight
        if inverse and any(v in PRICE_MOVE_WORDS for v in _token_variants(token)):
            weight = -weight
        raw += weight

    return math.tanh(raw / 2.0)


def label_for(score):
    if score > 0.15:
        return "bullish"
    if score < -0.15:
        return "bearish"
    return "neutral"


def index_for(avg):
    return int(round(50 + 50 * math.tanh(avg * 2)))


def bias_for(index):
    if index >= 62:
        return "Bullish", "bull"
    if index >= 54:
        return "Slightly Bullish", "bull"
    if index > 46:
        return "Neutral", "neut"
    if index > 38:
        return "Slightly Bearish", "bear"
    return "Bearish", "bear"


def fetch_news_feed(feed):
    category, query, inverse = feed
    url = (
        "https://news.google.com/rss/search?q="
        + quote_plus(f"{query} when:2d")
        + "&hl=en-IN&gl=IN&ceid=IN:en"
    )
    resp = requests.get(url, timeout=8, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    root = ET.fromstring(resp.content)

    items = []
    for node in list(root.iter("item"))[:NEWS_PER_FEED]:
        title = (node.findtext("title") or "").strip()
        link = (node.findtext("link") or "").strip()
        source = (node.findtext("source") or "").strip()
        if source and title.endswith(f" - {source}"):
            title = title[: -len(source) - 3].strip()
        if not title or not link.startswith("http"):
            continue
        try:
            published = parsedate_to_datetime(node.findtext("pubDate") or "")
            if published.tzinfo is None:
                published = published.replace(tzinfo=timezone.utc)
            published = published.astimezone(timezone.utc)
        except Exception:
            continue
        items.append({
            "title": title,
            "link": link,
            "source": source or "News",
            "published": published,
            "category": category,
            "inverse": inverse,
        })
    return items


def build_news_payload(instrument):
    first = NEWS_FEEDS[instrument]
    feeds = [(first[0], first[1], False)] + NEWS_COMMON_FEEDS

    def safe_fetch(feed):
        try:
            return fetch_news_feed(feed)
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=len(feeds)) as pool:
        results = list(pool.map(safe_fetch, feeds))
    if all(result is None for result in results):
        raise RuntimeError("Could not reach the news source. Try again in a moment.")

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=NEWS_MAX_AGE_HOURS)
    seen = set()
    items = []
    for result in results:
        for item in result or []:
            key = re.sub(r"[^a-z0-9]", "", item["title"].lower())[:80]
            if key in seen or item["published"] < cutoff:
                continue
            seen.add(key)
            score = score_headline(item["title"], item["inverse"])
            item["sentiment"] = round(score, 2)
            item["label"] = label_for(score)
            item["weight"] = 0.5 ** (max(0.0, (now - item["published"]).total_seconds() / 3600) / 18)
            items.append(item)
    items.sort(key=lambda it: it["published"], reverse=True)

    def weighted_avg(rows):
        total = sum(row["weight"] for row in rows)
        return sum(row["sentiment"] * row["weight"] for row in rows) / total if total else 0.0

    categories = []
    for name in dict.fromkeys(it["category"] for it in items):
        rows = [it for it in items if it["category"] == name]
        idx = index_for(weighted_avg(rows))
        categories.append({"name": name, "score": idx, "label": bias_for(idx)[0], "count": len(rows)})

    # Headline score is based on the chosen instrument's own news only
    scope_items = [it for it in items if it["category"] == first[0]]
    scope = first[0] if scope_items else "All topics"
    scope_items = scope_items or items
    score = index_for(weighted_avg(scope_items))
    bias, bias_class = bias_for(score)
    return {
        "instrument": instrument,
        "fetched_at": now.isoformat(),
        "scope": scope,
        "score": score,
        "overall_score": index_for(weighted_avg(items)),
        "bias": bias,
        "bias_class": bias_class,
        "counts": {
            "bullish": sum(1 for it in scope_items if it["label"] == "bullish"),
            "bearish": sum(1 for it in scope_items if it["label"] == "bearish"),
            "neutral": sum(1 for it in scope_items if it["label"] == "neutral"),
        },
        "categories": categories,
        "items": [
            {
                "title": it["title"],
                "link": it["link"],
                "source": it["source"],
                "published_at": it["published"].isoformat(),
                "category": it["category"],
                "sentiment": it["sentiment"],
                "label": it["label"],
                "inverse": it["inverse"],
            }
            for it in items[:40]
        ],
    }


@app.get("/api/news")
def news():
    username = require_user()
    if not username:
        return jsonify({"error": "Unauthorized."}), 401

    instrument = request.args.get("instrument", "NIFTY").upper()
    if instrument not in NEWS_FEEDS:
        return jsonify({"error": "Unknown instrument."}), 400

    cached = news_cache.get(instrument)
    if cached and not request.args.get("refresh") and time.time() - cached[0] < NEWS_CACHE_TTL:
        return jsonify(cached[1])

    try:
        payload = build_news_payload(instrument)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502
    news_cache[instrument] = (time.time(), payload)
    return jsonify(payload)


def build_strike_prompt(snapshot):
    instrument = snapshot.get("instrument")
    metrics = snapshot.get("metrics") or {}
    levels = snapshot.get("levels") or {}
    expiry_rows = (snapshot.get("expiryRows") or [])[:12]
    if not instrument or not metrics or not levels.get("strike") or not expiry_rows:
        return ""

    inst_name = "Nifty 50" if instrument == "NIFTY" else "Bank Nifty"
    strike_step = 50 if instrument == "NIFTY" else 100
    lot_size = 75 if instrument == "NIFTY" else 15
    rows_text = "\n".join(
        f"Expiry {r.get('expiry')}: CallOI={r.get('callOI')} (chg {r.get('callChg')}, vol {r.get('callVol')}, "
        f"IV {r.get('callIV')}, LTP {r.get('callLTP')}), PutOI={r.get('putOI')} (chg {r.get('putChg')}, "
        f"vol {r.get('putVol')}, IV {r.get('putIV')}, LTP {r.get('putLTP')})"
        for r in expiry_rows
    )
    implied_spot = levels.get("impliedSpot")
    spot_line = (
        f"Implied spot (put-call parity at nearest expiry, approximate): {implied_spot}"
        if implied_spot
        else "Spot price is not available."
    )

    return f"""
You are an expert {inst_name} options trader. Analyze this NSE option data for ONE strike across several expiries and produce one actionable trade plan.

Instrument: {inst_name}
Lot size: {lot_size}
Strike step: {strike_step}
Analysed strike: {levels.get("strike")}
{spot_line}
Overall PCR for this strike (all expiries): {metrics.get("pcr")}
Total Call OI: {metrics.get("totalCallOI")}
Total Put OI: {metrics.get("totalPutOI")}
Nearest expiry: {levels.get("nearestExpiry")}
Straddle premium at nearest expiry: {levels.get("straddle")} (breakevens {levels.get("lowerBE")} to {levels.get("upperBE")})

Expiry-wise data for strike {levels.get("strike")}:
{rows_text}

How to read this: more call OI than put OI at this strike means writers see it as resistance, more put OI means support.
Rising OI (positive change) shows fresh positions; the IV term structure and straddle show the expected move.
Only this one strike is given, so treat conclusions as lower confidence and prefer WAIT when the signal is mixed.

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


def build_prompt(snapshot):
    if snapshot.get("mode") == "strike":
        return build_strike_prompt(snapshot)
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
    if created_at and created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    item = {
        "id": str(doc["_id"]),
        "created_at": created_at.isoformat() if created_at else None,
        "instrument": doc.get("instrument"),
        "primary_direction": analysis.get("primary_direction"),
        "suggested_strike": analysis.get("suggested_strike"),
        "metrics": doc.get("metrics"),
        "analysis": analysis,
        "mode": doc.get("mode") or "chain",
        "has_analysis": bool(analysis),
        "expiry": doc.get("expiry"),
        "file_name": doc.get("file_name"),
        "strike": (doc.get("levels") or {}).get("strike") if doc.get("mode") == "strike" else None,
    }
    if not compact:
        item.update({
            "levels": doc.get("levels"),
            "top_strikes": doc.get("top_strikes"),
            "chart_rows": doc.get("chart_rows"),
            "expiry_rows": doc.get("expiry_rows"),
            "model": doc.get("model"),
        })
    return item


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "10000")))
