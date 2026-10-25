"""Offline provider preflight tests; no credential, network or inference."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("jev_setup", Path(__file__).parents[1] / "deploy/configure-jev.py")
jev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jev)


class JevConfigurationTests(unittest.TestCase):
    def test_model_check_only_reads_pinned_official_endpoint_without_redirects(self):
        requests = []
        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                return io.BytesIO(json.dumps({"models": [{"name": "jev-1.13.0"}]}).encode())
        jev.verify_provider("dummy-private-key", "jev-1.13.0", Opener())
        self.assertEqual(requests[0].full_url, "https://api.typesafe.ai/v1/models")
        self.assertEqual(requests[0].get_method(), "GET")
        self.assertEqual(requests[0].get_header("Authorization"), "Bearer dummy-private-key")
        self.assertIsNone(requests[0].data)
        self.assertIsNone(jev.NoRedirect().redirect_request(None, None, 302, None, {}, "https://untrusted.example"))

    def test_invalid_key_never_reaches_provider(self):
        class Opener:
            def open(self, *args, **kwargs):
                raise AssertionError("No request permitted")
        for key in ("", "unset", "key\ninvalid", "key invalid"):
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                jev.verify_provider(key, "jev-1.13.0", Opener())

    def test_stable_alias_matches_real_catalogue_without_inventing_an_exact_version(self):
        class Opener:
            def open(self, *args, **kwargs):
                return io.BytesIO(b'{"models":[{"name":"jev-latest"},{"name":"jev-preview"}]}')
        jev.verify_provider("dummy-private-key", "jev-latest", Opener())
        with self.assertRaisesRegex(RuntimeError, "selected Jev model is unavailable"):
            jev.verify_provider("dummy-private-key", "jev-1.13.0", Opener())
        with patch("sys.argv", ["configure-jev.py", "check", "--project", "ani-hq", "--model", "jev-preview"]), \
                patch.object(jev, "cloud", side_effect=AssertionError("No cloud access")), self.assertRaises(RuntimeError):
            jev.main()

    def test_missing_model_oversized_or_private_errors_fail_without_leaks(self):
        class Opener:
            def __init__(self, data): self.data = data
            def open(self, *args, **kwargs):
                if isinstance(self.data, Exception): raise self.data
                return io.BytesIO(self.data)
        for data in (b'{}', b'{"models":[{"name":"jev-1"}]}', b'x' * 131073, RuntimeError("dummy-private-key")):
            with self.assertRaises(RuntimeError) as error:
                jev.verify_provider("dummy-private-key", "jev-1.13.0", Opener(data))
            self.assertNotIn("dummy-private-key", str(error.exception))

    def test_plan_is_offline_and_check_does_not_change_iam(self):
        with patch("sys.argv", ["configure-jev.py", "plan", "--project", "ani-hq"]), \
                patch.object(jev, "cloud", side_effect=AssertionError("Offline plan")), contextlib.redirect_stdout(io.StringIO()):
            jev.main()
        operations = []
        def cloud(args, command):
            operations.append(command)
            return b'{"state":"ENABLED"}' if "describe" in command else b'dummy-private-key'
        with patch("sys.argv", ["configure-jev.py", "check", "--project", "ani-hq"]), \
                patch.object(jev, "cloud", side_effect=cloud), patch.object(jev, "verify_provider") as provider, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            jev.main()
        provider.assert_called_once_with("dummy-private-key", "jev-latest")
        self.assertFalse(any("add-iam-policy-binding" in command for command in operations))
        self.assertNotIn("dummy-private-key", output.getvalue())


if __name__ == "__main__":
    unittest.main()
