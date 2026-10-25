"""Offline release-template tests. No cloud account, credentials or network."""
import contextlib
import datetime
import importlib.util
import io
import pathlib
import copy
import json
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("engram_release", pathlib.Path(__file__).parents[1] / "deploy/release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.args = types.SimpleNamespace(project="ani-hq", region="us-central1", service="engram", image="gcr.io/ani-hq/engram:reviewed-build", tag="candidate", public_url="https://engram.ani.computer", backup_id="disposable-proof", smoke_token_secret="fixture-token", state_file="unused")
        self.service = {"metadata": {"name": "engram", "namespace": "ani-hq", "resourceVersion": "19", "uid": "must-not-copy"},
            "spec": {"traffic": [{"latestRevision": True, "percent": 100, "tag": "candidate"}], "template": {"metadata": {"name": "engram-old"}, "spec": {"containers": [{"image": "old-image", "env": [{"name": "ENGRAM_PROVISIONER_DB_URL_TEMPLATE", "valueFrom": {"secretKeyRef": {"name": "old-admin", "key": "latest"}}}, {"name": "ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS", "value": "1"}, {"name": "PRESERVED_SETTING", "value": "safe"}]}]}}}, "status": {"latestReadyRevisionName": "engram-old"}}

    def test_candidate_preserves_old_traffic_and_resource_version(self):
        body = release.service_body(self.service, self.args, "engram-candidate")
        self.assertEqual(body["spec"]["traffic"], [{"revisionName": "engram-old", "percent": 100}, {"revisionName": "engram-candidate", "percent": 0, "tag": "candidate"}])
        self.assertEqual(body["metadata"]["resourceVersion"], "19")
        self.assertNotIn("uid", body["metadata"])
        self.assertEqual(self.service["spec"]["traffic"][0]["latestRevision"], True)

    def test_runtime_has_no_admin_credential_and_worker_identity_is_sql_only(self):
        body = release.service_body(self.service, self.args, "engram-candidate")
        task = body["spec"]["template"]["spec"]
        env = {item["name"]: item for item in task["containers"][0]["env"]}
        self.assertNotIn("ENGRAM_PROVISIONER_DB_URL_TEMPLATE", env)
        self.assertNotIn("ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS", env)
        self.assertEqual(env["ENGRAM_DATABASE_AUTHORITY"]["value"], "runtime")
        self.assertEqual(env["ENGRAM_SIGNUP_MODE"]["value"], "invite-only")
        self.assertEqual(env["ENGRAM_DB_URL_TEMPLATE"]["valueFrom"]["secretKeyRef"]["name"], "engram-runtime-db-url-template")
        self.assertEqual(env["ENGRAM_WORKER_CONNECTOR_SERVICE_ACCOUNT"]["value"], "engram-db-connector@ani-hq.iam.gserviceaccount.com")
        self.assertEqual(env["ENGRAM_PROVISION_JOB"]["value"], "projects/ani-hq/locations/us-central1/jobs/engram-provision")
        self.assertEqual(env["PRESERVED_SETTING"]["value"], "safe")
        self.assertTrue(task["containers"][0]["sandboxLauncher"])
        self.assertEqual(task["serviceAccountName"], "engram-runtime@ani-hq.iam.gserviceaccount.com")
        annotations = body["spec"]["template"]["metadata"]["annotations"]
        self.assertEqual(annotations["autoscaling.knative.dev/minScale"], "0")
        self.assertEqual(annotations["autoscaling.knative.dev/maxScale"], "1")
        self.assertEqual(annotations["run.googleapis.com/cpu-throttling"], "false")

    def test_all_billing_refs_are_dedicated_and_only_provisioner_receives_admin(self):
        self.assertEqual(len([key for key in release.RUNTIME_SECRETS if key.startswith("STRIPE_")]), 4)
        self.assertNotIn("ENGRAM_PROVISIONER_DB_URL_TEMPLATE", release.RUNTIME_SECRETS)
        self.assertEqual(release.PROVISIONER_SECRETS["ENGRAM_PROVISIONER_DB_URL_TEMPLATE"], "engram-provisioner-db-url-template")

    def test_unreviewed_mounted_secrets_cannot_enter_the_sandbox_root_view(self):
        self.service["spec"]["template"]["spec"]["volumes"] = [{"name": "parent-secret", "secret": {"secretName": "unreviewed-credential"}}]
        with self.assertRaisesRegex(RuntimeError, "Mounted secret volumes"):
            release.service_body(self.service, self.args, "engram-candidate")

    def test_preflight_is_read_only_and_rejects_runtime_admin_access(self):
        commands = []
        def cloud(args, command, json_output=False, **kwargs):
            commands.append(command)
            if command[:2] == ["projects", "get-iam-policy"]:
                return {"bindings": [{"role": "roles/cloudsql.client", "members": ["serviceAccount:engram-db-connector@ani-hq.iam.gserviceaccount.com", "serviceAccount:engram-runtime@ani-hq.iam.gserviceaccount.com"]}]}
            if "get-iam-policy" in command:
                return {"bindings": []}
            if "backups" in command:
                return {"status": "SUCCESSFUL", "endTime": datetime.datetime.now(datetime.timezone.utc).isoformat()}
            return {"state": "ENABLED"}
        with patch.object(release, "cloud", cloud):
            release.preflight(self.args)
        self.assertTrue(all(not any(word in command for word in ("create", "add", "add-iam-policy-binding", "set-iam-policy")) for command in commands))
        def unsafe(args, command, json_output=False, **kwargs):
            if "get-iam-policy" in command:
                return {"bindings": [{"role": "roles/secretmanager.secretAccessor", "members": ["serviceAccount:engram-runtime@ani-hq.iam.gserviceaccount.com"]}]}
            return {"state": "ENABLED"}
        with patch.object(release, "cloud", unsafe), self.assertRaisesRegex(RuntimeError, "Runtime must not have access"):
            release.preflight(self.args)

    def test_provision_trigger_allows_run_without_override_or_update_authority(self):
        runtime = "serviceAccount:engram-runtime@ani-hq.iam.gserviceaccount.com"
        def policy(*roles):
            return {"bindings": [{"role": role, "members": [runtime]} for role in roles]}
        with patch.object(release, "cloud", return_value=policy("roles/run.invoker")) as call:
            release.verify_provision_trigger(self.args)
            self.assertEqual(call.call_args.args[1], ["run", "jobs", "get-iam-policy", "engram-provision", "--region=us-central1"])
        for roles in ((), ("roles/run.jobsExecutorWithOverrides",), ("roles/run.invoker", "roles/run.developer")):
            with patch.object(release, "cloud", return_value=policy(*roles)), self.assertRaisesRegex(RuntimeError, "execution overrides"):
                release.verify_provision_trigger(self.args)

    def test_smoke_never_transmits_a_misidentified_secret(self):
        requests = []
        def fetch(url, token=None, *args, **kwargs):
            requests.append((url, token))
            if url.endswith("/health"):
                return 200, {"status": "ok"}
            if url.endswith("/api/plans"):
                return 200, {"mode": "hosted", "checkoutAvailable": True}
            return 401, None
        with patch.object(release, "fetch_smoke", fetch), patch.object(release, "write_state"), patch.object(release, "cloud", return_value="postgresql://private-credential"), self.assertRaisesRegex(RuntimeError, "Engram bearer credential"):
            release.smoke(self.args, {"candidateURL": "https://candidate.a.run.app"})
        self.assertTrue(all(token is None for _, token in requests))

    def activity_smoke(self, replacement=None, invalid_status=400, mcp_replacements=None):
        requests, saved = [], []
        credential = "eng_" + "x" * 40
        state = {"candidateURL": "https://candidate.a.run.app", "privateSmoke": True, "smokeAt": "old-proof"}
        def page(kind, evidence):
            return {"kind": kind, "activities": [{"id": "fixture-action", "kind": "action" if kind == "tasks" else "memory", "status": "completed", "evidence": evidence}], "more": False, "stats": {"running": 0, "completed": 1, "failed": 0, "total": 1}}
        def fetch(url, token=None, method="GET", body=None, workspace=None):
            requests.append({"url": url, "token": token, "method": method, "body": body, "workspace": workspace})
            if url.endswith("/health"):
                return 200, {"status": "ok"}
            if url.endswith("/api/plans"):
                return 200, {"mode": "hosted", "checkoutAvailable": True}
            if token is None:
                return 401, None
            if workspace == "invalid-workspace":
                return 409, None
            if "kind=invalid-kind" in url:
                return invalid_status, None
            if url.endswith("/mcp"):
                if mcp_replacements and body["method"] in mcp_replacements:
                    return mcp_replacements[body["method"]]
                if body["method"] == "initialize":
                    return 200, {"result": {"instructions": "For a real task use record_action with runId and actionKey: running while working, then completed or failed with the actual result."}}
                return 200, {"result": {"tools": [{"name": name} for name in ("recall", "remember", "record_action", "list_actions", "whoami")]}}
            if "kind=tasks" in url:
                return 200, replacement if replacement is not None else page("tasks", "reported")
            if "kind=memory" in url:
                return 200, page("memory", "observed")
            return 200, {"activities": []}
        def save(path, value):
            saved.append(dict(value))
        return credential, state, requests, saved, fetch, save

    def test_private_smoke_reads_both_streams_with_the_same_scoped_credential(self):
        credential, state, requests, saved, fetch, save = self.activity_smoke()
        with patch.object(release, "fetch_smoke", fetch), patch.object(release, "cloud", return_value=credential), patch.object(release, "write_state", save):
            release.smoke(self.args, state)
        stream_requests = [row for row in requests if "kind=" in row["url"]]
        self.assertEqual(len(stream_requests), 3)
        self.assertTrue(all(row["token"] == credential and row["workspace"] == "1" and row["method"] == "GET" and row["body"] is None for row in stream_requests))
        self.assertTrue(state["privateSmoke"])
        self.assertFalse(saved[0]["privateSmoke"])
        self.assertTrue(saved[-1]["privateSmoke"])
        self.assertNotIn(credential, str(saved))
        self.assertTrue(all(row["method"] == "GET" or row["url"].endswith("/mcp") and row["body"]["method"] in ("initialize", "tools/list") for row in requests))
        mcp_requests = [row for row in requests if row["url"].endswith("/mcp")]
        self.assertEqual([row["body"]["method"] for row in mcp_requests], ["initialize", "tools/list"])
        self.assertTrue(all(row["token"] == credential for row in mcp_requests))

    def test_private_smoke_rejects_missing_task_guidance_without_publishing_proof(self):
        invalid = [None, [], {}, {"result": None}, {"result": {"instructions": 1}},
                   {"result": {"instructions": "Recall saved memories."}},
                   {"result": {"instructions": "record_action runId actionKey"}},
                   {"result": {"instructions": "For a task record_action with runId and actionKey, running then completed."}}]
        for payload in invalid:
            with self.subTest(payload=payload):
                credential, state, requests, saved, fetch, save = self.activity_smoke(mcp_replacements={"initialize": (200, payload)})
                with patch.object(release, "fetch_smoke", fetch), patch.object(release, "cloud", return_value=credential), patch.object(release, "write_state", save), self.assertRaisesRegex(RuntimeError, "task guidance smoke failed"):
                    release.smoke(self.args, state)
                self.assertFalse(state["privateSmoke"])
                self.assertNotIn("smokeAt", state)
                self.assertTrue(all(not value["privateSmoke"] for value in saved))
                self.assertFalse(any(row.get("body", {}).get("method") == "tools/list" for row in requests if row["body"]))
                self.assertNotIn(credential, str(saved))

    def test_private_smoke_requires_every_reporting_and_memory_tool(self):
        required = ("record_action", "list_actions", "whoami", "recall", "remember")
        for missing in required:
            with self.subTest(missing=missing):
                payload = {"result": {"tools": [{"name": name} for name in required if name != missing]}}
                credential, state, requests, saved, fetch, save = self.activity_smoke(mcp_replacements={"tools/list": (200, payload)})
                with patch.object(release, "fetch_smoke", fetch), patch.object(release, "cloud", return_value=credential), patch.object(release, "write_state", save), self.assertRaisesRegex(RuntimeError, "memory worker smoke failed"):
                    release.smoke(self.args, state)
                self.assertFalse(state["privateSmoke"])
                self.assertNotIn("smokeAt", state)
                self.assertTrue(all(not value["privateSmoke"] for value in saved))
                self.assertNotIn(credential, str(saved))

    def test_mcp_contract_checks_accept_reworded_guidance_and_reject_malformed_catalogs(self):
        self.assertTrue(release.valid_mcp_initialization({"result": {"instructions": "Tasks: record_action. Correlate via runId and actionKey; report running, completed and failed truthfully."}}))
        for payload in (None, [], {}, {"result": None}, {"result": {"tools": "private"}}, {"result": {"tools": [None, "record_action", {"name": ["record_action"]}]}}):
            self.assertFalse(release.valid_mcp_tool_catalog(payload))
        required = [{"name": name} for name in ("record_action", "list_actions", "whoami", "recall", "remember")]
        self.assertTrue(release.valid_mcp_tool_catalog({"result": {"tools": required + [{"name": "additional_tool"}]}}))

    def test_non_success_mcp_contract_response_never_publishes_private_proof(self):
        for method in ("initialize", "tools/list"):
            with self.subTest(method=method):
                credential, state, requests, saved, fetch, save = self.activity_smoke(mcp_replacements={method: (503, None)})
                with patch.object(release, "fetch_smoke", fetch), patch.object(release, "cloud", return_value=credential), patch.object(release, "write_state", save), self.assertRaises(RuntimeError):
                    release.smoke(self.args, state)
                self.assertFalse(state["privateSmoke"])
                self.assertNotIn("smokeAt", state)
                self.assertTrue(all(not value["privateSmoke"] for value in saved))

    def test_private_stream_checks_reject_malformed_counts_and_observed_only_tasks(self):
        valid = {"kind": "tasks", "activities": [{"id": "fixture", "kind": "action", "status": "completed", "evidence": "reported"}], "more": False, "stats": {"running": 0, "completed": 1, "failed": 0, "total": 1}}
        invalid = [None, [], {}, {**valid, "kind": "all"}, {**valid, "activities": "private payload"}, {**valid, "stats": None}, {**valid, "stats": {"running": False, "completed": 1, "failed": 0, "total": 1}}, {**valid, "stats": {"running": 0, "completed": 0, "failed": 0, "total": 1}}, {**valid, "activities": [{**valid["activities"][0], "evidence": "observed", "kind": "memory"}]}]
        for value in invalid:
            self.assertFalse(release.valid_activity_stream(value, "tasks"))
        self.assertTrue(release.valid_activity_stream(valid, "tasks"))
        self.assertTrue(release.valid_activity_stream({**valid, "activities": [{**valid["activities"][0], "kind": "task", "evidence": "mixed"}]}, "tasks"))
        self.assertFalse(release.valid_activity_stream({**valid, "kind": "memory"}, "memory"))
        empty = {"kind": "memory", "activities": [], "more": False, "stats": {"running": 0, "completed": 0, "failed": 0, "total": 0}}
        self.assertTrue(release.valid_activity_stream(empty, "memory"))
        credential, state, requests, saved, fetch, save = self.activity_smoke(replacement={})
        with patch.object(release, "fetch_smoke", fetch), patch.object(release, "cloud", return_value=credential), patch.object(release, "write_state", save), self.assertRaisesRegex(RuntimeError, "activity stream smoke failed"):
            release.smoke(self.args, state)
        self.assertFalse(state["privateSmoke"])
        self.assertNotIn("smokeAt", state)
        self.assertFalse(saved[-1]["privateSmoke"])

    def test_private_smoke_requires_invalid_kind_rejection(self):
        credential, state, requests, saved, fetch, save = self.activity_smoke(invalid_status=200)
        with patch.object(release, "fetch_smoke", fetch), patch.object(release, "cloud", return_value=credential), patch.object(release, "write_state", save), self.assertRaisesRegex(RuntimeError, "kind validation smoke failed"):
            release.smoke(self.args, state)
        self.assertFalse(saved[-1]["privateSmoke"])

    def test_real_smoke_requests_reach_console_authentication_boundary(self):
        requests = []
        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                # Match web.ts: the console header is checked before auth.
                status = 401 if request.get_header("X-engram-console") == "1" else 403
                raise release.urllib.error.HTTPError(request.full_url, status, "fixture", {}, None)
        with patch.object(release.urllib.request, "build_opener", return_value=Opener()):
            self.assertEqual(release.fetch_smoke("https://candidate.a.run.app/api/activities?limit=1"), (401, None))
            self.assertEqual(release.fetch_smoke("https://candidate.a.run.app/api/activities?limit=1", "ens_fixture", workspace="1"), (401, None))
            self.assertEqual(release.fetch_smoke("https://candidate.a.run.app/health"), (403, None))
        self.assertEqual(requests[1].get_header("X-engram-workspace"), "1")
        self.assertEqual(requests[1].get_header("Authorization"), "Bearer ens_fixture")
        self.assertIsNone(requests[2].get_header("X-engram-console"))

    def test_plan_requires_no_cloud_credentials_or_mutation(self):
        output = io.StringIO()
        with patch.object(release, "cloud", side_effect=AssertionError("Plan must not call cloud")), patch("sys.argv", ["release.py", "plan", "--project", "ani-hq", "--image", self.args.image]), contextlib.redirect_stdout(output):
            release.main()
        self.assertIn('"minInstances": 0', output.getvalue())

    def test_jev_billing_is_disabled_and_stale_permissions_are_not_inherited(self):
        existing = self.service["spec"]["template"]["spec"]["containers"][0]["env"]
        existing.extend({"name": name, "value": "unsafe-stale"} for name in (
            "ENGRAM_JEV_MARKUP_BPS", "ENGRAM_JEV_OPERATOR_EMAIL", "ENGRAM_JEV_OPERATOR_MONTHLY_BUDGET_USD",
            "ENGRAM_JEV_BILLING_WORKER_ENABLED", "REFLEX_API_KEY", "TYPESAFE_API_KEY", "REFLEX_ENDPOINT"))
        body = release.service_body(self.service, self.args, "engram-candidate")
        env = {entry["name"]: entry for entry in body["spec"]["template"]["spec"]["containers"][0]["env"]}
        self.assertEqual(env["ENGRAM_JEV_BILLING_ENABLED"]["value"], "0")
        self.assertEqual(env["JEV_API_KEY"]["valueFrom"]["secretKeyRef"]["name"], "engram-jev-api-key")
        self.assertTrue(all(row.get("value") != "unsafe-stale" for row in env.values()))
        self.assertNotIn("JEV_API_KEY", release.PROVISIONER_SECRETS)
        self.args.jev_enable_customer_billing = True
        self.args.jev_markup_bps = 0
        self.assertEqual(release.runtime_environment(self.args)["ENGRAM_JEV_MARKUP_BPS"], 0)

    def test_jev_billing_requires_explicit_rate_without_disclosing_owner(self):
        base = ["release.py", "plan", "--project", "ani-hq", "--image", self.args.image]
        with patch("sys.argv", [*base, "--jev-enable-customer-billing"]), self.assertRaisesRegex(RuntimeError, "explicitly approved"):
            release.main()
        for flags in (["--jev-markup-bps", "-1"], ["--jev-markup-bps", "10001"], ["--jev-operator-budget-usd", "0"], ["--jev-owner-email", "multiple@example.com,other@example.com"]):
            with patch("sys.argv", [*base, *flags]), self.assertRaises(RuntimeError): release.main()
        output = io.StringIO()
        with patch("sys.argv", [*base, "--jev-owner-email", "private-owner@example.com", "--jev-enable-customer-billing", "--jev-markup-bps", "0"]), contextlib.redirect_stdout(output):
            release.main()
        self.assertNotIn("private-owner@example.com", output.getvalue())
        self.assertIn('"jevOwnerBootstrapRequested": true', output.getvalue())

    def test_jev_worker_enable_approval_is_explicit_and_no_secret_is_read(self):
        self.args.jev_enable_customer_billing = True
        with patch.object(release.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)) as operation:
            release.jev_billing(self.args, "enable")
        command = operation.call_args.args[0]
        self.assertIn("--allow-customer-billing", command)
        self.assertNotIn("access", command)

    def test_activation_resumes_after_mail_enable_and_billing_worker_failure(self):
        service = copy.deepcopy(self.service)
        service.update(apiVersion="run.googleapis.com/v1", kind="Service")
        service["status"]["latestReadyRevisionName"] = "engram-candidate"
        worker = {"mail": False, "billing": False, "failedOnce": False}
        checks = []
        class Api:
            def __init__(self, args): pass
            def request(self, resource, name, method="GET", body=None):
                if method == "PUT": service["spec"] = copy.deepcopy(body["spec"])
                return copy.deepcopy(service)
        def mail(args, command):
            checks.append(("mail", command))
            if command == "verify" and worker["mail"]: raise RuntimeError("already enabled")
            if command == "enable": worker["mail"] = True
        def billing(args, command):
            checks.append(("billing", command))
            if command == "enable":
                if not worker["failedOnce"]:
                    worker["failedOnce"] = True
                    raise RuntimeError("simulated enable failure")
                worker["billing"] = True
        with tempfile.TemporaryDirectory() as directory:
            state_file = pathlib.Path(directory) / "reviewed-state.json"
            state_file.write_text(json.dumps({"project": self.args.project, "region": self.args.region, "service": self.args.service,
                "image": self.args.image, "tag": "candidate", "candidateRevision": "engram-candidate", "backupId": "fixture",
                "publicSmoke": True, "privateSmoke": True, "smokeAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "jev": {"customerBillingEnabled": True, "markupBps": 0}}))
            argv = ["release.py", "activate", "--project", self.args.project, "--image", self.args.image,
                "--state-file", str(state_file), "--jev-enable-customer-billing", "--jev-markup-bps", "0"]
            with patch("sys.argv", argv), patch.object(release, "RunApi", Api), patch.object(release, "preflight"), \
                    patch.object(release, "verify_provision_trigger"), patch.object(release, "dream"), \
                    patch.object(release, "mail_series", side_effect=mail), patch.object(release, "jev_billing", side_effect=billing), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, "simulated enable failure"): release.main()
                self.assertTrue(worker["mail"])
                self.assertFalse(worker["billing"])
                release.main()
            self.assertTrue(worker["billing"])
            self.assertIn(("mail", "verify-active"), checks)
            self.assertIn(("billing", "verify-active"), checks)
            self.assertTrue(json.loads(state_file.read_text())["jevBillingWorkerEnabled"])


if __name__ == "__main__":
    unittest.main()
