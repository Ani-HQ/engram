#!/usr/bin/env python3
"""Read-only Stripe configuration checks; optionally probe an ignored webhook.

Never creates customers, Checkout/Portal sessions, subscriptions or payments.
Secret Manager values remain in memory and are never printed or written to disk.
The optional synthetic event is intentionally outside the billing event types,
so Engram validates its signature and responds before accessing billing storage.
"""
import argparse
import hashlib
import hmac
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

VERSION = "2026-09-30.endive"
EVENTS = {"checkout.session.completed", "checkout.session.async_payment_succeeded", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"}
PROBE_TYPE = "engram.configuration_probe"
SECRETS = {
    "key": "engram-stripe-secret-key",
    "price": "engram-stripe-cloud-monthly-price-id",
    "portal": "engram-stripe-portal-configuration-id",
    "webhook": "engram-stripe-webhook-secret",
}


class VerificationError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def canonical_origin(value):
    value = value.rstrip("/")
    url = urllib.parse.urlsplit(value)
    require(url.scheme == "https" and url.hostname and not url.username and not url.password and not url.path and not url.query and not url.fragment, "Provide a canonical HTTPS origin")
    return value


def read_secret(project, name):
    try:
        result = subprocess.run(["gcloud", "secrets", "versions", "access", "latest", "--secret", name, "--project", project, "--quiet"], stdin=subprocess.DEVNULL, capture_output=True, timeout=45)
    except (OSError, subprocess.TimeoutExpired):
        raise VerificationError("Secret Manager was unavailable or timed out; no values were logged") from None
    require(result.returncode == 0, "Could not read a dedicated Engram billing secret; inspect authentication and scoped IAM")
    return result.stdout.decode("utf-8").strip()


def http_json(url, headers, body=None):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    request = urllib.request.Request(url, headers={"User-Agent": "EngramReleaseVerifier/1.0", **headers}, data=body, method="GET" if body is None else "POST")
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=25) as response:
            raw = response.read(1_000_001)
            require(len(raw) <= 1_000_000, "Verification response exceeded its size limit")
            return response.status, json.loads(raw)
    except urllib.error.HTTPError as error:
        # Provider error bodies may echo a request. Never print or parse them.
        with error:
            return error.code, None
    except VerificationError:
        raise
    except Exception:
        raise VerificationError("Verification request failed without exposing its credentials or response") from None


class StripeReader:
    def __init__(self, key):
        self.headers = {"Authorization": "Bearer " + key, "Stripe-Version": VERSION, "Accept": "application/json"}

    def get(self, path):
        status, value = http_json("https://api.stripe.com/v1/" + path, self.headers)
        require(status == 200 and isinstance(value, dict), "Stripe read failed; verify key permissions and configured object identities")
        return value


