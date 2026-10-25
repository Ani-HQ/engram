#!/usr/bin/env python3
"""Stage, verify and explicitly activate an Engram Cloud Run revision.

No IAM grants, secret creation or database passwords are handled here. All
credentials stay in gcloud/Secret Manager memory; the rollback state contains
only revision names, traffic, image identity and smoke outcomes.
"""
import argparse
import copy
import datetime
from decimal import Decimal
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

RUNTIME_SECRETS = {
    "ENGRAM_DB_URL_TEMPLATE": "engram-runtime-db-url-template",
    "ENGRAM_TENANT_CREDENTIAL_KEY": "engram-tenant-credential-key",
    "STRIPE_SECRET_KEY": "engram-stripe-secret-key",
    "STRIPE_WEBHOOK_SECRET": "engram-stripe-webhook-secret",
    "STRIPE_CLOUD_MONTHLY_PRICE_ID": "engram-stripe-cloud-monthly-price-id",
    "STRIPE_PORTAL_CONFIGURATION_ID": "engram-stripe-portal-configuration-id",
    "RESEND_API_KEY": "resend-api-key",
    "ENGRAM_OAUTH_PRIVATE_KEY": "engram-oauth-private-key",
    "JEV_API_KEY": "engram-jev-api-key",
}
PROVISIONER_SECRETS = {key: RUNTIME_SECRETS[key] for key in ("ENGRAM_DB_URL_TEMPLATE", "ENGRAM_TENANT_CREDENTIAL_KEY")}
PROVISIONER_SECRETS["ENGRAM_PROVISIONER_DB_URL_TEMPLATE"] = "engram-provisioner-db-url-template"
REMOVE_RUNTIME = {"ENGRAM_PROVISIONER_DB_URL_TEMPLATE", "ENGRAM_DB_PASSWORD", "PGPASSWORD", "ENGRAM_ALLOW_LEGACY_DB_CREDENTIALS", "ENGRAM_WORKER_DB_URL_TEMPLATE", "ENGRAM_JOB", "REFLEX_API_KEY", "TYPESAFE_API_KEY", "REFLEX_ENDPOINT", "ENGRAM_JEV_MARKUP_BPS", "ENGRAM_JEV_OPERATOR_EMAIL", "ENGRAM_JEV_OPERATOR_WORKSPACE_ID", "ENGRAM_JEV_OPERATOR_MONTHLY_BUDGET_USD", "ENGRAM_JEV_BILLING_WORKER_ENABLED"}


def environment(existing, desired, secrets, remove=()):
    values = {entry["name"]: copy.deepcopy(entry) for entry in existing if entry.get("name") not in remove}
    for name, value in desired.items():
        values[name] = {"name": name, "value": str(value)}
    for name, secret in secrets.items():
        values[name] = {"name": name, "valueFrom": {"secretKeyRef": {"name": secret, "key": "latest"}}}
    return [values[name] for name in sorted(values)]


def pinned_traffic(service):
    result = []
    latest = service.get("status", {}).get("latestReadyRevisionName")
    for entry in service.get("spec", {}).get("traffic", []):
        row = {key: value for key, value in entry.items() if key in ("revisionName", "percent", "tag")}
        if entry.get("latestRevision"):
            if not latest:
                raise RuntimeError("Cannot pin traffic without the current ready revision")
            row["revisionName"] = latest
        if row.get("revisionName"):
            result.append(row)
    if not result and latest:
        result = [{"revisionName": latest, "percent": 100}]
    if sum(row.get("percent", 0) for row in result) != 100:
        raise RuntimeError("Existing traffic must resolve to exactly100percent before staging")
    return result


