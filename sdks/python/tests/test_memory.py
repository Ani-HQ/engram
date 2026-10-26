"""Disposable loopback HTTP and framework-shaped fixture tests; no live account."""
import asyncio
import json
import os
import shutil
import stat
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

from engram_memory import EngramMemory
from engram_memory.frameworks import LangGraphMemoryAdapter, PydanticMemoryAdapter, create_adk_memory_plugin, run_with_memory

CONTRACT = json.loads((Path(__file__).resolve().parents[3] / "test" / "fixtures" / "memory-conformance.json").read_text())
TOKEN = "eng_python-fixture-private-token-never-real"


class Gateway:
    def __init__(self):
        self.calls, self.saved = [], []
        self.lose_save, self.lose_report, self.deny, self.delay = False, False, False, 0
        self.fake_automatic = False
        self.deny_writes, self.deny_mcp_writes, self.deny_reads = False, False, False
        self.probe = "emp_" + "a" * 32
        self.probe_read = self.probe_save = False
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                if outer.delay:
                    time.sleep(outer.delay)
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.calls.append(body)
                if outer.deny:
                    self.send_response(401)
                    self.end_headers()
                    return
                name, args = body["params"]["name"], body["params"]["arguments"]
                if (outer.deny_writes and name in ("record_action", "remember")) or (outer.deny_reads and name in CONTRACT["readTools"]):
                    self.send_response(403)
                    self.end_headers()
                    return
                if outer.deny_mcp_writes and name in ("record_action", "remember"):
                    encoded = json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": {"isError": True, "content": [{"type": "text", "text": f"denied: {name} is not allowed for this token"}]}}).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)
                    return
                meta = body["params"]["_meta"]["com.engram/context"]
                if name == "remember":
                    outer.saved.append(args["text"])
                    if outer.lose_save:
                        outer.lose_save = False
                        self.send_response(504)
                        self.end_headers()
                        return
                    outer.probe_save |= meta.get("probeId") == outer.probe
                    data = {"ok": True, "slug": "conformance/retries"}
                elif name == "record_action":
                    if outer.lose_report:
                        outer.lose_report = False
                        self.send_response(504)
                        self.end_headers()
                        return
                    data = {"ok": True, "id": args["eventId"], "status": args["status"], "evidence": "reported"}
                elif name == "whoami":
                    begin = meta.get("verification") == "begin"
                    if begin:
                        outer.probe_read = outer.probe_save = False
                    now = datetime.now(timezone.utc)
                    data = {"token": "fixture", "verification": {
                        "probeId": outer.probe, "status": "passed" if outer.probe_read and outer.probe_save else "pending",
                        "startedAt": now.isoformat(), "expiresAt": (now + timedelta(minutes=15)).isoformat(),
                        "checkedAt": now.isoformat() if outer.probe_read and outer.probe_save else None,
                        "recallVerified": outer.probe_read, "saveVerified": outer.probe_save,
                        "automaticWorkflowVerified": True if outer.fake_automatic else None,
                    }}
                else:
                    outer.probe_read |= meta.get("probeId") == outer.probe
                    data = {"results": [{"slug": "conformance/retries", "snippet": value} for value in outer.saved or [CONTRACT["decision"]]]}
                result = {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}], "_meta": {"engramContext": {"runScoped": True, "available": True}}}
                encoded = json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result}, ensure_ascii=False).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                try:
                    self.wfile.write(encoded)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class MemoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="engram-python-sdk-")).resolve()
        self.gateway = Gateway()
        self.memory = EngramMemory(host=self.gateway.host, token=TOKEN, project="conformance", state_directory=self.root / "state")
        self.task = self.memory.task(runtime="generic", session_id="session", task_id="task", title="Retry policy")

    async def asyncTearDown(self):
        await asyncio.to_thread(self.gateway.close)
        shutil.rmtree(self.root)

    async def test_actual_handoff_all_reads_metadata_and_restart_state(self):
        first = await self.task.start(query=CONTRACT["query"])
        self.assertIn(CONTRACT["decision"], first["context"])
        self.assertLessEqual(first["contextBytes"], CONTRACT["defaultBudgetBytes"])
        saved = await self.task.decision("retry-policy", CONTRACT["unicodeDecision"], topic=CONTRACT["topic"])
        self.assertEqual(saved["status"], "saved")
        resumed = self.memory.task(runtime="generic", session_id="session", task_id="task", title="Retry policy")
        self.assertEqual((await resumed.start(query=CONTRACT["query"]))["status"], "already-retrieved")
        for name in CONTRACT["readTools"]:
            if name != "recall":
                await resumed.call_mcp(name, {"query": CONTRACT["query"], "slug": "conformance/retries"})
        for call in self.gateway.calls:
            context = call["params"]["_meta"]["com.engram/context"]
            self.assertEqual(context["runId"], self.task.run_id)
            self.assertEqual(context["maxBytes"], 4096)
            self.assertEqual(context["integration"]["id"], "engram-sdk-python")
        stored = (self.root / "state" / f"{self.task.run_id}.json").read_text()
        self.assertNotIn(TOKEN, stored)
        self.assertNotIn(CONTRACT["decision"], stored)
        self.assertNotIn(CONTRACT["unicodeDecision"], stored)
        self.assertEqual(stat.S_IMODE((self.root / "state").stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.root / "state" / f"{self.task.run_id}.json").stat().st_mode), 0o600)

    async def test_uncertain_save_never_replayed_and_report_retries_exactly_once(self):
        await self.task.start(query="retry")
        self.gateway.lose_save = True
        self.assertFalse((await self.task.decision("uncertain", "Explicit retry policy."))["ok"])
        again = await self.task.decision("uncertain", "Explicit retry policy.")
        self.assertEqual(again["status"], "uncertain")
        self.assertEqual(len(self.gateway.saved), 1)
        self.gateway.lose_report = True
        await self.task.progress("validation", "Validating the retry policy")
        self.assertEqual((await self.task.progress("validation", "Validating the retry policy"))["status"], "recorded")
        await self.task.progress("validation", "Validating the retry policy")
        reports = [call["params"]["arguments"] for call in self.gateway.calls if call["params"]["name"] == "record_action" and "currentStep" in call["params"]["arguments"]]
        self.assertEqual(len(reports), 2)
        self.assertEqual(reports[0], reports[1])
        self.assertEqual((await self.task.progress("validation", "Different payload"))["status"], "event_conflict")

    async def test_explicit_nonce_flow_and_untrusted_automatic_claim(self):
        begun = await self.task.begin_verification()
        self.assertEqual(begun["status"], "pending")
        await self.task.start(query="retry")
        await self.task.decision("explicit-probe-decision", "Retries retain their request ID.")
        checked = await self.task.verification_status()
        self.assertEqual(checked["status"], "passed")
        self.assertIsNone(checked["verification"]["automaticWorkflowVerified"])
        self.assertTrue(all(call["params"]["_meta"]["com.engram/context"].get("probeId") == self.gateway.probe for call in self.gateway.calls[1:]))
        self.gateway.fake_automatic = True
        self.assertEqual((await self.task.verification_status())["status"], "invalid_response")

    async def test_private_directory_guard_symlink_and_bounded_lock(self):
        directory = self.root / "public"
        directory.mkdir(mode=0o755)
        directory.chmod(0o755)
        public = EngramMemory(host=self.gateway.host, token=TOKEN, project="conformance", state_directory=directory).task(runtime="generic", session_id="session", task_id="task", title="Retry policy")
        self.assertEqual((await public.start(query="retry"))["status"], "unsafe_state_path")
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o755)
        linked = self.root / "linked"
        linked.symlink_to(directory, target_is_directory=True)
        task = EngramMemory(host=self.gateway.host, token=TOKEN, project="conformance", state_directory=linked).task(runtime="generic", session_id="session", task_id="task", title="Retry policy")
        self.assertEqual((await task.start(query="retry"))["status"], "unsafe_state_path")
        state = self.root / "state"
        state.mkdir(mode=0o700)
        lock = state / f"{self.task.run_id}.json.lock"
        lock.write_text("x" * 257)
        lock.chmod(0o600)
        self.assertEqual((await self.task.start(query="retry"))["status"], "unsafe_state_path")
        self.assertTrue(lock.exists())

    async def test_cancel_releases_lock_and_never_reports_completion(self):
        self.gateway.delay = 0.2
        operation = asyncio.create_task(self.task.start(query="retry"))
        await asyncio.sleep(0.04)
        operation.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await operation
        self.assertFalse((self.root / "state" / f"{self.task.run_id}.json.lock").exists())
        self.gateway.delay = 0
        await asyncio.sleep(0.25)
        self.assertTrue((await self.task.start(query="retry"))["ok"])
        self.assertFalse(any(call["params"]["arguments"].get("status") in ("completed", "failed") for call in self.gateway.calls))

    async def test_revocation_is_fail_open_and_old_credential_does_not_retry(self):
        await self.task.start(query="retry")
        self.gateway.deny = True
        self.assertEqual((await self.task.call_mcp("get_page", {"slug": "notes/retries"}))["status"], "authorization_required")
        count = len(self.gateway.calls)
        self.assertEqual((await self.task.decision("later", "Do not send this after revocation."))["status"], "authorization_required")
        self.assertEqual(len(self.gateway.calls), count)
        new = EngramMemory(host=self.gateway.host, token="another-fixture", project="conformance", state_directory=self.root / "state")
        self.assertNotEqual(new.task(runtime="generic", session_id="session", task_id="task", title="Retry policy").run_id, self.task.run_id)

    async def test_write_denial_preserves_reads_but_read_denial_blocks(self):
        for denial in ("deny_writes", "deny_mcp_writes"):
            setattr(self.gateway, denial, True)
            task = self.memory.task(runtime="generic", session_id="session", task_id=denial, title="Retry policy")
            self.assertEqual((await task.start(query=CONTRACT["query"]))["status"], "retrieved")
            self.assertEqual((await task.progress("step", "Inspecting retry policy"))["status"], "permission_denied")
            self.assertEqual((await task.decision("decision", CONTRACT["decision"]))["status"], "permission_denied")
            self.assertEqual((await task.end("completed", "Known result"))["status"], "permission_denied")
            self.assertFalse((await task.status())["ended"])
            self.assertTrue((await task.call_mcp("search", {"query": "another"}))["ok"])
            writes = [call for call in self.gateway.calls if call["params"]["name"] in ("record_action", "remember") and call["params"]["_meta"]["com.engram/context"]["runId"] == task.run_id]
            self.assertEqual(len(writes), 1)
            self.gateway.deny_reads = True
            self.assertEqual((await task.call_mcp("list_pages"))["status"], "authorization_required")
            count = len(self.gateway.calls)
            await task.call_mcp("recall", {"query": "never sent"})
            await task.decision("next", "No new calls.")
            self.assertEqual(len(self.gateway.calls), count)
            self.gateway.deny_reads = False
            setattr(self.gateway, denial, False)

    async def test_explicit_read_only_and_scoped_endpoint_never_write(self):
        for task_id, options in (("readonly", {"can_write": False}), ("scoped", {"host": self.gateway.host + "/mcp/shared/"})):
            memory = EngramMemory(host=options.pop("host", self.gateway.host), token=TOKEN, project="conformance", state_directory=self.root / "state", **options)
            task = memory.task(runtime="generic", session_id="session", task_id=task_id, title="Retry policy")
            self.assertTrue((await task.start(query=CONTRACT["query"]))["ok"])
            self.assertEqual((await task.decision("decision", CONTRACT["decision"]))["status"], "permission_denied")
            self.assertEqual((await task.progress("step", "Known step"))["status"], "permission_denied")
            self.assertEqual((await task.end("completed", "Known result"))["status"], "permission_denied")
            self.assertFalse((await task.status())["canWrite"])
            if task_id == "scoped":
                self.assertEqual(memory.endpoint, self.gateway.host + "/mcp/shared")
        self.assertEqual([call["params"]["name"] for call in self.gateway.calls], ["recall", "recall"])
        self.assertEqual(self.gateway.calls[-1]["params"]["_meta"]["com.engram/context"]["integration"]["capabilities"], ["task-context"])
        memory = EngramMemory(host=self.gateway.host, token=TOKEN, project="conformance", state_directory=self.root / "state", reporting=False)
        task = memory.task(runtime="generic", session_id="session", task_id="quiet", title="Retry policy")
        await task.start(query=CONTRACT["query"])
        self.assertEqual((await task.decision("decision", CONTRACT["decision"]))["status"], "saved")
        self.assertEqual((await task.progress("step", "Known step"))["status"], "permission_denied")
        self.assertEqual([call["params"]["name"] for call in self.gateway.calls[2:]], ["recall", "remember"])


