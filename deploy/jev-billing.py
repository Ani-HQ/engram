#!/usr/bin/env python3
"""Prepare a paused Jev billing-export worker; enable it only after release review.

`plan` is offline. `prepare` creates a private job and scoped scheduler identity,
but disables export and pauses the schedule. No provider inference or email is
performed. Secret values are never printed.
Release activation separately enables the reviewed worker.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile

BILLING_JOB = "engram-billing"
BILLING_SCHEDULE = "engram-billing-quarter-hour"


def identity(args):
    return f"engram-billing-scheduler@{args.project}.iam.gserviceaccount.com"


def target(args):
    return f"https://run.googleapis.com/v2/projects/{args.project}/locations/{args.region}/jobs/{BILLING_JOB}:run"


def cloud(args, command, *, data=None, missing=False):
    result = subprocess.run(["gcloud", *command, "--project", args.project, "--quiet", "--format=json"],
                            input=data, capture_output=True, timeout=300)
    if result.returncode:
        if missing and re.search(rb"\bNOT_FOUND\b", result.stderr):
            return None
        raise RuntimeError("Billing infrastructure operation failed; request and credentials withheld")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def job_body(args, enabled=False):
    values = {
        "ENGRAM_JOB": "billing", "ENGRAM_DEPLOYMENT_MODE": "hosted",
        "ENGRAM_DATABASE_AUTHORITY": "runtime", "ENGRAM_WORKER_ISOLATION": "process",
        "ENGRAM_SIGNUP_MODE": "invite-only", "ENGRAM_PUBLIC_URL": args.public_url,
        "ENGRAM_JEV_BILLING_WORKER_ENABLED": "1" if enabled else "0",
        "ENGRAM_CLOUDSQL_INSTANCE": f"{args.project}:{args.region}:engram-pg",
    }
    secret_refs = {"ENGRAM_DB_URL_TEMPLATE": "engram-runtime-db-url-template",
                   "ENGRAM_TENANT_CREDENTIAL_KEY": "engram-tenant-credential-key",
                   "STRIPE_SECRET_KEY": "engram-stripe-secret-key"}
    env = [{"name": name, "value": value} for name, value in values.items()]
    env += [{"name": name, "valueFrom": {"secretKeyRef": {"name": ref, "key": "latest"}}}
            for name, ref in secret_refs.items()]
    return {"apiVersion": "run.googleapis.com/v1", "kind": "Job",
            "metadata": {"name": BILLING_JOB, "namespace": args.project},
            "spec": {"template": {"metadata": {"annotations": {
                "run.googleapis.com/execution-environment": "gen2",
                "run.googleapis.com/cloudsql-instances": values["ENGRAM_CLOUDSQL_INSTANCE"]}},
                "spec": {"taskCount": 1, "parallelism": 1,
                "template": {"spec": {"serviceAccountName": f"engram-runtime@{args.project}.iam.gserviceaccount.com",
                        "maxRetries": 0, "timeoutSeconds": "600",
                        "containers": [{"image": args.image, "env": env,
                            "resources": {"limits": {"cpu": "1", "memory": "512Mi"}}}]}}}}}}


def replace_job(args, enabled=False):
    # Only secret resource names are written here, never secret contents.
    with tempfile.TemporaryDirectory(prefix="engram-billing-release-") as directory:
        path = Path(directory) / "job.json"
        path.write_text(json.dumps(job_body(args, enabled)))
        cloud(args, ["run", "jobs", "replace", str(path), f"--region={args.region}"])


def schedule_flags(args):
    return [f"--location={args.region}", "--schedule=*/15 * * * *", "--time-zone=Etc/UTC",
            f"--uri={target(args)}", "--http-method=POST", "--message-body={}",
            "--headers=Content-Type=application/json", f"--oauth-service-account-email={identity(args)}",
            "--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform",
            "--attempt-deadline=30s", "--max-retry-attempts=0"]


def verify(args, prepared=True):
    for secret in ("engram-stripe-secret-key", "engram-runtime-db-url-template", "engram-tenant-credential-key"):
        version = cloud(args, ["secrets", "versions", "describe", "latest", f"--secret={secret}"])
        if version.get("state") != "ENABLED":
            raise RuntimeError("A required billing secret version is not enabled")
    job = cloud(args, ["run", "jobs", "describe", BILLING_JOB, f"--region={args.region}"])
    task = job["spec"]["template"]["spec"]["template"]["spec"]
    expected_job = job_body(args)
    expected = expected_job["spec"]["template"]["spec"]["template"]["spec"]
    annotations = job["spec"]["template"].get("metadata", {}).get("annotations", {})
    required_annotations = expected_job["spec"]["template"]["metadata"]["annotations"]
    env = {item["name"]: item for item in task["containers"][0]["env"]}
    expected_env = {item["name"]: item for item in expected["containers"][0]["env"]}
    worker_flag = env.pop("ENGRAM_JEV_BILLING_WORKER_ENABLED", {}).get("value")
    expected_env.pop("ENGRAM_JEV_BILLING_WORKER_ENABLED", None)
    run = job["spec"]["template"]["spec"]
    container = task["containers"][0]
    if any(annotations.get(name) != value for name, value in required_annotations.items()) or \
            run["template"].get("metadata") or \
            task.get("serviceAccountName") != expected["serviceAccountName"] or len(task.get("containers", [])) != 1 or \
            container.get("image") != args.image or env != expected_env or task.get("volumes") or \
            container.get("command") or container.get("args") or container.get("sandboxLauncher") or \
            int(run.get("taskCount", 0)) != 1 or int(run.get("parallelism", 0)) != 1 or \
            int(task.get("maxRetries", -1)) != 0 or int(task.get("timeoutSeconds", 0)) != 600 or \
            worker_flag not in ("0", "1") or (prepared and worker_flag != "0"):
        raise RuntimeError("Billing worker differs from the reviewed image, runtime identity or secret bindings")
    policy = cloud(args, ["run", "jobs", "get-iam-policy", BILLING_JOB, f"--region={args.region}"])
    member = "serviceAccount:" + identity(args)
    roles = {row.get("role") for row in policy.get("bindings", []) if member in row.get("members", [])}
    if roles != {"roles/run.invoker"} or any(
            any(item in ("allUsers", "allAuthenticatedUsers") for item in row.get("members", []))
            for row in policy.get("bindings", [])):
        raise RuntimeError("Billing job requires private, job-scoped execution without overrides")
    project_policy = cloud(args, ["projects", "get-iam-policy", args.project])
    if any(member in row.get("members", []) for row in project_policy.get("bindings", [])):
        raise RuntimeError("Billing scheduler must have no project-wide roles")
    schedule = cloud(args, ["scheduler", "jobs", "describe", BILLING_SCHEDULE, f"--location={args.region}"])
    http = schedule.get("httpTarget", {})
    auth = http.get("oauthToken", {})
    if schedule.get("schedule") != "*/15 * * * *" or schedule.get("timeZone") != "Etc/UTC" or \
            http.get("uri") != target(args) or http.get("httpMethod") != "POST" or \
            auth.get("serviceAccountEmail") != identity(args) or \
            auth.get("scope") != "https://www.googleapis.com/auth/cloud-platform" or http.get("oidcToken") or \
            http.get("body") != "e30=" or schedule.get("state") not in ("PAUSED", "ENABLED") or \
            (prepared and schedule.get("state") != "PAUSED"):
        raise RuntimeError("Billing schedule differs from the reviewed private OAuth target")
    return schedule


def prepare(args):
    cloud(args, ["services", "enable", "cloudscheduler.googleapis.com"])
    if cloud(args, ["iam", "service-accounts", "describe", identity(args)], missing=True) is None:
        cloud(args, ["iam", "service-accounts", "create", "engram-billing-scheduler", "--display-name=Engram Jev billing scheduler"])
    # Disable before changing a schedule: preparation must not export charges.
    # Frozen, previously consented usage is the only content this job exports.
    replace_job(args, enabled=False)
    cloud(args, ["run", "jobs", "add-iam-policy-binding", BILLING_JOB, f"--region={args.region}",
                 "--member=serviceAccount:" + identity(args), "--role=roles/run.invoker"])
    existing = cloud(args, ["scheduler", "jobs", "describe", BILLING_SCHEDULE, f"--location={args.region}"], missing=True)
    configured = cloud(args, ["scheduler", "jobs", "update" if existing else "create", "http", BILLING_SCHEDULE, *schedule_flags(args)])
    if configured.get("state") != "PAUSED":
        cloud(args, ["scheduler", "jobs", "pause", BILLING_SCHEDULE, f"--location={args.region}"])
    verify(args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "prepare", "verify", "verify-active", "enable", "pause"))
    parser.add_argument("--allow-customer-billing", action="store_true")
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", default="us-central1")
    parser.add_argument("--image", required=True)
    parser.add_argument("--public-url", default="https://engram.ani.computer")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", args.project) or not re.fullmatch(r"[a-z0-9-]+", args.region):
        raise RuntimeError("Invalid billing resource identity")
    if not args.image.startswith((f"gcr.io/{args.project}/engram:", f"gcr.io/{args.project}/engram@sha256:")) or args.image.endswith(":latest"):
        raise RuntimeError("Use the reviewed immutable Engram image")
    if not re.fullmatch(r"https://[a-zA-Z0-9.-]+", args.public_url):
        raise RuntimeError("Use a canonical HTTPS origin")
    if args.command == "enable" and not args.allow_customer_billing:
        raise RuntimeError("Enable requires the separately reviewed customer billing approval")
    if args.command == "plan":
        print(json.dumps({"job": BILLING_JOB, "schedule": "every15minutes", "secretRefs": ["engram-runtime-db-url-template", "engram-tenant-credential-key", "engram-stripe-secret-key"],
            "schedulerIdentity": identity(args), "prepare": "export disabled; schedule paused",
            "activation": "separate enable command after release review", "inferenceRequested": False}))
        return
    if args.command == "prepare":
        prepare(args)
    elif args.command in ("verify", "verify-active"):
        verify(args, prepared=args.command == "verify")
    elif args.command == "enable":
        schedule = verify(args, prepared=False)
        replace_job(args, enabled=True)
        if schedule.get("state") != "ENABLED":
            cloud(args, ["scheduler", "jobs", "resume", BILLING_SCHEDULE, f"--location={args.region}"])
    else:
        # A rollback record may predate this feature. Missing billing resources
        # must not prevent restoring the application revision.
        schedule = cloud(args, ["scheduler", "jobs", "describe", BILLING_SCHEDULE, f"--location={args.region}"], missing=True)
        if schedule is not None and schedule.get("state") != "PAUSED":
            cloud(args, ["scheduler", "jobs", "pause", BILLING_SCHEDULE, f"--location={args.region}"])
        if cloud(args, ["run", "jobs", "describe", BILLING_JOB, f"--region={args.region}"], missing=True) is not None:
            replace_job(args, enabled=False)
    print(json.dumps({"billingInfrastructure": args.command, "exportsRequestedByThisCommand": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(str(error) if isinstance(error, RuntimeError) else "Billing configuration failed; credentials withheld")
