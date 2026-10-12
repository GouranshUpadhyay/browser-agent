"""Quick check WITHOUT the frontend:  python test_agent.py "your goal here" """
import asyncio
import json
import sys

from agent_runner import run_agent_task

goal = " ".join(sys.argv[1:]) or "Go to wikipedia.org, search for 'Mount Everest' and tell me its height."

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

print("Goal:", goal)
result = asyncio.run(run_agent_task(goal))
print(json.dumps(result, indent=2, ensure_ascii=False))
