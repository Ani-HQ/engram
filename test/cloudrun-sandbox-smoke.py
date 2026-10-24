"""Offline safety checks; no cloud identity, network, deployment or real key."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sandbox_smoke", Path(__file__).with_name("integration-cloudrun-sandbox.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class FakeApi:
    def __init__(self, args):
        self.v1, self.v2 = "https://run.invalid/services", "https://run.invalid/services/engram-isolation-check"
        self.service = None
        self.calls = []
        self.fail_ready = False
        self.unknown_create = False

    def get(self):
        return self.service

    def request(self, url, method="GET", body=None, missing=False):
        self.calls.append((url, method))
        if method == "POST":
            self.service = {"metadata": {**body["metadata"], "uid": "our-service-uid"},
                "status": {"url": "https://engram-isolation-check-fixture.a.run.app", "conditions": [{"type": "Ready", "status": "False" if self.fail_ready else "True"}]}}
            if self.unknown_create:
                raise smoke.SmokeError("Cloud Run API did not return a valid response")
            return self.service
        if method == "DELETE":
            if "etag=our-etag" not in url:
                raise AssertionError("Deletion must have the ownership-checked etag")
            self.service = None
            return {"done": True}
        if self.service is None:
            return None
        return {**self.service["metadata"], "etag": "our-etag"}


class SandboxSmokeTests(unittest.TestCase):
    def setUp(self):
        self.args = types.SimpleNamespace(project="ani-hq", region="us-central1", image="gcr.io/ani-hq/engram:reviewed-build", service_account=None, timeout=240)
        smoke.validate(self.args)

    def test_default_plan_never_requests_credentials_or_network(self):
        output = io.StringIO()
        with patch.object(smoke, "cloud", side_effect=AssertionError("No credentials in plan mode")), patch.object(smoke, "run", side_effect=AssertionError("No deployment in plan mode")), contextlib.redirect_stdout(output):
            smoke.main(["--project", self.args.project, "--image", self.args.image])
        result = json.loads(output.getvalue())
        self.assertEqual(result["mode"], "plan")
        self.assertEqual(result["iamChanges"], [])
        self.assertEqual(result["secrets"], [])
        self.assertFalse(result["productionWrites"])

    def test_actual_preflight_program_and_minimal_dummy_environment(self):
        body = smoke.service_body(self.args, "fixture-owner")
        template = body["spec"]["template"]
        container = template["spec"]["containers"][0]
        self.assertTrue(container["sandboxLauncher"])
        self.assertEqual(container["resources"]["limits"], {"memory": "2Gi", "cpu": "1"})
        self.assertEqual(template["metadata"]["annotations"]["autoscaling.knative.dev/maxScale"], "1")
        self.assertEqual(template["metadata"]["annotations"]["autoscaling.knative.dev/minScale"], "0")
        self.assertEqual(template["metadata"]["annotations"]["run.googleapis.com/execution-environment"], "gen2")
        self.assertEqual(len(container["env"]), 6)
        self.assertTrue(all(set(row) == {"name", "value"} for row in container["env"]))
        self.assertLess(smoke.PROGRAM.index("await verifyWorkerIsolation()"), smoke.PROGRAM.index("Bun.serve"))
        self.assertIn("/app/gateway/src/worker-preflight.ts", smoke.PROGRAM)
        self.assertIn("/app/gateway/src/worker-command.ts", smoke.PROGRAM)
        self.assertIn("/app/gateway/src/worker-transport.ts", smoke.PROGRAM)
        self.assertNotIn("gateway/src/index", smoke.PROGRAM)
        self.assertLess(smoke.PROGRAM.index("await verifyWorkerIsolation()"), smoke.PROGRAM.index("writeFileSync(enginePath"))
        self.assertLess(smoke.PROGRAM.index("await cleanupWorker(spec)"), smoke.PROGRAM.index("Bun.serve"))
        self.assertIn("process.env.K_SERVICE !== 'engram-isolation-check'", smoke.PROGRAM)
        self.assertIn("process.getuid() !== 0", smoke.PROGRAM)
        self.assertIn("credential.mode & 0o777) !== 0o600", smoke.PROGRAM)
        self.assertIn("credential.uid !== 0", smoke.PROGRAM)
        self.assertIn("JSON.stringify(spec.args).includes", smoke.PROGRAM)
        self.assertIn("child.stdin.write", smoke.PROGRAM)
        self.assertIn("writeFileSync(enginePath, originalEngine)", smoke.PROGRAM)
        self.assertIn("process.getuid() !== 0", smoke.FAKE_ENGINE)
        self.assertIn("process.getgid() !== 0", smoke.FAKE_ENGINE)
        self.assertNotIn("!== 1000", smoke.PROGRAM)
        self.assertIn("['CapEff','CapPrm','CapInh','CapAmb']", smoke.FAKE_ENGINE)
        self.assertIn("BigInt('0x' + status[name]) !== 0n", smoke.FAKE_ENGINE)
        self.assertIn("status.NoNewPrivs !== '1'", smoke.FAKE_ENGINE)
        self.assertIn("requireRestricted(status)", smoke.FAKE_ENGINE)
        self.assertIn("Bun.spawn(['/usr/bin/python3'", smoke.FAKE_ENGINE)
        self.assertIn("requireRestricted(JSON.parse(childOutput))", smoke.FAKE_ENGINE)
        self.assertNotIn("'CapBnd'", smoke.FAKE_ENGINE)
        self.assertIn("await Bun.stdin.text()", smoke.FAKE_ENGINE)
        self.assertIn("name.startsWith('.engram-worker-env-')", smoke.FAKE_ENGINE)
        self.assertIn("ENGRAM_TENANT_CREDENTIAL_KEY", smoke.FAKE_ENGINE)
        self.assertIn(smoke.BOOTSTRAP_DB, smoke.FAKE_ENGINE)
        self.assertIn("bootstrap-ok", smoke.FAKE_ENGINE)

    def test_unreviewed_images_or_foreign_service_accounts_are_refused(self):
        for image in ["gcr.io/other-project/engram:build", "gcr.io/ani-hq/other:build", "gcr.io/ani-hq/engram", "gcr.io/ani-hq/engram:latest"]:
            with self.subTest(image=image), self.assertRaises(smoke.SmokeError):
                smoke.validate(types.SimpleNamespace(**{**vars(self.args), "image": image}))
        with self.assertRaises(smoke.SmokeError):
            smoke.validate(types.SimpleNamespace(**{**vars(self.args), "service_account": "engram-runtime@foreign-project.iam.gserviceaccount.com"}))

    def test_existing_service_is_never_modified_or_deleted(self):
        api = FakeApi(self.args)
        api.service = {"metadata": {"uid": "someone-elses-service"}}
        with patch.object(smoke, "RunApi", return_value=api), patch.object(smoke, "private_preflight", side_effect=AssertionError("No mutation preflight needed")), self.assertRaisesRegex(smoke.SmokeError, "already exists"):
            smoke.run(self.args)
        self.assertEqual(api.calls, [])

    def test_private_authenticated_smoke_always_removes_owned_service(self):
        api = FakeApi(self.args)
        calls = []
        def invocation(url, identity=None):
            calls.append(identity)
            return (200, {"ok": True}) if identity else (403, None)
        with patch.object(smoke, "RunApi", return_value=api), patch.object(smoke, "private_preflight"), patch.object(smoke, "invoke", invocation), patch.object(smoke, "cloud", return_value="fixture-identity-token"):
            result = smoke.run(self.args)
        self.assertTrue(result["ok"])
        self.assertTrue(result["deleted"])
        self.assertEqual(calls, [None, "fixture-identity-token"])
        self.assertNotIn("fixture-identity-token", json.dumps(result))
        self.assertIsNone(api.service)

    def test_failed_or_unknown_creation_outcome_still_cleans_only_our_service(self):
        for flag in ["fail_ready", "unknown_create"]:
            api = FakeApi(self.args)
            setattr(api, flag, True)
            with self.subTest(flag=flag), patch.object(smoke, "RunApi", return_value=api), patch.object(smoke, "private_preflight"), self.assertRaises(smoke.SmokeError):
                smoke.run(self.args)
            self.assertIsNone(api.service)
            self.assertTrue(any(method == "DELETE" for _, method in api.calls))

    def test_cleanup_refuses_a_concurrent_replacement(self):
        api = FakeApi(self.args)
        api.service = {"metadata": {"uid": "replacement", "labels": {smoke.OWNER_LABEL: "someone-else"}}}
        with self.assertRaisesRegex(smoke.SmokeError, "ownership changed"):
            smoke.cleanup(api, "our-owner-label", "our-original-uid")
        self.assertFalse(any(method == "DELETE" for _, method in api.calls))

    def test_public_invocation_is_rejected_without_iam_changes(self):
        commands = []
        def cloud(args, command, as_json=False):
            commands.append(command)
            if "get-iam-policy" in command:
                return {"bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}]}
            if "roles" in command:
                return {"includedPermissions": ["run.routes.invoke"]}
            return {}
        with patch.object(smoke, "cloud", cloud), self.assertRaisesRegex(smoke.SmokeError, "public invocation"):
            smoke.private_preflight(self.args)
        self.assertTrue(all("create" not in row and "set-iam-policy" not in row and "add-iam-policy-binding" not in row for row in commands))


if __name__ == "__main__":
    unittest.main()