def service_body(service, args, revision):
    spec = copy.deepcopy(service["spec"])
    template = spec["template"]
    template.setdefault("metadata", {})["name"] = revision
    annotations = template["metadata"].setdefault("annotations", {})
    annotations.update({"run.googleapis.com/cpu-throttling": "false", "autoscaling.knative.dev/minScale": "0", "autoscaling.knative.dev/maxScale": "1", "run.googleapis.com/execution-environment": "gen2"})
    runtime = template["spec"]
    runtime.update({"serviceAccountName": f"engram-runtime@{args.project}.iam.gserviceaccount.com", "timeoutSeconds": 900, "containerConcurrency": 40})
    if len(runtime.get("containers", [])) != 1:
        raise RuntimeError("Release expects one reviewed application container")
    if any("secret" in volume for volume in runtime.get("volumes", [])):
        raise RuntimeError("Mounted secret volumes require a separately reviewed sandbox mask; use the reviewed environment secret bindings")
    container = runtime["containers"][0]
    container["image"] = args.image
    container["sandboxLauncher"] = True
    container["resources"] = {"limits": {"cpu": "1", "memory": "2Gi"}}
    container["env"] = environment(container.get("env", []), runtime_environment(args), RUNTIME_SECRETS, REMOVE_RUNTIME)
    # Keep old revisions explicitly pinned; this candidate has only a tag URL.
    spec["traffic"] = []
    for entry in pinned_traffic(service):
        if entry.get("tag") == args.tag:
            entry.pop("tag")
        if entry.get("percent", 0) or entry.get("tag"):
            spec["traffic"].append(entry)
    spec["traffic"].append({"revisionName": revision, "percent": 0, "tag": args.tag})
    metadata = {key: value for key, value in service["metadata"].items() if key in ("name", "namespace", "resourceVersion", "labels", "annotations")}
    metadata.setdefault("annotations", {})["run.googleapis.com/launch-stage"] = "BETA"
    return {"apiVersion": "serving.knative.dev/v1", "kind": "Service", "metadata": metadata, "spec": spec}


def runtime_environment(args):
    values = {"ENGRAM_DEPLOYMENT_MODE": "hosted", "ENGRAM_SIGNUP_MODE": "invite-only", "ENGRAM_ONBOARDING_EMAILS": "1", "ENGRAM_DATABASE_AUTHORITY": "runtime", "ENGRAM_WORKER_ISOLATION": "cloudrun", "GBRAIN_HOMES_DIR": "/tmp/gbrain-homes", "ENGRAM_CLOUDSQL_INSTANCE": f"{args.project}:{args.region}:engram-pg", "ENGRAM_WORKER_CONNECTOR_SERVICE_ACCOUNT": f"engram-db-connector@{args.project}.iam.gserviceaccount.com", "ENGRAM_PROVISION_JOB": f"projects/{args.project}/locations/{args.region}/jobs/engram-provision", "ENGRAM_PUBLIC_URL": args.public_url, "ENGRAM_OAUTH_AUDIENCE": args.public_url + "/mcp", "ENGRAM_DEV_LOGIN_LINKS": "0", "ENGRAM_INSECURE_COOKIE": "0", "REFLEX_MODEL": "jev-latest", "ENGRAM_JEV_BILLING_ENABLED": "1" if getattr(args, "jev_enable_customer_billing", False) else "0"}
    if getattr(args, "jev_markup_bps", None) is not None:
        values["ENGRAM_JEV_MARKUP_BPS"] = args.jev_markup_bps
    return values


def write_state(path, state):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(state, output, indent=2)
        output.write("\n")


def cloud(args, command, json_output=False, allow_missing=False):
    result = subprocess.run(["gcloud", *command, "--project", args.project, "--quiet", *(["--format=json"] if json_output else [])], stdin=subprocess.DEVNULL, capture_output=True, timeout=1200)
    if result.returncode:
        if allow_missing and re.search(rb"\bNOT_FOUND\b", result.stderr):
            return None
        raise RuntimeError("Cloud release command failed without exposing its request or credentials")
    return json.loads(result.stdout) if json_output else result.stdout.decode().strip()


