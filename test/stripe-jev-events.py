"""Offline upgrade proof for an existing dedicated webhook; no Stripe calls."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("stripe_setup", Path(__file__).parents[1] / "deploy/configure-stripe.py")
stripe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stripe)
URL = "https://engram.example.test/api/billing/webhook"


class StripeJevEventsTests(unittest.TestCase):
    def setUp(self):
        self.hook = {"id": "we_fixture", "url": URL, "metadata": {"app": "engram"}, "status": "enabled",
            "api_version": stripe.VERSION, "livemode": False, "enabled_events": [event for event in stripe.EVENTS if event != "invoice.created"]}

    def test_upgrade_only_changes_events_on_exact_existing_hook(self):
        updated = {**self.hook, "enabled_events": stripe.EVENTS}
        operation = Mock(return_value=updated)
        result = stripe.upgrade_invoice_events(self.hook, URL, "test", operation)
        self.assertEqual(result["id"], self.hook["id"])
        operation.assert_called_once_with("webhook_endpoints/we_fixture", {"enabled_events[]": stripe.EVENTS}, "engram-jev-events-v2-we_fixture")
        operation.reset_mock()
        self.assertEqual(stripe.upgrade_invoice_events(updated, URL, "test", operation), updated)
        operation.assert_not_called()

    def test_unknown_or_wrong_account_contract_never_mutates(self):
        for patch in ({"livemode": True}, {"url": "https://other.example/webhook"}, {"metadata": {}}, {"status": "disabled"}, {"api_version": "wrong"}, {"enabled_events": ["*"]}):
            hook = copy.deepcopy(self.hook); hook.update(patch)
            operation = Mock()
            with self.assertRaises(RuntimeError): stripe.upgrade_invoice_events(hook, URL, "test", operation)
            operation.assert_not_called()


if __name__ == "__main__": unittest.main()
