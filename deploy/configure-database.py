#!/usr/bin/env python3
"""Prepare split database secrets without printing or persisting their values.

Prepare credentials before the staged release. Coordinate removal of the old
runtime's legacy administrator-secret grant immediately before staging, after
owner and final-image isolation checks pass; see docs/RELEASE.md for cold-start
and rollback implications. This helper does not remove that grant.
"""
import os
import secrets
import subprocess
import urllib.parse

project = os.environ.get("ENGRAM_PROJECT", "ani-hq")

def gc(*args, data=None):
    result = subprocess.run(["gcloud", *args, "--project=" + project, "--quiet"], input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise SystemExit("Database secret setup failed; no credential values were logged.")
    return result.stdout

existing = set(gc("secrets", "list", "--format=value(name)").decode().splitlines())
old = gc("secrets", "versions", "access", "latest", "--secret=engram-db-url-template").decode().strip()
parts = urllib.parse.urlsplit(old)
if not parts.username or "__DB__" not in old:
    raise SystemExit("Existing database secret is not a valid template")

new = {}
if "engram-provisioner-db-url-template" not in existing:
    new["engram-provisioner-db-url-template"] = old
if "engram-runtime-db-url-template" not in existing:
    creds = "engram_gateway_runtime:" + secrets.token_hex(32)
    host = parts.netloc.split("@", 1)[-1]
    new["engram-runtime-db-url-template"] = urllib.parse.urlunsplit((parts.scheme, creds + "@" + host, parts.path, parts.query, parts.fragment))
if "engram-tenant-credential-key" not in existing:
    new["engram-tenant-credential-key"] = secrets.token_hex(32)
for name, value in new.items():
    gc("secrets", "create", name, "--data-file=-", data=value.encode())
    print("Created " + name)

runtime = "engram-runtime@" + project + ".iam.gserviceaccount.com"
provisioner = "engram-provisioner@" + project + ".iam.gserviceaccount.com"
bindings = {
    # The web identity is intentionally absent from this list.
    "engram-provisioner-db-url-template": [provisioner],
    "engram-runtime-db-url-template": [runtime, provisioner],
    "engram-tenant-credential-key": [runtime, provisioner],
}
for name, identities in bindings.items():
    for identity in identities:
        gc("secrets", "add-iam-policy-binding", name, "--member=serviceAccount:" + identity, "--role=roles/secretmanager.secretAccessor")
        print("Bound " + identity.split("@", 1)[0] + " access to " + name)
