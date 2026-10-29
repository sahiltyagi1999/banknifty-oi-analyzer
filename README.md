# Bank Nifty OI Analyzer

Frontend and backend are split so the UI can be deployed on Netlify and the API can be deployed separately on Render.

## Structure

```text
banknifty-oi-analyzer/
├── backend/
│   ├── app.py              # Flask API: login, health, AI analysis, Mongo history
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── index.html
│   ├── app.js              # CSV parsing, dashboard rendering, history UI
│   ├── style.css
│   └── config.js           # Generated/overridden during Netlify build
├── scripts/
│   └── write_frontend_config.py
├── render.yaml             # Render backend blueprint
└── netlify.toml            # Netlify frontend config
```

## Backend Env

Set these in Render, or copy `backend/.env.example` to `backend/.env` locally:

```env
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-6-luna
LOGIN_USERNAME=admin
LOGIN_PASSWORD=change_this_password
SECRET_KEY=change_this_to_a_long_random_string
MONGO_URI=mongodb+srv://user:password@cluster.mongodb.net/?retryWrites=true&w=majority
MONGO_DB_NAME=oi_analyzer
FRONTEND_ORIGIN=https://your-netlify-site.netlify.app
```

Cron/keep-alive URL:

```text
https://your-render-backend.onrender.com/health
```

## Frontend Env

Set this in Netlify build environment:

```env
FRONTEND_API_BASE_URL=https://your-render-backend.onrender.com
```

Netlify uses `netlify.toml` to publish `frontend/` and generate `frontend/config.js` during build.

## Run Locally

Backend:

```bash
cd backend
cp .env.example .env
python3 -m pip install -r requirements.txt
python3 app.py
```

Frontend:

```bash
cd frontend
python3 -m http.server 8080
```

Open:

```text
http://localhost:8080
```

The default local backend URL is `http://localhost:10000`.

## API

- `GET /health` - public health check for cron.
- `POST /api/login` - login with env username/password.
- `POST /api/analyze` - authenticated AI analysis; saves each result to MongoDB.
- `GET /api/analyses` - authenticated history list.
- `GET /api/analyses/:id` - authenticated saved analysis detail.

## Disclaimer

For educational purposes only. Not SEBI-registered investment advice. Always use stop losses.
