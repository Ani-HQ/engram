#!/usr/bin/env python3
"""Plan, or explicitly run, the final image's stateless Cloud Run preflight.

Default: print a reviewable plan without credentials, network, or mutations.
--run: create only private engram-isolation-check, execute the image's actual
worker-preflight.ts, authenticate its {ok:true} response, and remove our service.
No secrets, IAM changes, database connections, or production service writes.
Requires existing caller create/get/delete/invoke and service-account-use rights.

Creation uses REST v1 because older gcloud schemas omit sandboxLauncher. Cleanup
uses REST v2's etag precondition; v1 DELETE has no conditional deletion support:
https://docs.cloud.google.com/run/docs/reference/rest/v1/namespaces.services/create
https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/delete
"""
import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

SERVICE = "engram-isolation-check"
OWNER_LABEL = "engram-isolation-owner"
SENTINEL = "engram-isolation-sentinel-not-a-secret-000000000000"
BOOTSTRAP_DB = "postgresql://engram_bootstrap_dummy:engram_bootstrap_dummy@127.0.0.1:1/engram_bootstrap_dummy"
BOOTSTRAP_LINE = '{"jsonrpc":"2.0","id":1,"method":"bootstrap-probe"}\n'
FAKE_ENGINE = r"""#!/usr/local/bin/bun
import { readFileSync, readdirSync } from 'node:fs';
function requireRestricted(status) {
  for (const name of ['CapEff','CapPrm','CapInh','CapAmb']) {
    if (typeof status[name] !== 'string' || !/^[0-9a-f]+$/i.test(status[name]) || BigInt('0x' + status[name]) !== 0n) throw new Error();
  }
  if (status.NoNewPrivs !== '1') throw new Error();
}
try {
  // Cloud Run keeps UID0; the actual boundary is zero usable capabilities plus
  // NoNewPrivs. Do not mistake the provider's retained CapBnd for usable caps.
  if (process.getuid() !== 0 || process.getgid() !== 0) throw new Error();
  const status = Object.fromEntries(readFileSync('/proc/self/status','utf8').trim().split('\n').map(line => {
    const colon = line.indexOf(':'); return [line.slice(0,colon),line.slice(colon+1).trim()];
  }));
  requireRestricted(status);
  const child = Bun.spawn(['/usr/bin/python3','-c',
    'import json; keys={"CapEff","CapPrm","CapInh","CapAmb","NoNewPrivs"}; print(json.dumps({k:v.strip() for k,v in (line.split(":",1) for line in open("/proc/self/status")) if k in keys}))'],
    {stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  const [childCode,childOutput] = await Promise.all([child.exited,new Response(child.stdout).text(),child.stderr.pipeTo(new WritableStream({write(){}}))]);
  if (childCode !== 0) throw new Error();
  requireRestricted(JSON.parse(childOutput));
  if (process.cwd() !== '/gbrain-work' || process.env.HOME !== '/gbrain-work' || process.env.GBRAIN_HOME !== '/gbrain-work') throw new Error();
  if (process.env.GBRAIN_DATABASE_URL !== __BOOTSTRAP_DB__ || process.env.DO_NOT_TRACK !== '1') throw new Error();
  const forbidden = ['ENGRAM_DB_URL_TEMPLATE','ENGRAM_TENANT_CREDENTIAL_KEY','ENGRAM_PROVISIONER_DB_URL_TEMPLATE','STRIPE_SECRET_KEY','RESEND_API_KEY','ENGRAM_OAUTH_PRIVATE_KEY','REFLEX_API_KEY','TYPESAFE_API_KEY','OPENAI_API_KEY','VOYAGE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS'];
  if (forbidden.some(name => process.env[name] !== undefined)) throw new Error();
  if (readdirSync('/gbrain-work').some(name => name.startsWith('.engram-worker-env-'))) throw new Error();
  if (await Bun.stdin.text() !== __BOOTSTRAP_LINE__) throw new Error();
  process.stdout.write('bootstrap-ok\n');
} catch { process.exit(70); }
""".replace("__BOOTSTRAP_DB__", json.dumps(BOOTSTRAP_DB)).replace("__BOOTSTRAP_LINE__", json.dumps(BOOTSTRAP_LINE))
PROGRAM = r"""console.log=()=>{};console.warn=()=>{};console.error=()=>{};
try {
  // This replacement fixture is allowed only inside our disposable test service.
  if (process.env.K_SERVICE !== 'engram-isolation-check' || process.getuid() !== 0) throw new Error();
  const { verifyWorkerIsolation } = await import('/app/gateway/src/worker-preflight.ts');
  await verifyWorkerIsolation();
  const { workerCommand } = await import('/app/gateway/src/worker-command.ts');
  const { cleanupWorker } = await import('/app/gateway/src/worker-transport.ts');
  const { readFileSync, writeFileSync, chmodSync, statSync, existsSync, rmSync } = await import('node:fs');
  const { randomUUID } = await import('node:crypto');
  const enginePath = '/usr/local/bin/gbrain';
  const originalEngine = readFileSync(enginePath);
  const originalMode = statSync(enginePath).mode & 0o777;
  let spec;
  try {
    writeFileSync(enginePath, __FAKE_ENGINE__);
    chmodSync(enginePath, 0o755);
    spec = workerCommand('bootstrap-' + randomUUID(), ['serve'], {
      GBRAIN_DATABASE_URL: __BOOTSTRAP_DB__, DO_NOT_TRACK: '1',
    });
    if (spec.cleanupFiles?.length !== 1) throw new Error();
    const credential = statSync(spec.cleanupFiles[0]);
    if (!credential.isFile() || (credential.mode & 0o777) !== 0o600 || credential.uid !== 0) throw new Error();
    if (JSON.stringify(spec.args).includes(__BOOTSTRAP_DB__) || JSON.stringify(spec.env).includes(__BOOTSTRAP_DB__)) throw new Error();
    const child = Bun.spawn([spec.command, ...spec.args], {
      env: spec.env, cwd: spec.cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    try {
      // Use the real bootstrap's stdin, rather than replacing its entrypoint.
      const output = new Response(child.stdout).text();
      const drained = child.stderr.pipeTo(new WritableStream({write(){}}));
      child.stdin.write(__BOOTSTRAP_LINE__);
      child.stdin.end();
      const [status, text] = await Promise.all([child.exited, output, drained]);
      if (status !== 0 || text.trim() !== 'bootstrap-ok') throw new Error();
    } finally { clearTimeout(timer); }
  } finally {
    try {
      if (spec) {
        await cleanupWorker(spec);
        if ((spec.cleanupFiles ?? []).some(path => existsSync(path))) throw new Error();
        rmSync(spec.cwd, {recursive:true,force:true});
      }
    } finally {
      writeFileSync(enginePath, originalEngine);
      chmodSync(enginePath, originalMode);
    }
  }
  Bun.serve({port:Number(process.env.PORT||8080),fetch(){return Response.json({ok:true});}});
} catch { process.exit(1); }
""".replace("__FAKE_ENGINE__", json.dumps(FAKE_ENGINE)).replace("__BOOTSTRAP_DB__", json.dumps(BOOTSTRAP_DB)).replace("__BOOTSTRAP_LINE__", json.dumps(BOOTSTRAP_LINE))


