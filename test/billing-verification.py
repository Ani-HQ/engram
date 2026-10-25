"""Offline verification-helper checks. No cloud credentials or network."""
import contextlib
import copy
import hashlib
import hmac
import importlib.util
import io
import json
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("verify_billing", pathlib.Path(__file__).parents[1] / "deploy/verify-billing.py")
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)
ORIGIN = "https://engram.example.test"


def fixtures():
    return {
        "account": {"id": "acct_fixture", "charges_enabled": True},
        "prices/price_fixture": {"id": "price_fixture", "active": True, "livemode": False, "currency": "usd", "unit_amount": 1900, "type": "recurring", "product": "engram_cloud_workspace", "recurring": {"interval": "month", "interval_count": 1, "usage_type": "licensed"}},
        "products/engram_cloud_workspace": {"active": True, "livemode": False, "metadata": {"app": "engram"}},
        "billing_portal/configurations/bpc_fixture": {"id": "bpc_fixture", "active": True, "livemode": False, "metadata": {"app": "engram"}, "default_return_url": ORIGIN + "/app#billing", "features": {"subscription_cancel": {"enabled": True, "mode": "at_period_end"}, "invoice_history": {"enabled": True}, "payment_method_update": {"enabled": True}, "customer_update": {"enabled": True}, "subscription_update": {"enabled": False}}},
        "webhook_endpoints?limit=100": {"data": [{"id": "we_fixture", "url": ORIGIN + "/api/billing/webhook", "status": "enabled", "livemode": False, "metadata": {"app": "engram"}, "api_version": verify.VERSION, "enabled_events": sorted(verify.EVENTS)}], "has_more": False},
    }


def check(data):
    calls = []
    def get(path):
        calls.append(path)
        return copy.deepcopy(data[path])
    return verify.configuration_checks(get, ORIGIN, "acct_fixture", "test", "price_fixture", "bpc_fixture"), calls


class BillingVerificationTests(unittest.TestCase):
    def test_configuration_uses_only_expected_reads_and_reports_no_secret_values(self):
        report, calls = check(fixtures())
        self.assertEqual(calls, ["account", "prices/price_fixture", "products/engram_cloud_workspace", "billing_portal/configurations/bpc_fixture", "webhook_endpoints?limit=100"])
        self.assertTrue(report["priceMatchesUsd19Monthly"])
        self.assertEqual(report["chargesCreated"], 0)
        self.assertFalse(report["paymentRoundtripVerified"])
        for value in ("acct_fixture", "price_fixture", "bpc_fixture", "we_fixture"):
            self.assertNotIn(value, json.dumps(report))

    def test_wrong_merchant_price_portal_and_webhook_fail_closed(self):
        bad = fixtures(); bad["account"]["id"] = "acct_other"
        with self.assertRaisesRegex(verify.VerificationError, "merchant"): check(bad)
        bad = fixtures(); bad["prices/price_fixture"]["unit_amount"] = 19000
        with self.assertRaisesRegex(verify.VerificationError, "amount"): check(bad)
        bad = fixtures(); bad["billing_portal/configurations/bpc_fixture"]["default_return_url"] = "https://other.example.test"
        with self.assertRaisesRegex(verify.VerificationError, "return URL"): check(bad)
        bad = fixtures(); bad["webhook_endpoints?limit=100"]["data"][0]["enabled_events"].append("*")
        with self.assertRaisesRegex(verify.VerificationError, "event subscription"): check(bad)
        bad = fixtures(); bad["webhook_endpoints?limit=100"]["data"] *= 2
        with self.assertRaisesRegex(verify.VerificationError, "exactly one"): check(bad)

    def test_subscription_webhook_requires_draft_invoice_delivery_for_jev_usage(self):
        data = fixtures()
        data["webhook_endpoints?limit=100"]["data"][0]["enabled_events"].remove("invoice.created")
        with self.assertRaisesRegex(verify.VerificationError, "event subscription"):
            check(data)

    def test_probe_exercises_raw_bytes_but_never_a_handled_billing_event(self):
        secret = "whsec_offline-only-fixture"
        calls = []
        def endpoint(url, headers, body):
            calls.append((url, headers, body))
            self.assertEqual(url, ORIGIN + "/api/billing/webhook")
            event = json.loads(body)
            self.assertNotIn(event["type"], verify.EVENTS)
            self.assertEqual(event["data"]["object"], {})
            self.assertFalse(event["livemode"])
            signature = headers.get("Stripe-Signature", "")
            if not signature:
                return 400, None
            timestamp, actual = signature.split(",")
            wanted = hmac.new(secret.encode(), timestamp[2:].encode() + b"." + body, hashlib.sha256).hexdigest()
            return (200, {"received": True}) if actual[3:] == wanted else (400, None)
        with patch.object(verify, "http_json", side_effect=endpoint):
            report = verify.probe_webhook(ORIGIN, secret, False)
        self.assertEqual(len(calls), 3)
        self.assertTrue(report["changedBodyRejected"])
        self.assertFalse(report["stripeDeliveryVerified"])

    def test_default_main_reads_secrets_in_memory_without_posting_or_printing_them(self):
        values = {"engram-stripe-secret-key": "sk_test_fixture", "engram-stripe-cloud-monthly-price-id": "price_fixture", "engram-stripe-portal-configuration-id": "bpc_fixture", "engram-stripe-webhook-secret": "whsec_fixture"}
        data = fixtures()
        output = io.StringIO()
        with patch.object(verify, "read_secret", side_effect=lambda project, name: values[name]), patch.object(verify.StripeReader, "get", side_effect=lambda path: copy.deepcopy(data[path])), patch.object(verify, "probe_webhook", side_effect=AssertionError("Default must not POST")), patch("sys.argv", ["verify-billing.py", "--project", "engram-test", "--public-url", ORIGIN, "--expected-account", "acct_fixture", "--expected-mode", "test"]), contextlib.redirect_stdout(output):
            verify.main()
        self.assertEqual(json.loads(output.getvalue())["webhookProbe"], {"run": False})
        for value in values.values():
            self.assertNotIn(value, output.getvalue())

    def test_transport_failure_never_echoes_sensitive_provider_output(self):
        with patch.object(verify.urllib.request, "build_opener", side_effect=RuntimeError("sk_test_private-response-sentinel")), self.assertRaises(verify.VerificationError) as error:
            verify.http_json("https://api.stripe.com/v1/account", {"Authorization": "Bearer sk_test_secret"})
        self.assertNotIn("sk_test_", str(error.exception))
        for origin in ("http://example.test", "https://user:secret@example.test", "https://example.test/path", "https://example.test?query=1"):
            with self.assertRaises(verify.VerificationError): verify.canonical_origin(origin)


if __name__ == "__main__":
    unittest.main()