class RunApi:
    def __init__(self, args):
        self.args = args
        self.endpoint = f"https://{args.region}-run.googleapis.com/apis/"

    def request(self, kind, name, method="GET", body=None):
        token = cloud(self.args, ["auth", "print-access-token"])
        url = self.endpoint + ("serving.knative.dev/v1/" if kind == "services" else "run.googleapis.com/v1/") + f"namespaces/{self.args.project}/{kind}/{name}"
        request = urllib.request.Request(url, method=method, headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError("Cloud Run API failed: HTTP " + str(error.code)) from None


def wait_candidate(api, revision):
    for _ in range(180):
        service = api.request("services", api.args.service)
        status = service.get("status", {})
        ready = status.get("latestReadyRevisionName") == revision
        if ready:
            tagged = next((row.get("url") for row in status.get("traffic", []) if row.get("tag") == api.args.tag and row.get("revisionName") == revision), None)
            if tagged:
                return tagged
        if status.get("latestCreatedRevisionName") == revision and any(row.get("status") == "False" and row.get("type") == "Ready" for row in status.get("conditions", [])):
            raise RuntimeError("Candidate did not become ready; previous traffic remains pinned")
        time.sleep(5)
    raise RuntimeError("Timed out waiting for the tagged candidate; previous traffic remains pinned")


def preflight(args):
    for secret in sorted(set(RUNTIME_SECRETS.values()) | set(PROVISIONER_SECRETS.values())):
        version = cloud(args, ["secrets", "versions", "describe", "latest", "--secret", secret], True)
        if version.get("state") != "ENABLED":
            raise RuntimeError("A required release secret is not enabled")
    for name in ("engram-runtime", "engram-provisioner", "engram-db-connector"):
        cloud(args, ["iam", "service-accounts", "describe", f"{name}@{args.project}.iam.gserviceaccount.com"], True)
    runtime = f"serviceAccount:engram-runtime@{args.project}.iam.gserviceaccount.com"
    for secret in ("engram-provisioner-db-url-template", "engram-db-url-template"):
        admin_policy = cloud(args, ["secrets", "get-iam-policy", secret], True, allow_missing=secret == "engram-db-url-template")
        if admin_policy and any(runtime in row.get("members", []) for row in admin_policy.get("bindings", [])):
            raise RuntimeError("Runtime must not have access to the provisioner credential or its legacy secret")
    policy = cloud(args, ["projects", "get-iam-policy", args.project], True)
    runtime_roles = {row.get("role") for row in policy.get("bindings", []) if runtime in row.get("members", [])}
    if runtime_roles != {"roles/cloudsql.client"}:
        raise RuntimeError("Runtime must have only the reviewed SQL-connect project role; grant other permissions on individual resources")
    connector = f"serviceAccount:engram-db-connector@{args.project}.iam.gserviceaccount.com"
    connector_roles = {row.get("role") for row in policy.get("bindings", []) if connector in row.get("members", [])}
    if connector_roles != {"roles/cloudsql.client"}:
        raise RuntimeError("The worker connector must have only the reviewed SQL-connect project role")
    backup = cloud(args, ["sql", "backups", "describe", args.backup_id, "--instance=engram-pg"], True)
    finished = datetime.datetime.fromisoformat(str(backup.get("endTime", "")).replace("Z", "+00:00"))
    if backup.get("status") != "SUCCESSFUL" or datetime.datetime.now(datetime.timezone.utc) - finished > datetime.timedelta(hours=24):
        raise RuntimeError("A successful database backup from the last24hours is required")


def verify_provision_trigger(args):
    # jobs.run without overrides is the only authority delegated to the web
    # service. Job update/override access could expose its administrator URL.
    policy = cloud(args, ["run", "jobs", "get-iam-policy", "engram-provision", f"--region={args.region}"], True)
    runtime = f"serviceAccount:engram-runtime@{args.project}.iam.gserviceaccount.com"
    roles = {row.get("role") for row in policy.get("bindings", []) if runtime in row.get("members", [])}
    if roles != {"roles/run.invoker"}:
        raise RuntimeError("Runtime needs only job-scoped roles/run.invoker on engram-provision; execution overrides and job updates are forbidden")


def provision(args):
    env = {"ENGRAM_DEPLOYMENT_MODE": "hosted", "ENGRAM_SIGNUP_MODE": "invite-only", "ENGRAM_DATABASE_AUTHORITY": "provisioner", "ENGRAM_JOB": "provision", "ENGRAM_CLOUDSQL_INSTANCE": f"{args.project}:{args.region}:engram-pg", "GBRAIN_HOMES_DIR": "/tmp/gbrain-homes"}
    if getattr(args, "jev_owner_email", ""):
        env["ENGRAM_JEV_OPERATOR_EMAIL"] = args.jev_owner_email
        env["ENGRAM_JEV_OPERATOR_MONTHLY_BUDGET_USD"] = getattr(args, "jev_operator_budget_usd", "1")
        if getattr(args, "jev_owner_workspace", None) is not None:
            env["ENGRAM_JEV_OPERATOR_WORKSPACE_ID"] = args.jev_owner_workspace
    secrets = ",".join(f"{name}={secret}:latest" for name, secret in PROVISIONER_SECRETS.items())
    cloud(args, ["run", "jobs", "deploy", "engram-provision", f"--image={args.image}", f"--region={args.region}", f"--service-account=engram-provisioner@{args.project}.iam.gserviceaccount.com", f"--set-cloudsql-instances={args.project}:{args.region}:engram-pg", "--set-env-vars=" + ",".join(f"{key}={value}" for key, value in env.items()), "--set-secrets=" + secrets, "--memory=2Gi", "--cpu=1", "--tasks=1", "--max-retries=1", "--task-timeout=900s"])
    cloud(args, ["run", "jobs", "execute", "engram-provision", f"--region={args.region}", "--wait"])


def fetch_smoke(url, token=None, method="GET", body=None, workspace=None):
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    # Console routes enforce this CSRF header before cookie authentication.
    # Include it even for the anonymous check, so that check reaches the401
    # authentication boundary rather than stopping at the403 header boundary.
    if urllib.parse.urlsplit(url).path.startswith("/api/"):
        headers["X-Engram-Console"] = "1"
    if token:
        headers["Authorization"] = "Bearer " + token
    if workspace:
        headers["X-Engram-Workspace"] = workspace
    request = urllib.request.Request(url, method=method, headers=headers, data=None if body is None else json.dumps(body).encode())
    try:
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        with urllib.request.build_opener(NoRedirect).open(request, timeout=120) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        with error:
            return error.code, None


def valid_activity_stream(payload, kind):
    # Inspect only the bounded response's shape/evidence. Never print task text,
    # resources, contributor names, response bodies or the read credential.
    if not isinstance(payload, dict) or payload.get("kind") != kind:
        return False
    activities, stats = payload.get("activities"), payload.get("stats")
    if not isinstance(activities, list) or not isinstance(stats, dict):
        return False
    keys = ("running", "completed", "failed", "total")
    if any(type(stats.get(key)) is not int or stats[key] < 0 for key in keys):
        return False
    if stats["total"] != sum(stats[key] for key in keys[:3]):
        return False
    if len(activities) != min(stats["total"], 1) or payload.get("more") is not (stats["total"] > 1):
        return False
    for activity in activities:
        if not isinstance(activity, dict) or not isinstance(activity.get("id"), str) or not activity["id"]:
            return False
        status = activity.get("status")
        if status not in keys[:3] or stats[status] < 1:
            return False
        if kind == "tasks" and (activity.get("evidence") not in ("reported", "mixed") or activity.get("kind") not in ("task", "action")):
            return False
        if kind == "memory" and (activity.get("evidence") != "observed" or activity.get("kind") != "memory"):
            return False
    return True


def valid_mcp_initialization(payload):
    result = payload.get("result") if isinstance(payload, dict) else None
    instructions = result.get("instructions") if isinstance(result, dict) else None
    if not isinstance(instructions, str):
        return False
    # Validate the reporting contract, without coupling a release to the exact
    # wording or logging server-provided instructions or any private response.
    return (all(term in instructions for term in ("record_action", "runId", "actionKey"))
            and re.search(r"\btasks?\b", instructions, re.IGNORECASE) is not None
            and all(re.search(r"\b" + status + r"\b", instructions, re.IGNORECASE)
                    for status in ("running", "completed", "failed")))


def valid_mcp_tool_catalog(payload):
    result = payload.get("result") if isinstance(payload, dict) else None
    tools = result.get("tools") if isinstance(result, dict) else None
    if not isinstance(tools, list):
        return False
    names = {tool.get("name") for tool in tools if isinstance(tool, dict) and isinstance(tool.get("name"), str)}
    return {"record_action", "list_actions", "whoami", "recall", "remember"}.issubset(names)


def smoke(args, state):
    url = state["candidateURL"]
    status, health = fetch_smoke(url + "/health")
    if status != 200 or health.get("status") != "ok":
        raise RuntimeError("Candidate health smoke failed")
    status, plans = fetch_smoke(url + "/api/plans")
    if status != 200 or plans.get("mode") != "hosted" or not plans.get("checkoutAvailable"):
        raise RuntimeError("Candidate hosted billing configuration smoke failed")
    if fetch_smoke(url + "/api/activities?limit=1")[0] != 401:
        raise RuntimeError("Candidate private route was not authentication protected")
    state["publicSmoke"] = True
    state["privateSmoke"] = False
    state.pop("smokeAt", None)
    write_state(args.state_file, state)
    if not args.smoke_token_secret and not getattr(args, "smoke_token_stdin", False):
        state["privateSmoke"] = False
        write_state(args.state_file, state)
        raise RuntimeError("Public smoke passed. Supply an explicitly authorized short-lived workspace1 smoke token secret before activation")
    token = sys.stdin.read(512).strip() if getattr(args, "smoke_token_stdin", False) else cloud(args, ["secrets", "versions", "access", "latest", "--secret", args.smoke_token_secret])
    if not re.fullmatch(r"(?:eng|ens)_[A-Za-z0-9_-]{32,90}", token):
        raise RuntimeError("Private smoke requires an Engram bearer credential, not another secret type")
    status, private = fetch_smoke(url + "/api/activities?limit=1", token, workspace="1")
    if status != 200 or not isinstance(private, dict) or not isinstance(private.get("activities"), list):
        raise RuntimeError("Candidate private activity smoke failed")
    for kind in ("tasks", "memory"):
        status, activity = fetch_smoke(url + f"/api/activities?kind={kind}&limit=1", token, workspace="1")
        if status != 200 or not valid_activity_stream(activity, kind):
            raise RuntimeError("Candidate private activity stream smoke failed")
    if fetch_smoke(url + "/api/activities?kind=invalid-kind&limit=1", token, workspace="1")[0] != 400:
        raise RuntimeError("Candidate activity kind validation smoke failed")
    if fetch_smoke(url + "/api/activities?limit=1", token, workspace="invalid-workspace")[0] != 409:
        raise RuntimeError("Candidate workspace-pin smoke failed")
    status, initialized = fetch_smoke(url + "/mcp", token, "POST", {
        "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "engram-release-smoke", "version": "1"},
        },
    })
    if status != 200 or not valid_mcp_initialization(initialized):
        raise RuntimeError("Candidate MCP task guidance smoke failed")
    status, tools = fetch_smoke(url + "/mcp", token, "POST", {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    if status != 200 or not valid_mcp_tool_catalog(tools):
        raise RuntimeError("Candidate isolated memory worker smoke failed")
    state.update({"privateSmoke": True, "smokeAt": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    write_state(args.state_file, state)


def dream(api, args):
    job = api.request("jobs", "engram-dream")
    spec = copy.deepcopy(job["spec"])
    task = spec["template"]["spec"]["template"]["spec"]
    task["serviceAccountName"] = f"engram-runtime@{args.project}.iam.gserviceaccount.com"
    container = task["containers"][0]
    container.update({"image": args.image, "sandboxLauncher": True})
    container["env"] = environment(container.get("env", []), {**runtime_environment(args), "ENGRAM_JOB": "dream"}, RUNTIME_SECRETS, REMOVE_RUNTIME)
    metadata = {key: value for key, value in job["metadata"].items() if key in ("name", "namespace", "resourceVersion", "labels", "annotations")}
    metadata.setdefault("annotations", {})["run.googleapis.com/launch-stage"] = "BETA"
    api.request("jobs", "engram-dream", "PUT", {"apiVersion": "run.googleapis.com/v1", "kind": "Job", "metadata": metadata, "spec": spec})


def mail_series(args, command):
    # Preparation (including its new resource-scoped IAM/secret) is a separate
    # reviewed step. Release only verifies, enables or pauses that prepared job.
    result = subprocess.run([sys.executable, str(Path(__file__).with_name("mail-series.py")), command,
        "--project", args.project, "--region", args.region, "--image", args.image,
        "--public-url", args.public_url], stdin=subprocess.DEVNULL, capture_output=True, timeout=600)
    if result.returncode:
        raise RuntimeError("Mail worker operation failed; use deploy/mail-series.py to inspect its reviewed configuration")


def jev_billing(args, command):
    flags = ["--allow-customer-billing"] if command == "enable" and args.jev_enable_customer_billing else []
    result = subprocess.run([sys.executable, str(Path(__file__).with_name("jev-billing.py")), command,
        "--project", args.project, "--region", args.region, "--image", args.image,
        "--public-url", args.public_url, *flags], stdin=subprocess.DEVNULL, capture_output=True, timeout=600)
    if result.returncode:
        raise RuntimeError("Jev billing worker operation failed; inspect its private prepared configuration")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "stage", "smoke", "activate", "rollback"))
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", default="us-central1")
    parser.add_argument("--service", default="engram")
    parser.add_argument("--image", required=True)
    parser.add_argument("--tag", default="candidate")
    parser.add_argument("--public-url", default="https://engram.ani.computer")
    parser.add_argument("--state-file", default="release-state.json")
    parser.add_argument("--backup-id", default="")
    parser.add_argument("--jev-owner-email", default=os.environ.get("ENGRAM_JEV_OPERATOR_EMAIL", ""))
    parser.add_argument("--jev-owner-workspace", type=int, default=os.environ.get("ENGRAM_JEV_OPERATOR_WORKSPACE_ID") or None)
    parser.add_argument("--jev-operator-budget-usd", default="1")
    parser.add_argument("--jev-enable-customer-billing", action="store_true")
    parser.add_argument("--jev-markup-bps", type=int)
    token_source = parser.add_mutually_exclusive_group()
    token_source.add_argument("--smoke-token-secret", default="")
    token_source.add_argument("--smoke-token-stdin", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", args.project) or not re.fullmatch(r"[a-z0-9-]+", args.region) or not re.fullmatch(r"[a-z][a-z0-9-]{0,30}", args.tag):
        raise RuntimeError("Invalid release resource identity")
    if not args.image.startswith((f"gcr.io/{args.project}/engram:", f"gcr.io/{args.project}/engram@sha256:")) or args.image.endswith(":latest"):
        raise RuntimeError("Use an explicit immutable build tag or digest in this project's Engram repository")
    if not re.fullmatch(r"https://[a-zA-Z0-9.-]+", args.public_url):
        raise RuntimeError("Use a canonical HTTPS origin")
    if args.jev_owner_email and not re.fullmatch(r"[^\s@,]+@[^\s@,]+\.[^\s@,]+", args.jev_owner_email):
        raise RuntimeError("Use one exact verified owner email for the Jev default")
    if args.jev_owner_workspace is not None and (not args.jev_owner_email or not 1 <= args.jev_owner_workspace <= 2147483647):
        raise RuntimeError("An explicit Jev workspace requires one exact owner email and a positive workspace ID")
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]{1,2})?", args.jev_operator_budget_usd) or not Decimal("1") <= Decimal(args.jev_operator_budget_usd) <= Decimal("100"):
        raise RuntimeError("Use an operator Jev budget between 1 and 100 USD")
    if args.jev_markup_bps is not None and not 0 <= args.jev_markup_bps <= 10000:
        raise RuntimeError("Jev markup must be between 0 and 10000 basis points")
    if args.jev_enable_customer_billing and args.jev_markup_bps is None:
        raise RuntimeError("Customer Jev billing requires an explicitly approved markup; zero means provider price")
    if args.command == "plan":
        print(json.dumps({"service": args.service, "image": args.image, "runtimeSecrets": sorted(RUNTIME_SECRETS.values()), "provisionerOnlySecret": "engram-provisioner-db-url-template", "mailPreparation": "deploy/mail-series.py prepare using this image before staging; delivery stays disabled", "jevCustomerBilling": args.jev_enable_customer_billing, "jevMarkupBps": args.jev_markup_bps, "jevOwnerBootstrapRequested": bool(args.jev_owner_email), "activation": "separate explicit command after private smoke; enable prepared mail worker after traffic activation", "maxInstances": 1, "minInstances": 0, "cpuAlwaysAllocated": True}))
        return
    api = RunApi(args)
    if args.command == "stage":
        if Path(args.state_file).exists():
            raise RuntimeError("Use a fresh state file for each candidate; preserve the previous rollback record")
        if not args.backup_id:
            raise RuntimeError("Provide the verified successful database backup ID")
        preflight(args)
        previous = api.request("services", args.service)
        revision = args.service + "-r-" + str(int(time.time()))
        state = {"version": 1, "project": args.project, "region": args.region, "service": args.service, "image": args.image, "candidateRevision": revision, "tag": args.tag, "backupId": args.backup_id, "priorTraffic": pinned_traffic(previous), "priorReadyRevision": previous.get("status", {}).get("latestReadyRevisionName"), "publicSmoke": False, "privateSmoke": False}
        state["jev"] = {"customerBillingEnabled": args.jev_enable_customer_billing, "markupBps": args.jev_markup_bps}
        write_state(args.state_file, state)
        provision(args)
        api.request("services", args.service, "PUT", service_body(previous, args, revision))
        state["candidateURL"] = wait_candidate(api, revision)
        write_state(args.state_file, state)
        print(json.dumps({"staged": True, "candidateRevision": revision, "candidateURL": state["candidateURL"], "trafficActivated": False}))
        return
    state = json.loads(Path(args.state_file).read_text())
    if any(state.get(key) != getattr(args, key) for key in ("project", "region", "service", "image", "tag")):
        raise RuntimeError("Release state does not match the selected candidate")
    if args.command != "rollback" and state.get("jev", {"customerBillingEnabled": False, "markupBps": None}) != {"customerBillingEnabled": args.jev_enable_customer_billing, "markupBps": args.jev_markup_bps}:
        raise RuntimeError("Use the same reviewed Jev billing settings as the staged candidate")
    if args.command == "smoke":
        current = api.request("services", args.service)
        tagged = next((entry.get("url") for entry in current.get("status", {}).get("traffic", []) if entry.get("tag") == args.tag and entry.get("revisionName") == state["candidateRevision"]), None)
        if tagged != state.get("candidateURL") or not re.fullmatch(r"https://[a-z0-9.-]+\.run\.app", tagged or ""):
            raise RuntimeError("Candidate URL or revision identity changed; refusing to transmit a smoke credential")
        smoke(args, state)
        print(json.dumps({"publicSmoke": True, "privateSmoke": True, "candidateRevision": state["candidateRevision"]}))
        return
    current = api.request("services", args.service)
    if args.command == "activate":
        if not state.get("publicSmoke") or not state.get("privateSmoke"):
            raise RuntimeError("Activation requires successful public and private candidate smoke")
        smoke_at = datetime.datetime.fromisoformat(str(state.get("smokeAt", "")))
        if datetime.datetime.now(datetime.timezone.utc) - smoke_at > datetime.timedelta(hours=2):
            raise RuntimeError("Candidate smoke is stale; verify it again before activation")
        if current.get("status", {}).get("latestReadyRevisionName") != state["candidateRevision"]:
            raise RuntimeError("Candidate identity changed after smoke; refusing activation")
        args.backup_id = state["backupId"]
        preflight(args)
        verify_provision_trigger(args)
        # A prior activation may have changed traffic and enabled one worker
        # before another enable failed. Reverify exact image/IAM/bindings while
        # accepting either worker state, then safely complete missing enables.
        traffic = current.get("spec", {}).get("traffic", [])
        already_active = len(traffic) == 1 and traffic[0].get("revisionName") == state["candidateRevision"] and traffic[0].get("percent") == 100
        worker_check = "verify-active" if already_active else "verify"
        mail_series(args, worker_check)
        jev_billing(args, worker_check if args.jev_enable_customer_billing else "pause")
        dream(api, args)
        current["spec"]["traffic"] = [{"revisionName": state["candidateRevision"], "percent": 100}]
    else:
        mail_series(args, "pause")
        jev_billing(args, "pause")
        current["spec"]["traffic"] = state["priorTraffic"]
    body = {key: current[key] for key in ("apiVersion", "kind", "spec")}
    body["metadata"] = {key: value for key, value in current["metadata"].items() if key in ("name", "namespace", "resourceVersion", "labels", "annotations")}
    api.request("services", args.service, "PUT", body)
    state["activated" if args.command == "activate" else "rolledBack"] = True
    write_state(args.state_file, state)
    if args.command == "activate":
        mail_series(args, "enable")
        state["mailEnabled"] = True
        if args.jev_enable_customer_billing:
            jev_billing(args, "enable")
            state["jevBillingWorkerEnabled"] = True
        write_state(args.state_file, state)
    print(json.dumps({"operation": args.command, "revision": state["candidateRevision"] if args.command == "activate" else state.get("priorReadyRevision"), "databaseRestorePerformed": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else "Release failed without exposing credentials", file=sys.stderr)
        sys.exit(1)