class SmokeError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def validate(args):
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", args.project):
        raise SmokeError("Use an explicit Google Cloud project ID")
    if not re.fullmatch(r"[a-z]+-[a-z]+[0-9]+", args.region):
        raise SmokeError("Invalid Cloud Run region")
    repository = rf"(?:gcr\.io/{re.escape(args.project)}/engram|[a-z0-9-]+-docker\.pkg\.dev/{re.escape(args.project)}/engram/engram)"
    suffix = r"(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})"
    if not re.fullmatch(repository + suffix, args.image) or args.image.endswith(":latest"):
        raise SmokeError("Use an explicit build tag or digest in this project's Engram image repository; latest is refused")
    args.service_account = args.service_account or f"engram-runtime@{args.project}.iam.gserviceaccount.com"
    if not re.fullmatch(rf"[a-z][a-z0-9-]{{4,28}}[a-z0-9]@{re.escape(args.project)}\.iam\.gserviceaccount\.com", args.service_account):
        raise SmokeError("Use an existing service account in the selected project")
    if not 30 <= args.timeout <= 600:
        raise SmokeError("Readiness timeout must be between30and600seconds")


def service_body(args, owner):
    env = {
        "ENGRAM_DEPLOYMENT_MODE": "hosted", "ENGRAM_DATABASE_AUTHORITY": "runtime",
        "ENGRAM_DB_URL_TEMPLATE": "postgresql://engram_isolation_dummy:engram_isolation_dummy@127.0.0.1:1/__DB__",
        "ENGRAM_TENANT_CREDENTIAL_KEY": SENTINEL,
        "ENGRAM_WORKER_ISOLATION": "cloudrun", "GBRAIN_HOMES_DIR": "/tmp/gbrain-homes",
    }
    return {
        "apiVersion": "serving.knative.dev/v1", "kind": "Service",
        "metadata": {"name": SERVICE, "namespace": args.project, "labels": {OWNER_LABEL: owner},
                     "annotations": {"run.googleapis.com/launch-stage": "BETA"}},
        "spec": {"template": {
            "metadata": {"annotations": {"run.googleapis.com/execution-environment": "gen2",
                "autoscaling.knative.dev/minScale": "0", "autoscaling.knative.dev/maxScale": "1"}},
            "spec": {"serviceAccountName": args.service_account, "timeoutSeconds": 60, "containerConcurrency": 1,
                "containers": [{"image": args.image, "sandboxLauncher": True,
                    "command": ["/usr/local/bin/bun"], "args": ["-e", PROGRAM],
                    "resources": {"limits": {"memory": "2Gi", "cpu": "1"}},
                    "env": [{"name": name, "value": value} for name, value in env.items()]}]}}},
    }


