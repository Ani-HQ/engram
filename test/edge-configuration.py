"""Offline edge configuration checks. No secrets, credentials, cloud or network."""
import contextlib
import copy
import importlib.util
import io
import json
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("engram_edge", pathlib.Path(__file__).parents[1] / "deploy/configure-edge.py")
edge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(edge)
ZONE = "a" * 32
RULESET = "b" * 32
UNRELATED = {"id": "c" * 32, "ref": "another_product", "action": "set_config",
             "expression": '(http.host eq "other.ani.computer")',
             "action_parameters": {"bic": True}, "enabled": True, "version": "8"}


class FakeCloudflare:
    def __init__(self, rules=()):
        self.state = {"id": RULESET, "kind": "zone", "phase": edge.PHASE, "rules": copy.deepcopy(list(rules))}
        self.identity = {"id": ZONE, "name": edge.ZONE, "status": "active"}
        self.calls = []
        self.after_write = None
        self.next_id = 1

    def request(self, method, path, body=None, stage="configuration_read", missing_ok=False):
        self.calls.append((method, path, copy.deepcopy(body)))
        if method == "GET":
            return copy.deepcopy(self.identity if path == "/zones/" + ZONE else self.state)
        assert method in ("POST", "PATCH") and "/rulesets/" + RULESET + "/rules" in path
        assert set(body).issubset(edge.FIELDS | {"position"})
        item = copy.deepcopy(body)
        position = item.pop("position", None)
        if method == "PATCH":
            rule_id = path.rsplit("/", 1)[1]
            old = next(rule for rule in self.state["rules"] if rule["id"] == rule_id)
            self.state["rules"].remove(old)
            assert position == {"after": ""}
        else:
            rule_id = format(self.next_id, "032x")
            self.next_id += 1
            assert position is None
        item["id"] = rule_id
        self.state["rules"].append(item)
        if self.after_write:
            self.after_write(self)
        return copy.deepcopy(self.state)

    def writes(self):
        return [call for call in self.calls if call[0] != "GET"]


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.rules = edge.load_rules()

    def test_default_plan_is_offline_and_pins_scope(self):
        output = io.StringIO()
        with patch.object(edge, "read_secret", side_effect=AssertionError("No secret read in plan")), \
             patch.object(edge, "Cloudflare", side_effect=AssertionError("No client in plan")), contextlib.redirect_stdout(output):
            self.assertEqual(edge.main([]), 0)
        plan = json.loads(output.getvalue())
        self.assertTrue(plan["offline"])
        self.assertEqual(plan["credentialSources"], ["cloudflare-api-token", "cloudflare-zone-id"])
        self.assertEqual(plan["hostname"], "engram.ani.computer")
        self.assertEqual(plan["rules"], self.rules)

    def test_adds_only_owned_rules_and_is_idempotent_preserving_other_sites(self):
        api = FakeCloudflare([UNRELATED])
        report = edge.configure(api, ZONE, self.rules)
        self.assertEqual(report["changedRules"], 2)
        self.assertTrue(report["unrelatedRulesPreserved"])
        self.assertEqual([call[0] for call in api.writes()], ["POST", "POST"])
        self.assertTrue(all(call[1] == "/zones/" + ZONE + "/rulesets/" + RULESET + "/rules" for call in api.writes()))
        self.assertEqual(api.state["rules"][0], UNRELATED)
        self.assertEqual([rule["ref"] for rule in api.state["rules"][-2:]], list(edge.REFS))
        api.calls.clear()
        self.assertEqual(edge.configure(api, ZONE, self.rules)["changedRules"], 0)
        self.assertEqual(api.writes(), [])

    def test_updates_only_owned_rule_ids_and_places_them_after_other_rules(self):
        owned = [{**copy.deepcopy(rule), "id": format(10 + index, "032x")} for index, rule in enumerate(self.rules)]
        owned[0]["action_parameters"]["disable_rum"] = False
        api = FakeCloudflare([owned[0], UNRELATED, owned[1]])
        report = edge.configure(api, ZONE, self.rules)
        self.assertEqual(report["changedRules"], 2)
        self.assertEqual([call[0] for call in api.writes()], ["PATCH", "PATCH"])
        self.assertEqual({call[1].rsplit("/", 1)[1] for call in api.writes()}, {rule["id"] for rule in owned})
        self.assertEqual(api.state["rules"][0], UNRELATED)
        self.assertTrue(edge.verified(api.state, self.rules))

    def test_preflights_both_refs_before_any_write_and_refuses_collisions(self):
        for alteration in (lambda rule: rule.update(expression="true"),
                           lambda rule: rule.update(action="skip"),
                           lambda rule: rule["action_parameters"].update(security_level="off")):
            colliding = {**copy.deepcopy(self.rules[1]), "id": "d" * 32}
            alteration(colliding)
            api = FakeCloudflare([UNRELATED, colliding])
            with self.assertRaisesRegex(edge.EdgeError, "owned_ref_collision"):
                edge.configure(api, ZONE, self.rules)
            self.assertEqual(api.writes(), [])
        duplicate = {**copy.deepcopy(self.rules[0]), "id": "e" * 32}
        api = FakeCloudflare([duplicate, {**duplicate, "id": "f" * 32}])
        with self.assertRaisesRegex(edge.EdgeError, "owned_ref_collision"):
            edge.configure(api, ZONE, self.rules)
        self.assertEqual(api.writes(), [])

    def test_wrong_zone_or_missing_entrypoint_never_creates_or_replaces(self):
        api = FakeCloudflare([UNRELATED])
        api.identity["name"] = "other.example"
        with self.assertRaisesRegex(edge.EdgeError, "zone_identity_mismatch"):
            edge.configure(api, ZONE, self.rules)
        self.assertEqual(api.writes(), [])
        api = FakeCloudflare()
        api.state = None
        with self.assertRaisesRegex(edge.EdgeError, "configuration_entrypoint_missing") as caught:
            edge.configure(api, ZONE, self.rules)
        self.assertFalse(caught.exception.changes_possible)
        self.assertEqual(api.writes(), [])
        self.assertIn("dashboard", edge.failure(caught.exception)["nextStep"])

    def test_concurrent_unrelated_changes_fail_closed_without_overwriting_them(self):
        api = FakeCloudflare([UNRELATED])
        def other_editor(api):
            api.state["rules"][0]["action_parameters"]["bic"] = False
        api.after_write = other_editor
        with self.assertRaisesRegex(edge.EdgeError, "unrelated_rules_changed") as caught:
            edge.configure(api, ZONE, self.rules)
        self.assertTrue(caught.exception.changes_possible)
        self.assertEqual(len(api.writes()), 1)
        self.assertIs(api.state["rules"][0]["action_parameters"]["bic"], False)
        # A concurrent addition is retained rather than erased by a full-ruleset PUT.
        api = FakeCloudflare([UNRELATED])
        def add_once(api):
            api.state["rules"].insert(0, {**copy.deepcopy(UNRELATED), "id": "d" * 32, "ref": "added_concurrently"})
            api.after_write = None
        api.after_write = add_once
        self.assertTrue(edge.configure(api, ZONE, self.rules)["verified"])
        self.assertEqual(api.state["rules"][0]["ref"], "added_concurrently")

    def test_readback_detects_missing_rules_or_ambiguous_failed_write(self):
        api = FakeCloudflare([UNRELATED])
        def fail_after_commit(api):
            raise edge.EdgeError("api_unavailable", "configuration_write")
        api.after_write = fail_after_commit
        with self.assertRaises(edge.EdgeError) as caught:
            edge.configure(api, ZONE, self.rules)
        report = edge.failure(caught.exception)
        self.assertTrue(report["changesMayHaveApplied"])
        self.assertFalse(report["ok"])
        self.assertEqual(len(api.writes()), 1)  # No blind retry creating duplicates.
        self.assertIn("Read back", report["nextStep"])

    def test_permission_failure_is_sanitized_and_names_precise_permission(self):
        token = "secret_token_that_must_never_be_logged"
        error = edge.urllib.error.HTTPError(edge.API, 403, token, {"Secret": token}, io.BytesIO(token.encode()))
        with patch.object(edge.urllib.request, "build_opener") as opener:
            opener.return_value.open.side_effect = error
            with self.assertRaises(edge.EdgeError) as caught:
                edge.Cloudflare(token).request("GET", "/zones/" + ZONE + "/rulesets/phases/" + edge.PHASE + "/entrypoint")
        report = edge.failure(caught.exception)
        self.assertEqual(report["reason"], "permission_denied")
        self.assertIn("Config Settings Read", report["requiredPermission"])
        self.assertIn("Config Settings Write", report["requiredPermission"])
        self.assertNotIn(token, json.dumps(report))
        self.assertFalse(report["changesMayHaveApplied"])

    def test_secrets_stay_in_memory_and_only_exact_sources_are_read_in_run(self):
        token = "secret_token_that_must_never_be_logged"
        completed = types.SimpleNamespace(returncode=0, stdout=token.encode(), stderr=token.encode())
        with patch.object(edge.subprocess, "run", return_value=completed) as command:
            self.assertEqual(edge.read_secret(edge.SECRETS[0]), token)
        call = command.call_args
        self.assertNotIn(token, repr(call.args))
        self.assertEqual(call.args[0][call.args[0].index("--secret") + 1], edge.SECRETS[0])
        self.assertTrue(call.kwargs["capture_output"])
        self.assertEqual(call.kwargs["env"]["CLOUDSDK_CORE_LOG_HTTP"], "false")
        with patch.object(edge, "read_secret", side_effect=[token, ZONE]) as secret, \
             patch.object(edge, "Cloudflare") as client, patch.object(edge, "configure", return_value={"ok": True}), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(edge.main(["--run"]), 0)
        self.assertEqual([call.args[0] for call in secret.call_args_list], list(edge.SECRETS))
        client.assert_called_once_with(token)
        self.assertNotIn(token, output.getvalue())

    def test_prepared_file_cannot_widen_hostname_paths_or_security_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "rules.json"
            for mutate in (lambda rules: rules[0].update(expression="true"),
                           lambda rules: rules[1]["action_parameters"].update(security_level="off"),
                           lambda rules: rules[0].update(enabled=False),
                           lambda rules: rules[0]["action_parameters"].update(disable_rum=1)):
                rules = copy.deepcopy(self.rules)
                mutate(rules)
                path.write_text(json.dumps(rules))
                with self.assertRaisesRegex(edge.EdgeError, "invalid_prepared_rules"):
                    edge.load_rules(path)


if __name__ == "__main__":
    unittest.main()
