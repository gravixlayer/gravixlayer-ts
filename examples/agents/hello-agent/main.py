"""A minimal agent.

An agent is an ordinary HTTP service. Two routes matter:

  POST /invoke   take a request, return the whole answer
  POST /stream   take a request, send the answer back in pieces as
                 server-sent events

`/health` is what the platform polls to decide the agent is up.

Nothing here is specific to any framework. Swap the body of `answer` for a
model call, a graph, or whatever your agent actually does.
"""

import asyncio
import json
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

app = FastAPI(title="Hello agent")


def answer(payload: dict) -> str:
    prompt = str(payload.get("prompt", "")).strip()
    if not prompt:
        return "Send a prompt and I will echo it back."
    return f"You said: {prompt}"


@app.get("/health")
def health() -> dict:
    return {"status": "healthy"}


@app.post("/invoke")
async def invoke(request: Request) -> dict:
    body = await request.json()
    payload = body.get("input") or {}

    return {
        "output": answer(payload),
        "session_id": body.get("session_id"),
        "answered_at": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/stream")
async def stream(request: Request) -> StreamingResponse:
    body = await request.json()
    payload = body.get("input") or {}

    async def events():
        for word in answer(payload).split():
            yield f"data: {json.dumps({'type': 'token', 'text': word + ' '})}\n\n"
            await asyncio.sleep(0.05)
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")
