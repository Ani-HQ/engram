"""Offline Jev billing-job/scheduler tests. No cloud account or payment provider."""
import copy
import importlib.util
import pathlib
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("engram_jev_billing_release", pathlib.Path(__file__).parents[1] / "deploy/jev-billing.py")
billing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(billing)


class JevBillingInfrastructureTests(unittest.TestCase):
    def setUp(self):
        self.args = types.SimpleNamespace(project="ani-hq", region="us-central1", image="gcr.io/ani-hq/engram:reviewed-build", public_url="https://engram.ani.computer")
        self.policy = {"bindings": [{"role": "roles/run.invoker", "members": ["serviceAccount:" + billing.identity(self.args)]}]}
        self.schedule = {"state": "PAUSED", "schedule": "*/15 * * * *", "timeZone": "Etc/UTC",
            "httpTarget": {"uri": billing.target(self.args), "httpMethod": "POST", "body": "e30=", "oauthToken": {
                "serviceAccountEmail": billing.identity(self.args), "scope": "https://www.googleapis.com/auth/cloud-platform"}}}
        self.job = billing.job_body(self.args)

    def fixture(self, args, command, **kwargs):
        if command[:3] == ["secrets", "versions", "describe"]:
            return {"state": "ENABLED"}
        if command[:3] == ["run", "jobs", "describe"]:
            return self.job
        if command[:3] == ["run", "jobs", "get-iam-policy"]:
            return self.policy
        if command[:2] == ["projects", "get-iam-policy"]:
            return {"bindings": []}
        if command[:3] == ["scheduler", "jobs", "describe"]:
            return self.schedule
        raise AssertionError(command)

    def test_export_disabled_without_provider_key_admin_secrets_or_tenant_worker(self):
        task = self.job["spec"]["template"]["spec"]["template"]["spec"]
        env = {item["name"]: item for item in task["containers"][0]["env"]}
        self.assertEqual(env["ENGRAM_JEV_BILLING_WORKER_ENABLED"]["value"], "0")
        self.assertEqual(env["ENGRAM_JOB"]["value"], "billing")
        self.assertEqual(env["ENGRAM_WORKER_ISOLATION"]["value"], "process")
        self.assertEqual(task["maxRetries"], 0)
        self.assertEqual(task["serviceAccountName"], "engram-runtime@ani-hq.iam.gserviceaccount.com")
        refs = {item["valueFrom"]["secretKeyRef"]["name"] for item in env.values() if "valueFrom" in item}
        self.assertEqual(refs, {"engram-runtime-db-url-template", "engram-tenant-credential-key", "engram-stripe-secret-key"})
        self.assertNotIn("sandboxLauncher", task["containers"][0])

    def test_verification_only_reads_resource_configuration(self):
        with patch.object(billing, "cloud", side_effect=self.fixture) as cloud:
            self.assertEqual(billing.verify(self.args)["state"], "PAUSED")
        self.assertTrue(all(not set(call.args[1]) & {"create", "update", "resume", "execute", "access"} for call in cloud.call_args_list))

    def test_cloudsql_and_gen2_belong_to_execution_metadata(self):
        execution = self.job["spec"]["template"]
        self.assertEqual(execution["metadata"]["annotations"], {
            "run.googleapis.com/execution-environment": "gen2",
            "run.googleapis.com/cloudsql-instances": "ani-hq:us-central1:engram-pg"})
        self.assertNotIn("metadata", execution["spec"]["template"])
        execution["metadata"]["annotations"].update({
            "run.googleapis.com/client-name": "gcloud",
            "run.googleapis.com/client-version": "reviewed-client"})
        with patch.object(billing, "cloud", side_effect=self.fixture):
            self.assertEqual(billing.verify(self.args)["state"], "PAUSED")

    def test_missing_wrong_or_misnested_execution_annotations_fail_closed(self):
        baseline = copy.deepcopy(self.job)
        for prepared in (True, False):
            for mutation in ("missing-cloudsql", "wrong-cloudsql", "wrong-generation", "wrong-nesting", "extra-nested-metadata"):
                with self.subTest(prepared=prepared, mutation=mutation):
                    self.job = copy.deepcopy(baseline)
                    execution = self.job["spec"]["template"]
                    annotations = execution["metadata"]["annotations"]
                    if mutation == "missing-cloudsql":
                        annotations.pop("run.googleapis.com/cloudsql-instances")
                    elif mutation == "wrong-cloudsql":
                        annotations["run.googleapis.com/cloudsql-instances"] = "ani-hq:us-central1:other-db"
                    elif mutation == "wrong-generation":
                        annotations["run.googleapis.com/execution-environment"] = "gen1"
                    elif mutation == "wrong-nesting":
                        execution["spec"]["template"]["metadata"] = execution.pop("metadata")
                    else:
                        execution["spec"]["template"]["metadata"] = copy.deepcopy(execution["metadata"])
                    with patch.object(billing, "cloud", side_effect=self.fixture), self.assertRaises(RuntimeError):
                        billing.verify(self.args, prepared=prepared)

    def test_scheduler_uses_google_api_oauth_without_public_endpoint_or_overrides(self):
        flags = billing.schedule_flags(self.args)
        self.assertIn("--http-method=POST", flags)
        self.assertIn("--message-body={}", flags)
        self.assertIn("--oauth-service-account-email=" + billing.identity(self.args), flags)
        self.assertTrue(billing.target(self.args).endswith("/jobs/engram-billing:run"))
        self.assertTrue(billing.target(self.args).startswith("https://run.googleapis.com/v2/projects/ani-hq/"))
        self.assertNotIn("oidc", " ".join(flags))

    def test_wrong_target_identity_or_expanded_authority_fails_closed(self):
        mutations = [
            lambda: self.schedule["httpTarget"].update(uri="https://external.example/collect"),
            lambda: self.schedule["httpTarget"]["oauthToken"].update(serviceAccountEmail="wrong@ani-hq.iam.gserviceaccount.com"),
            lambda: self.policy["bindings"][0].update(role="roles/run.jobsExecutorWithOverrides"),
            lambda: self.policy["bindings"][0]["members"].append("allUsers"),
            lambda: self.job["spec"]["template"]["spec"]["template"]["spec"]["containers"][0].update(image="unreviewed"),
            lambda: self.job["spec"]["template"]["spec"]["template"]["spec"]["containers"][0].update(command=["/bin/sh"], args=["-c", "unreviewed"]),
            lambda: self.job["spec"]["template"]["spec"]["template"]["spec"].update(maxRetries=5),
            lambda: self.job["spec"]["template"]["spec"].update(taskCount=9, parallelism=9),
            lambda: self.schedule.update(state="ENABLED"),
            lambda: self.schedule["httpTarget"].update(body="b3ZlcnJpZGVz"),
        ]
        baseline = copy.deepcopy((self.schedule, self.policy, self.job))
        for mutate in mutations:
            self.schedule, self.policy, self.job = copy.deepcopy(baseline)
            mutate()
            with patch.object(billing, "cloud", side_effect=self.fixture), self.assertRaises(RuntimeError):
                billing.verify(self.args)

    def test_prepared_state_requires_disabled_job_but_enable_can_be_retried_safely(self):
        self.job = billing.job_body(self.args, enabled=True)
        self.schedule["state"] = "ENABLED"
        with patch.object(billing, "cloud", side_effect=self.fixture):
            with self.assertRaises(RuntimeError):
                billing.verify(self.args)
            self.assertEqual(billing.verify(self.args, prepared=False)["state"], "ENABLED")

    def test_preparation_disables_export_before_scheduler_changes_without_running_job(self):
        operations = []
        def cloud(args, command, **kwargs):
            operations.append(command)
            if command[:3] in (["iam", "service-accounts", "describe"], ["scheduler", "jobs", "describe"]):
                return None
            return {}
        with patch.object(billing, "cloud", side_effect=cloud), \
                patch.object(billing, "replace_job", side_effect=lambda args, enabled: operations.append(["replace-job", str(enabled)])), \
                patch.object(billing, "verify"):
            billing.prepare(self.args)
        replace_at = operations.index(["replace-job", "False"])
        scheduler_at = next(i for i, command in enumerate(operations) if command[:3] == ["scheduler", "jobs", "create"])
        self.assertLess(replace_at, scheduler_at)
        self.assertEqual(operations[-1][:3], ["scheduler", "jobs", "pause"])
        self.assertFalse(any("execute" in command or "resume" in command or "access" in command for command in operations))
        self.assertFalse(any(command[:2] == ["secrets", "create"] for command in operations))

    def test_enable_requires_separate_approval_before_any_cloud_operation(self):
        with patch("sys.argv", ["jev-billing.py", "enable", "--project", "ani-hq", "--image", self.args.image]), \
                patch.object(billing, "cloud", side_effect=AssertionError("Must not access cloud")), \
                self.assertRaisesRegex(RuntimeError, "separately reviewed"):
            billing.main()

    def test_prepare_uses_create_headers_then_update_headers_when_retried(self):
        for existing in (False, True):
            with self.subTest(existing=existing):
                operations = []
                def cloud(args, command, **kwargs):
                    operations.append(command)
                    if command[:3] == ["scheduler", "jobs", "describe"]:
                        return copy.deepcopy(self.schedule) if existing else None
                    if command[:3] in (["scheduler", "jobs", "create"], ["scheduler", "jobs", "update"]):
                        self.assertEqual(command[2], "update" if existing else "create")
                        expected = "--update-headers=Content-Type=application/json" if existing else "--headers=Content-Type=application/json"
                        rejected = "--headers=" if existing else "--update-headers="
                        self.assertIn(expected, command)
                        self.assertFalse(any(flag.startswith(rejected) for flag in command))
                        return {"state": "PAUSED" if existing else "ENABLED"}
                    return {}
                with patch.object(billing, "cloud", side_effect=cloud), \
                        patch.object(billing, "replace_job", side_effect=lambda args, enabled: operations.append(["replace-job", str(enabled)])), \
                        patch.object(billing, "verify") as verify:
                    billing.prepare(self.args)
                mutation = next(i for i, command in enumerate(operations) if command[:3] in (["scheduler", "jobs", "create"], ["scheduler", "jobs", "update"]))
                self.assertLess(operations.index(["replace-job", "False"]), mutation)
                self.assertEqual(sum(command[:3] in (["scheduler", "jobs", "create"], ["scheduler", "jobs", "update"]) for command in operations), 1)
                self.assertFalse(any("execute" in command or "resume" in command or "access" in command for command in operations))
                if not existing:
                    self.assertEqual(operations[-1][:3], ["scheduler", "jobs", "pause"])
                verify.assert_called_once_with(self.args)


if __name__ == "__main__":
    unittest.main()