def configuration_checks(get, origin, expected_account, mode, price_id, portal_id):
    live = mode == "live"
    account = get("account")
    require(account.get("id") == expected_account, "Stripe account does not match the explicitly selected merchant")
    require(not live or account.get("charges_enabled") is True, "The live merchant account is not enabled to accept charges")

    price = get("prices/" + price_id)
    require(price.get("id") == price_id and price.get("livemode") is live and price.get("active") is True and price.get("currency") == "usd" and price.get("unit_amount") == 1900 and price.get("type") == "recurring" and price.get("product") == "engram_cloud_workspace", "Stripe price identity, mode, amount or product does not match Engram Cloud")
    recurring = price.get("recurring", {})
    require(recurring.get("interval") == "month" and recurring.get("interval_count") == 1 and recurring.get("usage_type") == "licensed", "Stripe price does not match the monthly workspace plan")
    product = get("products/engram_cloud_workspace")
    require(product.get("active") is True and product.get("livemode") is live and product.get("metadata", {}).get("app") == "engram", "Stripe product is not the active Engram product in the selected mode")

    portal = get("billing_portal/configurations/" + portal_id)
    require(portal.get("id") == portal_id and portal.get("active") is True and portal.get("livemode") is live and portal.get("metadata", {}).get("app") == "engram" and portal.get("default_return_url") == origin + "/app#billing", "Stripe Portal identity, mode or canonical return URL does not match Engram")
    features = portal.get("features", {})
    cancel = features.get("subscription_cancel", {})
    require(cancel.get("enabled") is True and cancel.get("mode") == "at_period_end" and all(features.get(name, {}).get("enabled") is True for name in ("invoice_history", "payment_method_update", "customer_update")) and features.get("subscription_update", {}).get("enabled") is False, "Stripe Portal lacks the reviewed payment recovery and cancellation configuration")

    matching = []
    after = ""
    for _ in range(10):
        page = get("webhook_endpoints?" + urllib.parse.urlencode({"limit": 100, **({"starting_after": after} if after else {})}))
        require(isinstance(page.get("data"), list), "Stripe returned an invalid webhook list")
        matching.extend(item for item in page["data"] if item.get("url") == origin + "/api/billing/webhook" and item.get("metadata", {}).get("app") == "engram" and item.get("status") == "enabled")
        if not page.get("has_more"):
            break
        after = page["data"][-1].get("id", "") if page["data"] else ""
        require(re.fullmatch(r"we_[A-Za-z0-9]+", after), "Stripe webhook pagination was invalid")
    else:
        raise VerificationError("Stripe webhook list exceeded the bounded verification limit")
    require(len(matching) == 1, "Expected exactly one enabled Engram webhook at the canonical URL")
    hook = matching[0]
    require(hook.get("livemode") is live and hook.get("api_version") == VERSION and set(hook.get("enabled_events", [])) == EVENTS, "Stripe webhook mode, API version or event subscription differs from the server")
    return {"accountMatches": True, "chargesEnabled": account.get("charges_enabled") is True, "priceMatchesUsd19Monthly": True, "portalMatches": True, "webhookMatches": True, "mode": mode, "apiVersion": VERSION, "chargesCreated": 0, "paymentRoundtripVerified": False}


def probe_webhook(origin, secret, live):
    require(PROBE_TYPE not in EVENTS, "Probe event must remain outside the billing lifecycle")
    body = json.dumps({"id": "evt_engram_config_" + uuid.uuid4().hex, "type": PROBE_TYPE, "livemode": live, "data": {"object": {}}}, separators=(",", ":")).encode()
    timestamp = str(int(time.time()))
    signature = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    headers = {"Content-Type": "application/json", "Stripe-Signature": "t=" + timestamp + ",v1=" + signature}
    endpoint = origin + "/api/billing/webhook"
    status, response = http_json(endpoint, headers, body)
    require(status == 200 and isinstance(response, dict) and response.get("received") is True, "The canonical webhook did not acknowledge a valid ignored event")
    require(http_json(endpoint, {"Content-Type": "application/json"}, body)[0] == 400, "The canonical webhook did not reject a missing signature")
    require(http_json(endpoint, headers, body + b" ")[0] == 400, "The canonical webhook did not reject changed signed bytes")
    return {"validIgnoredEventAccepted": True, "missingSignatureRejected": True, "changedBodyRejected": True, "stripeDeliveryVerified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--public-url", required=True)
    parser.add_argument("--expected-account", required=True)
    parser.add_argument("--expected-mode", choices=("test", "live"), required=True)
    parser.add_argument("--probe-webhook", action="store_true", help="Also POST ignored synthetic events to the configured canonical endpoint; no billing storage or Stripe writes")
    args = parser.parse_args()
    require(re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", args.project) and re.fullmatch(r"acct_[A-Za-z0-9]+", args.expected_account), "Provide explicit valid project and Stripe account identities")
    origin = canonical_origin(args.public_url)
    values = {name: read_secret(args.project, resource) for name, resource in SECRETS.items()}
    match = re.fullmatch(r"(?:sk|rk)_(test|live)_[A-Za-z0-9_]+", values["key"])
    require(match is not None and match.group(1) == args.expected_mode, "Stripe key mode does not match the explicitly selected mode")
    require(re.fullmatch(r"price_[A-Za-z0-9]+", values["price"]) and re.fullmatch(r"bpc_[A-Za-z0-9]+", values["portal"]) and re.fullmatch(r"whsec_[A-Za-z0-9]+", values["webhook"]), "Dedicated billing secret formats are invalid")
    report = configuration_checks(StripeReader(values["key"]).get, origin, args.expected_account, args.expected_mode, values["price"], values["portal"])
    report["webhookProbe"] = probe_webhook(origin, values["webhook"], args.expected_mode == "live") if args.probe_webhook else {"run": False}
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, VerificationError) else "Billing verification failed without exposing credential values", file=sys.stderr)
        sys.exit(1)
