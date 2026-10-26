"""Disposable SDK interop driver. Configuration arrives on stdin, never argv."""
import asyncio
import json
import sys

from engram_memory import EngramMemory


async def main():
    config = json.load(sys.stdin)
    client = EngramMemory(
        host=config["host"], token=config["token"], project="conformance",
        state_directory=config["stateDirectory"],
    )
    task = client.task(runtime="python-interop", session_id=config["sessionId"],
                       task_id=config["taskId"], title="Verify shared retry context")
    started = await task.start(query=config["query"])
    if config["mode"] == "write":
        result = await task.decision("retry-policy", config["decision"], topic=config["topic"])
        print(json.dumps({"started": started, "saved": result}))
    else:
        additional = []
        for name in config.get("readTools", []):
            if name == "recall":
                continue
            additional.append(await task.call_mcp(name, {"query": config["query"], "slug": "conformance/retries"}))
        print(json.dumps({"started": started, "reads": additional}))


asyncio.run(main())
