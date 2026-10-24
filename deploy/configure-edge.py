#!/usr/bin/env python3
"""Plan or apply the two hostname-scoped Engram Cloudflare configuration rules.

The default is offline. --run reads exactly two Secret Manager values in memory.
Only per-rule POST/PATCH endpoints are used; no ruleset replacement or deletion.
"""
import argparse
import copy
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
PROJECT = "ani-hq"
ZONE = "ani.computer"
HOST = "engram.ani.computer"
PHASE = "http_config_settings"
SECRETS = ("cloudflare-api-token", "cloudflare-zone-id")
REFS = ("engram_self_contained_pages", "engram_machine_clients")
MACHINE_PATHS = (
    "/mcp", "/health", "/healthz", "/api", "/oauth/token", "/oauth/register",
    "/oauth/jwks", "/.well-known/jwks.json", "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp", "/.well-known/openid-configuration",
    "/.well-known/openid-configuration/mcp",
)
EXPRESSIONS = (
    '(http.host eq "' + HOST + '")',
    '(http.host eq "' + HOST + '" and (http.request.uri.path in {'
    + " ".join(json.dumps(path) for path in MACHINE_PATHS)
    + '} or starts_with(http.request.uri.path, "/api/")))',
)
PARAMETERS = ({"disable_rum": True, "email_obfuscation": False}, {"bic": False})
DRAFT = pathlib.Path(__file__).with_name("cloudflare-config-rules.json")
ID = re.compile(r"[a-f0-9]{32}\Z")
FIELDS = {"ref", "description", "expression", "action", "action_parameters", "enabled"}


class EdgeError(Exception):
    def __init__(self, code, stage="configuration_read", changes_possible=False):
        super().__init__(code)
        self.code = code
        self.stage = stage
        self.changes_possible = changes_possible


def require(condition, code, stage="configuration_read"):
    if not condition:
        raise EdgeError(code, stage)


def load_rules(path=DRAFT):
    try:
        raw = pathlib.Path(path).read_bytes()
        require(len(raw) <= 16_384, "invalid_prepared_rules", "plan")
        rules = json.loads(raw)
    except EdgeError:
        raise
    except Exception:
        raise EdgeError("invalid_prepared_rules", "plan") from None
    require(isinstance(rules, list) and len(rules) == 2, "invalid_prepared_rules", "plan")
    for rule, ref, expression, parameters in zip(rules, REFS, EXPRESSIONS, PARAMETERS):
        require(isinstance(rule, dict) and set(rule) == FIELDS, "invalid_prepared_rules", "plan")
        require(rule["ref"] == ref and rule["expression"] == expression
                and rule["action"] == "set_config" and rule["enabled"] is True,
                "invalid_prepared_rules", "plan")
        require(isinstance(rule["description"], str) and 0 < len(rule["description"]) <= 200,
                "invalid_prepared_rules", "plan")
        require(isinstance(rule["action_parameters"], dict)
                and set(rule["action_parameters"]) == set(parameters)
                and all(rule["action_parameters"][key] is value for key, value in parameters.items()),
                "invalid_prepared_rules", "plan")
    return rules


def plan(rules):
    return {"mode": "plan", "offline": True, "project": PROJECT, "zone": ZONE,
            "hostname": HOST, "phase": PHASE, "rules": rules,
            "credentialSources": list(SECRETS), "mutations": "owned per-rule POST/PATCH only",
            "missingEntrypoint": "refuse; create a Configuration Rule in the dashboard first",
            "requiredPermissions": ["Zone Read", "Config Settings Read", "Config Settings Write"],
            "preserves": ["other hostnames", "unrelated rules", "authentication", "WAF", "rate limits"]}


def read_secret(name):
    require(name in SECRETS, "invalid_secret_source", "credentials")
    env = {**os.environ, "CLOUDSDK_CORE_LOG_HTTP": "false", "CLOUDSDK_CORE_DISABLE_FILE_LOGGING": "1"}
    try:
        result = subprocess.run(["gcloud", "secrets", "versions", "access", "latest", "--secret", name,
                                 "--project", PROJECT, "--quiet"], stdin=subprocess.DEVNULL,
                                capture_output=True, timeout=45, env=env)
        require(result.returncode == 0 and len(result.stdout) <= 4096,
                "secret_unavailable", "credentials")
        return result.stdout.decode("utf-8").strip()
    except EdgeError:
        raise
    except Exception:
        raise EdgeError("secret_unavailable", "credentials") from None


