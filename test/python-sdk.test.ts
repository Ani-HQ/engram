import { expect, test } from 'bun:test';
import path from 'node:path';

test('the Python memory SDK passes its actual-HTTP and framework conformance suite', async () => {
  const child = Bun.spawn(['python3', '-m', 'unittest', 'discover', '-s', 'sdks/python/tests', '-v'], {
    cwd: process.cwd(), env: { ...process.env, PYTHONPATH: path.join(process.cwd(), 'sdks/python'), PYTHONDONTWRITEBYTECODE: '1' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 18_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stdout.write(stderr);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stderr).toMatch(/Ran \d+ tests/);
    expect(stderr).toContain('OK');
  } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } }
}, 20_000);
