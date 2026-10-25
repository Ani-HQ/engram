#!/usr/bin/env python3
"""Inspect or prepare Engram's dedicated Jev secret. No inference or charges.

plan is offline; check reads the stored key and the official model list;
prepare also grants the existing runtime identity access to this one secret.
No key contents, provider response bodies or owner email are printed.
"""
import argparse
import json
import re
import subprocess
import urllib.error
import urllib.request

SECRET = "engram-jev-api-key"


def cloud(args, command):
    result = subprocess.run(["gcloud", *command, "--project", args.project, "--quiet", "--no-log-http", "--verbosity=error"],
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError("Jev secret setup failed; inspect the selected account and resource IAM without printing the key")
    return result.stdout


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify_provider(key, model, opener=None):
    if not key or key == "unset" or any(character.isspace() for character in key):
        raise RuntimeError("The stored Jev key is unavailable")
    request = urllib.request.Request("https://api.typesafe.ai/v1/models", headers={"Authorization": "Bearer " + key, "Accept": "application/json"})
    try:
        with (opener or urllib.request.build_opener(NoRedirect())).open(request, timeout=15) as response:
            raw = response.read(131073)
            if len(raw) > 131072:
                raise RuntimeError("The provider model response is too large")
            body = json.loads(raw)
    except Exception:
        raise RuntimeError("Jev model verification failed; no inference was requested and provider details were withheld") from None
    if not isinstance(body, dict) or not isinstance(body.get("models"), list):
        raise RuntimeError("The provider model catalogue format is unavailable; no inference was requested")
    if not any(isinstance(entry, dict) and entry.get("name") == model for entry in body["models"]):
        raise RuntimeError("The selected Jev model is unavailable for this key; choose a reviewed model before release")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "check", "prepare"))
    parser.add_argument("--project", required=True)
    parser.add_argument("--model", default="jev-latest")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", args.project) or not (args.model == "jev-latest" or re.fullmatch(r"jev-[0-9]+\.[0-9]+\.[0-9]+", args.model)):
        raise RuntimeError("Use a valid project and the stable Jev alias or an available exact version")
    if args.command == "plan":
        print(json.dumps({"secret": SECRET, "env": "JEV_API_KEY", "model": args.model,
            "recipients": ["gateway", "dream job"], "customerBilling": "requires a separate approved rate and per-workspace opt-in",
            "operatorDefault": "one verified personal owner, explicitly selected during provisioning",
            "providerCall": "GET model list only during check/prepare", "modelIsAlias": args.model == "jev-latest", "inferenceRequested": False}))
        return
    version = json.loads(cloud(args, ["secrets", "versions", "describe", "latest", "--secret", SECRET, "--format=json"]))
    if version.get("state") != "ENABLED":
        raise RuntimeError("Save an enabled Jev key version before preparing this release")
    key = cloud(args, ["secrets", "versions", "access", "latest", "--secret", SECRET]).decode().strip()
    verify_provider(key, args.model)
    del key
    if args.command == "prepare":
        cloud(args, ["secrets", "add-iam-policy-binding", SECRET,
            f"--member=serviceAccount:engram-runtime@{args.project}.iam.gserviceaccount.com", "--role=roles/secretmanager.secretAccessor", "--format=none"])
    print(json.dumps({"configured": args.command == "prepare", "modelAvailable": True, "inferenceRequested": False, "customerBillingEnabled": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(str(error) if isinstance(error, RuntimeError) else "Jev configuration failed; credential details withheld")
