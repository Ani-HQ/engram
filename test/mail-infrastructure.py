"""Offline mail-job/scheduler tests. No cloud account or email provider."""
import copy
import importlib.util
import pathlib
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("engram_mail_release", pathlib.Path(__file__).parents[1] / "deploy/mail-series.py")
mail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mail)


class MailInfrastructureTests(unittest.TestCase):
    def setUp(self):
        self.args = types.SimpleNamespace(project="ani-hq", region="us-central1", image="gcr.io/ani-hq/engram:reviewed-build", public_url="https://engram.ani.computer")
        self.policy = {"bindings": [{"role": "roles/run.invoker", "members": ["serviceAccount:" + mail.identity(self.args)]}]}
        self.schedule = {"state": "PAUSED", "schedule": "*/15 * * * *", "timeZone": "Etc/UTC",
            "httpTarget": {"uri": mail.target(self.args), "httpMethod": "POST", "body": "e30=", "oauthToken": {
                "serviceAccountEmail": mail.identity(self.args), "scope": "https://www.googleapis.com/auth/cloud-platform"}}}
        self.job = mail.job_body(self.args)

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

    def test_delivery_disabled_without_admin_secrets_or_tenant_worker(self):
        task = self.job["spec"]["template"]["spec"]["template"]["spec"]
        env = {item["name"]: item for item in task["containers"][0]["env"]}
        self.assertEqual(env["ENGRAM_ONBOARDING_EMAILS"]["value"], "0")
        self.assertEqual(env["ENGRAM_JOB"]["value"], "mail")
        self.assertEqual(env["ENGRAM_WORKER_ISOLATION"]["value"], "process")
        self.assertEqual(task["maxRetries"], 0)
        self.assertEqual(task["serviceAccountName"], "engram-runtime@ani-hq.iam.gserviceaccount.com")
        refs = {item["valueFrom"]["secretKeyRef"]["name"] for item in env.values() if "valueFrom" in item}
        self.assertEqual(refs, {"engram-runtime-db-url-template", "engram-tenant-credential-key", "resend-api-key", "engram-mail-unsubscribe-key"})
        self.assertNotIn("sandboxLauncher", task["containers"][0])

    def test_verification_only_reads_resource_configuration(self):
        with patch.object(mail, "cloud", side_effect=self.fixture) as cloud:
            self.assertEqual(mail.verify(self.args)["state"], "PAUSED")
        self.assertTrue(all(not set(call.args[1]) & {"create", "update", "resume", "execute", "access"} for call in cloud.call_args_list))

    def test_scheduler_uses_google_api_oauth_without_public_endpoint_or_overrides(self):
        flags = mail.schedule_flags(self.args)
        self.assertIn("--http-method=POST", flags)
        self.assertIn("--message-body={}", flags)
        self.assertIn("--oauth-service-account-email=" + mail.identity(self.args), flags)
        self.assertTrue(mail.target(self.args).endswith("/jobs/engram-mail:run"))
        self.assertTrue(mail.target(self.args).startswith("https://run.googleapis.com/v2/projects/ani-hq/"))
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
            with patch.object(mail, "cloud", side_effect=self.fixture), self.assertRaises(RuntimeError):
                mail.verify(self.args)

    def test_prepared_state_requires_disabled_job_but_enable_can_be_retried_safely(self):
        self.job = mail.job_body(self.args, enabled=True)
        self.schedule["state"] = "ENABLED"
        with patch.object(mail, "cloud", side_effect=self.fixture):
            with self.assertRaises(RuntimeError):
                mail.verify(self.args)
            self.assertEqual(mail.verify(self.args, prepared=False)["state"], "ENABLED")

    def test_preparation_keeps_delivery_disabled_and_passes_new_secret_only_on_stdin(self):
        operations = []
        def cloud(args, command, **kwargs):
            operations.append((command, kwargs))
            if command[:3] == ["iam", "service-accounts", "describe"] or command[:2] == ["secrets", "describe"]:
                return None
            if command[:3] == ["scheduler", "jobs", "describe"]:
                return None
            return {}
        with patch.object(mail, "cloud", side_effect=cloud), \
                patch.object(mail, "replace_job", side_effect=lambda args, enabled: operations.append((["replace-job", str(enabled)], {}))), \
                patch.object(mail, "verify"):
            mail.prepare(self.args)
        commands = [row[0] for row in operations]
        self.assertIn(["replace-job", "False"], commands)
        replace_at = commands.index(["replace-job", "False"])
        scheduler_at = next(index for index, command in enumerate(commands) if command[:3] == ["scheduler", "jobs", "create"])
        self.assertLess(replace_at, scheduler_at)
        self.assertEqual(commands[-1][:3], ["scheduler", "jobs", "pause"])
        creation = next(row for row in operations if row[0][:2] == ["secrets", "create"])
        secret = creation[1]["data"]
        self.assertGreaterEqual(len(secret), 32)
        self.assertIn("--data-file=-", creation[0])
        self.assertTrue(all(secret.decode() not in " ".join(command) for command in commands))
        self.assertFalse(any("execute" in command or "resume" in command for command in commands))


if __name__ == "__main__":
    unittest.main()
