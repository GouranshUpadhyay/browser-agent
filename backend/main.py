import asyncio
import json
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import agent_runner

app = FastAPI(title="Browser Agent API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class GoalRequest(BaseModel):
    goal: str = Field(min_length=3, max_length=1000)


@app.get("/")
@app.get("/health")
def health():
    # Only reports WHETHER a key is loaded, never the key itself.
    return {"status": "ok", "api_key_loaded": bool(agent_runner._get_api_key()), "model": agent_runner.MODEL}


@app.post("/run")
async def run_task(request: GoalRequest):
    return await agent_runner.run_agent_task(request.goal.strip())


@app.post("/run/stream")
async def run_task_stream(request: GoalRequest):
    """Same as /run, but streams live agent events as Server-Sent Events.

    Each message is `data: {json}`; the last one has type "result" and carries the /run payload.
    Disconnecting stops the agent.
    """

    async def events():
        async for event in agent_runner.stream_agent_task(request.goal.strip()):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