def cloud(args, command, as_json=False):
    try:
        result = subprocess.run(["gcloud", *command, "--project", args.project, "--quiet",
            *(["--format=json"] if as_json else [])], stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        raise SmokeError("Required gcloud read or in-memory authentication failed") from None
    if result.returncode:
        raise SmokeError("Required gcloud read or in-memory authentication failed")
    try:
        return json.loads(result.stdout) if as_json else result.stdout.decode().strip()
    except (ValueError, UnicodeError):
        raise SmokeError("Unexpected gcloud response") from None


class RunApi:
    def __init__(self, args):
        self.args = args
        self.v1 = f"https://{args.region}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{args.project}/services"
        self.v2 = f"https://run.googleapis.com/v2/projects/{args.project}/locations/{args.region}/services/{SERVICE}"

    def request(self, url, method="GET", body=None, missing=False):
        access = cloud(self.args, ["auth", "print-access-token"])
        if not access:
            raise SmokeError("An existing gcloud access identity is required")
        request = urllib.request.Request(url, method=method,
            headers={"Authorization": "Bearer " + access, "Content-Type": "application/json"},
            data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if missing and error.code == 404:
                return None
            raise SmokeError(f"Cloud Run API failed with HTTP{error.code}") from None
        except (OSError, ValueError):
            raise SmokeError("Cloud Run API did not return a valid response") from None

    def get(self):
        return self.request(self.v1 + "/" + SERVICE, missing=True)


def assert_owner(service, owner, expected_uid=None, v2=False):
    metadata = service if v2 else service.get("metadata", {})
    if metadata.get("labels", {}).get(OWNER_LABEL) != owner or not metadata.get("uid"):
        raise SmokeError("Temporary service ownership changed; refusing to modify it")
    if expected_uid and metadata["uid"] != expected_uid:
        raise SmokeError("Temporary service was replaced; refusing to modify it")
    return metadata["uid"]


def private_preflight(args):
    # Read only. Do not create identities or grant invocation permissions.
    cloud(args, ["iam", "service-accounts", "describe", args.service_account], True)
    policy = cloud(args, ["projects", "get-iam-policy", args.project], True)
    for binding in policy.get("bindings", []):
        if not {"allUsers", "allAuthenticatedUsers"}.intersection(binding.get("members", [])):
            continue
        role = binding.get("role", "")
        # Resolve actual permissions rather than assuming a custom role is safe.
        if not re.fullmatch(r"(?:roles/[A-Za-z0-9_.]+|projects/[a-z0-9-]+/roles/[A-Za-z0-9_.]+|organizations/[0-9]+/roles/[A-Za-z0-9_.]+)", role):
            raise SmokeError("Cannot establish private invocation from the project IAM policy")
        definition = cloud(args, ["iam", "roles", "describe", role], True)
        if "run.routes.invoke" in definition.get("includedPermissions", []):
            raise SmokeError("Project-wide public invocation prevents a private-only smoke; no IAM was changed")


def ready_url(api, owner, uid, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        service = api.get()
        if not service:
            raise SmokeError("Temporary service disappeared before readiness")
        assert_owner(service, owner, uid)
        status = service.get("status", {})
        conditions = status.get("conditions", [])
        if any(row.get("type") == "Ready" and row.get("status") == "True" for row in conditions):
            url = status.get("url", "")
            parsed = urllib.parse.urlsplit(url)
            if parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".run.app") or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
                raise SmokeError("Temporary service returned an unexpected invocation URL")
            return url
        if any(row.get("type") == "Ready" and row.get("status") == "False" for row in conditions):
            raise SmokeError("Actual image preflight did not become ready; no private diagnostics were printed")
        time.sleep(2)
    raise SmokeError("Timed out waiting for the actual image preflight")


def invoke(url, identity=None):
    headers = {"Accept": "application/json"}
    if identity:
        headers["Authorization"] = "Bearer " + identity
    try:
        with urllib.request.build_opener(NoRedirect).open(urllib.request.Request(url + "/", headers=headers), timeout=30) as response:
            data = response.read(2048)
            return response.status, json.loads(data)
    except urllib.error.HTTPError as error:
        return error.code, None
    except (OSError, ValueError):
        raise SmokeError("Temporary service invocation failed") from None


def cleanup(api, owner, uid):
    current = api.request(api.v2, missing=True)
    if not current:
        return
    assert_owner(current, owner, uid, v2=True)
    etag = current.get("etag")
    if not isinstance(etag, str) or not etag:
        raise SmokeError("Conditional temporary service cleanup is unavailable")
    # REST v2 etag ensures a concurrent replacement/update cannot be deleted.
    api.request(api.v2 + "?" + urllib.parse.urlencode({"etag": etag}), "DELETE")
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        current = api.request(api.v2, missing=True)
        if current is None:
            return
        assert_owner(current, owner, uid, v2=True)
        time.sleep(2)
    raise SmokeError("Temporary service deletion has not completed")


def run(args):
    api = RunApi(args)
    if api.get() is not None:
        raise SmokeError("engram-isolation-check already exists; refusing to create, change or delete it")
    private_preflight(args)
    owner, uid = uuid.uuid4().hex, None
    attempted = False
    try:
        attempted = True
        created = api.request(api.v1, "POST", service_body(args, owner))
        uid = assert_owner(created, owner)
        url = ready_url(api, owner, uid, args.timeout)
        if invoke(url)[0] not in (401, 403):
            raise SmokeError("Temporary service did not enforce private invocation")
        identity = cloud(args, ["auth", "print-identity-token"])
        if not identity:
            raise SmokeError("An existing gcloud invocation identity is required")
        status, body = invoke(url, identity)
        if status != 200 or body != {"ok": True}:
            raise SmokeError("Authenticated actual-image preflight smoke failed")
    finally:
        # Also handles an unknown create outcome. Ownership is established from
        # the random label before deletion; an existing/concurrent service stays.
        if attempted:
            cleanup(api, owner, uid)
    return {"ok": True, "service": SERVICE, "deleted": True, "image": args.image}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", default="us-central1")
    parser.add_argument("--image", required=True)
    parser.add_argument("--service-account", help="Existing same-project service account; defaults to engram-runtime")
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--run", action="store_true", help="Explicitly create, verify and remove the private temporary service")
    args = parser.parse_args(argv)
    validate(args)
    if not args.run:
        result = {"mode": "plan", "service": SERVICE, "project": args.project, "region": args.region,
            "private": True, "secrets": [], "iamChanges": [], "productionWrites": False,
            "cleanup": "Only our ownership label and UID, with a v2 etag precondition", "serviceBody": service_body(args, "plan-only")}
    else:
        result = run(args)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (SmokeError, KeyboardInterrupt) as error:
        # Exception causes and cloud response bodies can contain credentials.
        print(json.dumps({"ok": False, "error": str(error) if isinstance(error, SmokeError) else "Interrupted; temporary service cleanup was attempted"}), file=sys.stderr)
        sys.exit(1)
