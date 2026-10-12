# Browser Agent (backend + frontend)

## One-time setup
1. Backend: `cd backend`, then `pip install -r requirements.txt` and `playwright install chromium`
2. In `backend`, make a file named exactly `.env` (copy `.env.example`) and paste your Gemini key:
   `GOOGLE_API_KEY=AIza...`   -> SAVE the file (Ctrl+S). An empty .env = "API key missing".
3. Frontend: `cd frontend`, then `npm install`

## Run (two terminals)
Terminal 1:  `cd backend`  then  `uvicorn main:app`
Terminal 2:  `cd frontend` then  `npm run dev`   -> open http://localhost:5173

The pill at the top of the page tells you the status:
green = ready, yellow = key missing (.env problem), red = backend not running.

## Test the agent without the frontend
`cd backend` then `python test_agent.py "Go to wikipedia.org and tell me the height of Mount Everest"`

## If something fails
The page shows a plain-English reason. Full details are printed in the backend terminal.