class Cloudflare:
    def __init__(self, token):
        require(isinstance(token, str) and re.fullmatch(r"[A-Za-z0-9_-]{20,512}", token),
                "invalid_api_credential", "credentials")
        self.headers = {"Authorization": "Bearer " + token, "Accept": "application/json",
                        "User-Agent": "EngramEdgeConfigurator/1.0"}

    def request(self, method, path, body=None, stage="configuration_read", missing_ok=False):
        require(method in {"GET", "POST", "PATCH"} and re.fullmatch(
            r"/zones/[a-f0-9]{32}(?:/rulesets/(?:phases/http_config_settings/entrypoint|[a-f0-9]{32}(?:/rules(?:/[a-f0-9]{32})?)?))?", path),
            "invalid_api_operation", stage)

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None

        data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        request = urllib.request.Request(API + path, data=data, method=method,
                                         headers={**self.headers, **({"Content-Type": "application/json"} if body is not None else {})})
        try:
            with urllib.request.build_opener(NoRedirect).open(request, timeout=25) as response:
                raw = response.read(2_000_001)
                require(response.status == 200 and len(raw) <= 2_000_000, "invalid_api_response", stage)
                payload = json.loads(raw)
                require(isinstance(payload, dict) and payload.get("success") is True
                        and isinstance(payload.get("result"), dict), "api_rejected", stage)
                return payload["result"]
        except urllib.error.HTTPError as error:
            # Never read/print error bodies or exception text: either can echo secrets.
            with error:
                if error.code == 404 and missing_ok and method == "GET":
                    return None
                if error.code == 403:
                    raise EdgeError("permission_denied", stage) from None
                if error.code == 401:
                    raise EdgeError("authentication_failed", stage) from None
                raise EdgeError("api_http_failure", stage) from None
        except EdgeError:
            raise
        except Exception:
            raise EdgeError("api_unavailable", stage) from None


def entrypoint(api, zone, stage="configuration_read"):
    state = api.request("GET", "/zones/" + zone + "/rulesets/phases/" + PHASE + "/entrypoint",
                        stage=stage, missing_ok=True)
    require(state is not None, "configuration_entrypoint_missing", stage)
    require(isinstance(state, dict) and isinstance(state.get("id"), str) and ID.fullmatch(state["id"])
            and state.get("kind") == "zone" and state.get("phase") == PHASE
            and isinstance(state.get("rules"), list) and len(state["rules"]) <= 1000,
            "invalid_configuration_entrypoint", stage)
    seen = set()
    for rule in state["rules"]:
        require(isinstance(rule, dict) and isinstance(rule.get("id"), str) and ID.fullmatch(rule["id"])
                and rule["id"] not in seen, "invalid_configuration_entrypoint", stage)
        seen.add(rule["id"])
    return state


def owned_rules(state, desired):
    found = {}
    for target in desired:
        matches = [rule for rule in state["rules"] if rule.get("ref") == target["ref"]]
        require(len(matches) <= 1, "owned_ref_collision")
        if matches:
            rule = matches[0]
            # A matching name does not establish ownership of a wider/different rule.
            require(rule.get("expression") == target["expression"] and rule.get("action") == "set_config"
                    and isinstance(rule.get("action_parameters"), dict)
                    and set(rule["action_parameters"]).issubset(target["action_parameters"]),
                    "owned_ref_collision")
            found[target["ref"]] = rule
    return found


def unrelated_snapshot(state):
    return [copy.deepcopy(rule) for rule in state["rules"] if rule.get("ref") not in REFS]


def preserve_unrelated(state, baseline):
    remaining = iter(state["rules"])
    for original in baseline:
        match = next((rule for rule in remaining if rule["id"] == original["id"]), None)
        require(match == original, "unrelated_rules_changed", "configuration_verify")


