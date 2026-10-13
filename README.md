# Browser Agent (backend + frontend)

A browser agent you can chat with, or schedule to do things for you at a set time.

## One-time setup
1. Backend: `cd backend`, then `pip install -r requirements.txt` and `playwright install chromium`
2. In `backend`, make a file named exactly `.env` (copy `.env.example`) and paste your Gemini key:
   `GOOGLE_API_KEY=AIza...`   -> SAVE the file (Ctrl+S). An empty .env = "API key missing".
   Every other setting in `.env.example` is optional.
3. Frontend: `cd frontend`, then `npm install`
4. Optional, recommended: `pip install pre-commit` then `pre-commit install` (blocks commits containing secrets)

## Run (two terminals)
Terminal 1:  `cd backend`  then  `uvicorn main:app`
Terminal 2:  `cd frontend` then  `npm run dev`   -> open http://localhost:5173

The pill at the top of the page tells you the status:
green = ready, yellow = key missing (.env problem), red = backend not running.

## What's inside
- **Chat**: type a goal and watch the live execution graph and activity timeline. Runs keep going if you
  refresh or close the page; reopening it picks them back up. Stop cancels a run on the server.
- **Automations**: describe a task and a time in plain English ("every weekday at 9am, find the price of
  iPhone 16 on Flipkart"). The app shows the exact schedule and next run times to confirm before saving.
  One-time and repeating (cron) schedules, timezone-aware, minimum every 5 minutes. Results appear on the
  Automations page and, if configured, in Telegram. Automations run while the backend is running.

## How it works
- `POST /runs` queues a run; a fixed pool of workers (`MAX_CONCURRENT_RUNS`) executes them.
- Every agent event is stored in the database (`agent.db`, SQLite by default).
  `GET /runs/{id}/events` streams them as Server-Sent Events and resumes from `Last-Event-ID`,
  so a dropped connection never loses or repeats events.
- A scheduler checks for due automations every 15 seconds. If the backend was off, a missed run still
  happens if it's under `MISSED_RUN_GRACE_MINUTES` late. A task never has two runs going at once.
- If the backend restarts mid-run, that run is marked failed (its browser is gone); queued runs resume.
- `POST /run` still returns a result in one blocking call (used by `test_agent.py`).

## Safety defaults
- The agent only reads the public web: it can't run page JavaScript, upload files, or open IP addresses /
  local hosts. Set `ALLOWED_DOMAINS` to limit it to specific sites.
- Only the frontend origin may call the API (`CORS_ORIGINS`). Set `API_TOKEN` to require a token.
- Secrets live only in `backend/.env`, which git ignores.

## Test the agent without the frontend
`cd backend` then `python test_agent.py "Go to wikipedia.org and tell me the height of Mount Everest"`

## If something fails
The page shows a plain-English reason. Full details are printed in the backend terminal.
