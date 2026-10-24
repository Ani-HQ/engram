#!/usr/bin/env python3
"""Provision Engram-only Stripe objects and Secret Manager bindings. No charges.

Defaults to read-only account inspection. Use --apply, and --allow-live only when
the merchant explicitly authorizes live configuration. Secret values are kept in
memory and sent to gcloud over stdin; neither provider errors nor keys are logged.
"""
import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

VERSION = "2026-09-30.endive"
EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--source-secret", default="STRIPE_SECRET_KEY")
    parser.add_argument("--public-url", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--allow-live", action="store_true")
    args = parser.parse_args()
    origin = args.public_url.rstrip("/")
    url = urllib.parse.urlsplit(origin)
    if url.scheme != "https" or not url.netloc or url.username or url.password or url.path or url.query or url.fragment:
        raise RuntimeError("Provide a canonical HTTPS origin")

    def cloud(arguments, value=None, optional=False):
        result = subprocess.run(["gcloud", *arguments, "--project", args.project, "--quiet"], input=value, capture_output=True)
        if result.returncode and not optional:
            raise RuntimeError("Secret Manager operation failed; inspect IAM without printing secret values")
        return result.stdout if result.returncode == 0 else None

    key = cloud(["secrets", "versions", "access", "latest", "--secret", args.source_secret]).decode().strip()
    mode = "test" if key.startswith(("sk_test_", "rk_test_")) else "live" if key.startswith(("sk_live_", "rk_live_")) else "unknown"

    def stripe(path, parameters=None, idem=None):
        headers = {"Authorization": "Bearer " + key, "Stripe-Version": VERSION}
        if idem:
            headers["Idempotency-Key"] = idem
        data = None
        if parameters is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            data = urllib.parse.urlencode(parameters, doseq=True).encode()
        request = urllib.request.Request("https://api.stripe.com/v1/" + path, headers=headers, data=data)
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            # Error bodies may contain a request, key or signing secret.
            raise RuntimeError("Stripe operation failed: HTTP " + str(error.code)) from None

    def persist(name, value):
        existing = cloud(["secrets", "versions", "access", "latest", "--secret", name], optional=True)
        if existing != value.encode():
            if cloud(["secrets", "describe", name], optional=True) is None:
                cloud(["secrets", "create", name, "--replication-policy=automatic", "--labels=app=engram,purpose=billing"])
            cloud(["secrets", "versions", "add", name, "--data-file=-"], value.encode())
        cloud(["secrets", "add-iam-policy-binding", name, "--member=serviceAccount:engram-runtime@" + args.project + ".iam.gserviceaccount.com", "--role=roles/secretmanager.secretAccessor"])

    account = stripe("account")
    report = {"mode": mode, "account": account["id"], "businessName": account.get("business_profile", {}).get("name"), "chargesEnabled": account.get("charges_enabled"), "applied": False}
    if not args.apply:
        print(json.dumps(report))
        return
    if mode == "unknown" or mode == "live" and not args.allow_live:
        raise RuntimeError("Live configuration requires explicit --allow-live authorization")

    # A stable object ID and lookup key make retries independent of local files.
    products = stripe("products?" + urllib.parse.urlencode({"limit": 100, "active": "true"}))
    product = next((item for item in products["data"] if item["id"] == "engram_cloud_workspace"), None)
    if product is None:
        product = stripe("products", {"id": "engram_cloud_workspace", "name": "Engram Cloud", "description": "One hosted Engram workspace, billed monthly.", "metadata[app]": "engram", "metadata[plan]": "cloud"}, "engram-cloud-product-v1")
    if product.get("metadata", {}).get("app") != "engram":
        raise RuntimeError("Existing product identity is not owned by Engram")
    prices = stripe("prices?" + urllib.parse.urlencode({"lookup_keys[]": "engram_cloud_usd_monthly_v1", "limit": 10}))
    price = prices["data"][0] if prices["data"] else stripe("prices", {"product": product["id"], "currency": "usd", "unit_amount": 1900, "recurring[interval]": "month", "lookup_key": "engram_cloud_usd_monthly_v1", "metadata[app]": "engram", "metadata[plan]": "cloud"}, "engram-cloud-price-usd-month-v1")
    if not price.get("active") or price.get("currency") != "usd" or price.get("unit_amount") != 1900 or price.get("product") != product["id"] or price.get("recurring", {}).get("interval") != "month" or price.get("recurring", {}).get("interval_count") != 1:
        raise RuntimeError("Existing price does not match the published Engram plan")
    persist("engram-stripe-secret-key", key)
    persist("engram-stripe-cloud-monthly-price-id", price["id"])

    configs = stripe("billing_portal/configurations?limit=100")
    portal = next((item for item in configs["data"] if item.get("metadata", {}).get("app") == "engram" and item.get("active")), None)
    if portal is None:
        portal = stripe("billing_portal/configurations", {"name": "Engram workspace billing", "metadata[app]": "engram", "default_return_url": origin + "/app#billing", "business_profile[headline]": "Manage your Engram workspace", "features[customer_update][enabled]": "true", "features[customer_update][allowed_updates][]": ["email", "name", "address", "tax_id"], "features[invoice_history][enabled]": "true", "features[payment_method_update][enabled]": "true", "features[subscription_cancel][enabled]": "true", "features[subscription_cancel][mode]": "at_period_end", "features[subscription_cancel][proration_behavior]": "none", "features[subscription_update][enabled]": "false"}, "engram-billing-portal-v1")
    persist("engram-stripe-portal-configuration-id", portal["id"])

    endpoint_url = origin + "/api/billing/webhook"
    hooks = stripe("webhook_endpoints?limit=100")
    hook = next((item for item in hooks["data"] if item.get("url") == endpoint_url and item.get("metadata", {}).get("app") == "engram"), None)
    signing = cloud(["secrets", "versions", "access", "latest", "--secret", "engram-stripe-webhook-secret"], optional=True)
    if hook is None or signing is None:
        # Retrying the same key recovers an unknown creation result, including its
        # one-time signing secret, while Stripe's idempotency record is retained.
        hook = stripe("webhook_endpoints", {"url": endpoint_url, "api_version": VERSION, "enabled_events[]": EVENTS, "description": "Engram workspace subscription lifecycle", "metadata[app]": "engram"}, "engram-billing-webhook-v1")
        if not hook.get("secret"):
            raise RuntimeError("Webhook signing secret unavailable; configure a safe rotation in Stripe")
        persist("engram-stripe-webhook-secret", hook["secret"])
    if hook.get("status") != "enabled" or hook.get("api_version") != VERSION or set(hook.get("enabled_events", [])) != set(EVENTS):
        raise RuntimeError("Engram webhook settings do not match the server contract")
    report.update({"applied": True, "product": product["id"], "price": price["id"], "portalConfiguration": portal["id"], "webhook": hook["id"], "webhookURL": endpoint_url, "apiVersion": VERSION, "chargesCreated": 0, "testPaymentVerified": False, "secrets": ["engram-stripe-secret-key", "engram-stripe-cloud-monthly-price-id", "engram-stripe-portal-configuration-id", "engram-stripe-webhook-secret"]})
    print(json.dumps(report))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else "Billing setup failed without exposing credentials", file=sys.stderr)
        sys.exit(1)