def matches(rule, target):
    return (all(rule.get(key) == value and type(rule.get(key)) is type(value) for key, value in target.items())
            and all(rule["action_parameters"].get(key) is value
                    for key, value in target["action_parameters"].items()))


def verified(state, desired):
    found = owned_rules(state, desired)
    return (len(found) == 2 and all(matches(found[target["ref"]], target) for target in desired)
            and [rule.get("ref") for rule in state["rules"][-2:]] == list(REFS))


def configure(api, zone, desired):
    attempted = False
    changes = 0
    try:
        identity = api.request("GET", "/zones/" + zone, stage="zone_identity")
        require(identity.get("id") == zone and identity.get("name") == ZONE
                and identity.get("status") == "active", "zone_identity_mismatch", "zone_identity")
        state = entrypoint(api, zone)
        initial_id = state["id"]
        baseline = unrelated_snapshot(state)
        owned_rules(state, desired)  # Check BOTH refs before any write.
        if not verified(state, desired):
            for target in desired:
                # Observe changes since the previous step; never retry an ambiguous write.
                state = entrypoint(api, zone)
                require(state["id"] == initial_id, "configuration_entrypoint_changed")
                preserve_unrelated(state, baseline)
                owned = owned_rules(state, desired).get(target["ref"])
                if owned and matches(owned, target) and state["rules"][-1]["id"] == owned["id"]:
                    continue
                path = "/zones/" + zone + "/rulesets/" + initial_id + "/rules"
                body = copy.deepcopy(target)
                if owned:
                    method, path = "PATCH", path + "/" + owned["id"]
                    body["position"] = {"after": ""}  # Move ONLY this owned rule to the end.
                else:
                    method = "POST"  # API appends a single rule by default.
                attempted = True
                api.request(method, path, body, stage="configuration_write")
                changes += 1
        final = entrypoint(api, zone, "configuration_verify")
        require(final["id"] == initial_id, "configuration_entrypoint_changed", "configuration_verify")
        preserve_unrelated(final, baseline)
        require(verified(final, desired), "owned_rules_not_verified", "configuration_verify")
        return {"ok": True, "mode": "run", "zone": ZONE, "hostname": HOST, "verified": True,
                "changedRules": changes, "ownedRefs": list(REFS), "unrelatedRulesPreserved": True}
    except EdgeError as error:
        error.changes_possible = error.changes_possible or attempted
        raise
    except Exception:
        raise EdgeError("configuration_failed", changes_possible=attempted) from None


def failure(error):
    report = {"ok": False, "reason": error.code, "stage": error.stage,
              "changesMayHaveApplied": error.changes_possible}
    if error.code == "permission_denied":
        report["requiredPermission"] = ("Zone Read scoped to ani.computer" if error.stage == "zone_identity"
                                         else "Config Settings Read and Config Settings Write scoped to ani.computer")
        report["nextStep"] = "Use the Cloudflare dashboard or an appropriately scoped token; do not broaden zone security settings"
    if error.code == "configuration_entrypoint_missing":
        report["nextStep"] = "Create a hostname-scoped Configuration Rule in the Cloudflare dashboard, then rerun; no entrypoint was created"
    if error.changes_possible:
        report["nextStep"] = "Read back the two owned refs before retrying; partial or concurrent changes may require operator review"
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", choices=(PROJECT,), default=PROJECT)
    parser.add_argument("--run", action="store_true", help="Apply the two prepared rules using dedicated in-memory secrets")
    args = parser.parse_args(argv)
    try:
        desired = load_rules()
        if not args.run:
            print(json.dumps(plan(desired), indent=2, sort_keys=True))
            return 0
        token, zone = (read_secret(name) for name in SECRETS)
        require(ID.fullmatch(zone), "invalid_zone_credential", "credentials")
        print(json.dumps(configure(Cloudflare(token), zone, desired), sort_keys=True))
        return 0
    except EdgeError as error:
        print(json.dumps(failure(error), sort_keys=True), file=sys.stderr)
        return 1
    except Exception:
        print(json.dumps(failure(EdgeError("configuration_failed"))), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
