"""Exercise the hidden terminal prompt with a fake gcloud, never a real key."""
import errno
import json
import os
from pathlib import Path
import pty
import select
import signal
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).parents[1] / "deploy/set-jev-key.sh"
SAMPLE = "test-only-dummy-provider-key"


def run(existing=False, value=SAMPLE, project="ani-hq", clipboard=False, clipboard_error=False, confirmation=""):
    with tempfile.TemporaryDirectory(prefix="engram-jev-secret-test-") as directory:
        root = Path(directory)
        log = root / "operations.jsonl"
        fake = root / "gcloud"
        fake.write_text(f"#!{sys.executable}\n" + '''import json,os,sys
args=sys.argv[1:]
if args[:2]==['secrets','describe']:
    raise SystemExit(0 if os.environ['FIXTURE_EXISTS']=='1' else 1)
raw=sys.stdin.buffer.read()
with open(os.environ['FIXTURE_LOG'],'a') as output:
    output.write(json.dumps({'args':args,'stdinMatched':raw.decode()==os.environ['FIXTURE_VALUE']})+'\\n')
''')
        fake.chmod(0o700)
        # This fake clipboard supplies dummy text. Never inspect the user's
        # actual macOS clipboard while testing the setup command.
        clipboard_tool = root / "pbpaste"
        clipboard_tool.write_text(f"#!{sys.executable}\nimport os,sys\nif os.environ['FIXTURE_CLIPBOARD_ERROR']=='1':\n sys.stderr.write('private-clipboard-error')\n raise SystemExit(1)\nsys.stdout.write(os.environ['FIXTURE_VALUE'])\n")
        clipboard_tool.chmod(0o700)
        # Substitute only the pinned executable path in an isolated test copy.
        # The production helper always uses macOS's real /usr/bin/pbpaste.
        script = root / "set-jev-key.sh"
        script.write_text(SCRIPT.read_text().replace("/usr/bin/pbpaste", str(clipboard_tool)))
        env = {**os.environ, "PATH": f"{directory}:/usr/bin:/bin", "FIXTURE_EXISTS": "1" if existing else "0", "FIXTURE_LOG": str(log), "FIXTURE_VALUE": value, "FIXTURE_CLIPBOARD_ERROR": "1" if clipboard_error else "0"}
        pid, terminal = pty.fork()
        if pid == 0:
            os.execve("/bin/bash", ["bash", str(script), *(["--clipboard"] if clipboard else []), project], env)
        output, submitted = b"", False
        deadline = time.monotonic() + 8
        code = None
        try:
            while time.monotonic() < deadline:
                if select.select([terminal], [], [], .1)[0]:
                    try:
                        chunk = os.read(terminal, 8192)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    if not chunk:
                        break
                    output += chunk
                    prompt = b"do not paste it" if clipboard else b"input is hidden"
                    if prompt in output and not submitted:
                        os.write(terminal, (confirmation.encode() if clipboard else value.encode()) + b"\n")
                        submitted = True
                finished, status = os.waitpid(pid, os.WNOHANG)
                if finished:
                    code = os.waitstatus_to_exitcode(status)
                    break
            if code is None:
                finished, status = os.waitpid(pid, os.WNOHANG)
                if not finished:
                    os.kill(pid, signal.SIGKILL)
                    _, status = os.waitpid(pid, 0)
                code = os.waitstatus_to_exitcode(status)
        finally:
            os.close(terminal)
        operations = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return code, output.decode(), operations


class HiddenKeySetupTests(unittest.TestCase):
    def test_create_and_version_use_stdin_without_terminal_or_argv_disclosure(self):
        for existing in (False, True):
            code, output, operations = run(existing)
            self.assertEqual(code, 0, output)
            self.assertNotIn(SAMPLE, output)
            self.assertEqual(len(operations), 1)
            args = operations[0]["args"]
            self.assertEqual(args[:3], ["secrets", "versions", "add"] if existing else ["secrets", "create", "engram-jev-api-key"])
            self.assertNotIn(SAMPLE, " ".join(args))
            self.assertIn("--data-file=-", args)
            self.assertIn("--no-log-http", args)
            self.assertTrue(operations[0]["stdinMatched"])

    def test_invalid_input_never_reaches_secret_manager(self):
        for value, project in (("", "ani-hq"), ("key with spaces", "ani-hq"), (SAMPLE, "wrong/project")):
            code, _, operations = run(value=value, project=project)
            self.assertEqual(code, 64)
            self.assertEqual(operations, [])

    def test_clipboard_mode_waits_for_return_and_never_requires_key_paste(self):
        for existing in (False, True):
            code, output, operations = run(existing=existing, clipboard=True)
            self.assertEqual(code, 0, output)
            self.assertIn("Copy only your Jev API key now", output)
            self.assertNotIn(SAMPLE, output)
            self.assertEqual(len(operations), 1)
            self.assertTrue(operations[0]["stdinMatched"])
            self.assertNotIn(SAMPLE, " ".join(operations[0]["args"]))

    def test_invalid_clipboard_contents_never_reach_secret_manager(self):
        for value in ("", "unset", "bash command copied instead", "key\nsecond-line"):
            code, output, operations = run(value=value, clipboard=True)
            self.assertEqual(code, 64, output)
            self.assertEqual(operations, [])

    def test_clipboard_failure_and_accidental_paste_are_private_and_make_no_writes(self):
        for options, expected in (({"clipboard_error": True}, 1), ({"confirmation": SAMPLE}, 64)):
            code, output, operations = run(clipboard=True, **options)
            self.assertEqual(code, expected, output)
            self.assertEqual(operations, [])
            self.assertNotIn(SAMPLE, output)
            self.assertNotIn("private-clipboard-error", output)


if __name__ == "__main__":
    unittest.main()