class FakeTask:
    def __init__(self):
        self.progresses, self.ends = [], []

    async def start(self, *, query=None):
        return {"ok": True, "context": "Bounded untrusted memory.", "status": "retrieved"}

    async def progress(self, key, text):
        self.progresses.append((key, text))

    async def end(self, status, outcome):
        self.ends.append((status, outcome))


class FakeMemory:
    def __init__(self):
        self.tasks = []

    def task(self, **identity):
        task = FakeTask()
        self.tasks.append((identity, task))
        return task


class FrameworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_langgraph_configured_progress_and_known_outcome_only(self):
        memory = FakeMemory()
        adapter = LangGraphMemoryAdapter(memory, inject_context=lambda input, context: {**input, "memory": context}, progress_labels={"validate": "Running validation"})
        class Graph:
            async def ainvoke(self, input, config=None):
                assert input["memory"] == "Bounded untrusted memory."
                return "known result"
            async def astream(self, input, config=None, stream_mode=None):
                yield ("updates", {"validate": {"private": "never uploaded"}})
                yield ("custom", {"unconfigured": "ignored"})
        identity = {"session_id": "s", "task_id": "t", "title": "Retry policy"}
        result = await adapter.ainvoke(Graph(), {}, identity=identity)
        self.assertEqual(result["task"].ends, [])
        events = [event async for event in adapter.astream(Graph(), {}, identity=identity)]
        self.assertEqual(len(events), 2)
        self.assertEqual(memory.tasks[-1][1].progresses, [("node:0", "Running validation")])
        self.assertEqual(memory.tasks[-1][1].ends, [])
        await adapter.ainvoke(Graph(), {}, identity=identity, outcome=lambda _: {"status": "completed", "outcome": "Validated retries"})
        self.assertEqual(memory.tasks[-1][1].ends, [("completed", "Validated retries")])

    async def test_adk_lazy_base_callbacks_and_mapped_author(self):
        memory = FakeMemory()
        class Base:
            def __init__(self, *, name):
                self.name = name
        context = SimpleNamespace(invocation_id="invocation")
        injected = []
        plugin = create_adk_memory_plugin(memory, identify=lambda _: {"session_id": "s", "task_id": "t", "title": "Retry policy"}, inject_context=lambda _, text: injected.append(text), progress_labels={"validator": "Validating changes"}, base_plugin=Base)
        self.assertIsNone(await plugin.before_run_callback(invocation_context=context))
        self.assertIsNone(await plugin.on_event_callback(invocation_context=context, event=SimpleNamespace(author="validator", content="never uploaded")))
        self.assertIsNone(await plugin.after_run_callback(invocation_context=context))
        self.assertEqual(injected, ["Bounded untrusted memory."])
        self.assertEqual(memory.tasks[0][1].progresses, [("stage:0", "Validating changes")])
        self.assertEqual(memory.tasks[0][1].ends, [])

    async def test_pydantic_final_event_is_not_completion_or_a_memory_delta(self):
        memory = FakeMemory()
        adapter = PydanticMemoryAdapter(memory, inject_context=lambda prompt, context: prompt + "\n" + context, progress_labels={"check_retries": "Checking retry behavior"})
        Call = type("FunctionToolCallEvent", (), {})
        Final = type("FinalResultEvent", (), {})
        class Agent:
            async def run(self, prompt, *, event_stream_handler):
                assert "Bounded untrusted memory." in prompt
                async def events():
                    call = Call()
                    call.part = SimpleNamespace(tool_name="check_retries", args="private data not uploaded")
                    yield call
                    yield Final()
                await event_stream_handler(None, events())
                return "answer"
        result = await adapter.run(Agent(), "Implement retries", identity={"session_id": "s", "task_id": "t", "title": "Retry policy"})
        self.assertEqual(result["result"], "answer")
        self.assertEqual(result["task"].progresses, [("tool:0", "Checking retry behavior")])
        self.assertEqual(result["task"].ends, [])

    async def test_generic_owned_runtime_explicit_outcome(self):
        memory = FakeMemory()
        result = await run_with_memory(memory, identity={"runtime": "custom", "session_id": "s", "task_id": "t"}, input="input", inject_context=lambda input, context: context, invoke=lambda input, task: input, outcome=lambda _: {"status": "failed", "outcome": "Known validation failure"})
        self.assertEqual(result["task"].ends, [("failed", "Known validation failure")])


class EndpointTests(unittest.TestCase):
    def test_endpoint_controls_cannot_silently_change_the_destination(self):
        for host in ("https://memory.example\n.evil.example", "https://memory.example\t.evil.example", "https://memory.example /mcp", "https://faß.example", "https://éxample.com", "https://%65xample.com", "https://example.com\\evil"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                EngramMemory(host=host, token=TOKEN, project="fixture")

    def test_international_url_is_normalized_before_sending_or_hashing(self):
        client = EngramMemory(host="https://xn--bcher-kva.example/記憶/mcp", token=TOKEN, project="fixture")
        self.assertEqual(client.endpoint, "https://xn--bcher-kva.example/%E8%A8%98%E6%86%B6/mcp")


if __name__ == "__main__":
    unittest.main()
