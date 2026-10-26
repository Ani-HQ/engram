'use strict';

// Setup plans all destinations before it changes any of them. A failed commit
// restores files we wrote, without overwriting a concurrent user edit.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function snapshot(file, noLinks) {
  noLinks(file);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Setup requires regular configuration files owned by your user.');
    return { content: fs.readFileSync(fd), mode: stat.mode & 0o777, ino: stat.ino, dev: stat.dev };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function unchanged(actual, expected) {
  return actual === null ? expected === null : expected !== null && actual.ino === expected.ino && actual.dev === expected.dev && actual.content.equals(expected.content) && actual.mode === expected.mode;
}
function planWrites(writes, helpers) {
  const seen = new Set();
  return writes.map(write => {
    const file = path.resolve(write.file);
    if (seen.has(file)) throw new Error('Setup produced conflicting configuration plans. No files were changed.');
    seen.add(file);
    const content = Buffer.from(write.kind === 'json' ? JSON.stringify(write.value, null, 2) + '\n' : write.value);
    const before = snapshot(file, helpers.noLinks);
    return { ...write, file, content, before };
  });
}
function commitWrites(plan, helpers, dependencies = {}) {
  const changed = [], backups = [], createdDirectories = [];
  function parentDirectory(file) {
    const dir = path.dirname(file), missing = [];
    let current = dir;
    while (!fs.existsSync(current)) { missing.push(current); current = path.dirname(current); }
    helpers.noLinks(file);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Setup configuration directories must belong to your user.');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    createdDirectories.push(...missing.reverse());
  }
  function atomic(file, content, mode = 0o600) {
    helpers.noLinks(file);
    const temp = `${file}.engram-${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, content, { flag: 'wx', mode }); fs.renameSync(temp, file); }
    finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  try {
    for (const item of plan) if (!unchanged(snapshot(item.file, helpers.noLinks), item.before)) throw new Error('Configuration changed while setup was checking access. Run setup again; no files were changed.');
    for (const item of plan) {
      if (item.before?.content.equals(item.content) && item.before.mode === 0o600) continue;
      parentDirectory(item.file);
      if (!unchanged(snapshot(item.file, helpers.noLinks), item.before)) throw new Error('Configuration changed during setup.');
      if (item.before) {
        const backup = `${item.file}.engram-backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
        fs.writeFileSync(backup, item.before.content, { flag: 'wx', mode: 0o600 }); backups.push(backup);
      }
      dependencies.beforeWrite?.(item, changed.length);
      atomic(item.file, item.content);
      changed.push(item);
    }
    return { changed: changed.map(item => item.file), backups };
  } catch (error) {
    let recoveryIncomplete = false;
    for (const item of changed.reverse()) {
      try {
        const actual = snapshot(item.file, helpers.noLinks);
        if (!actual?.content.equals(item.content)) { recoveryIncomplete = true; continue; }
        if (item.before) atomic(item.file, item.before.content, item.before.mode);
        else fs.unlinkSync(item.file);
      } catch { recoveryIncomplete = true; }
    }
    for (const dir of [...new Set(createdDirectories)].reverse()) { try { fs.rmdirSync(dir); } catch { /* An existing or now nonempty directory is preserved. */ } }
    throw new Error(recoveryIncomplete ? 'Setup did not finish and a concurrently changed file could not be restored. Existing backups are preserved; run setup again after reviewing that configuration.' : 'Setup did not finish. Configuration files were restored; existing backups are preserved. ' + error.message);
  }
}

function runtimePayload(options, helpers) {
  const source = options.source || __dirname;
  const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const files = ['package.json', ...metadata.files.filter(file => file.endsWith('.js') || file.endsWith('/SKILL.md'))];
  const entries = files.map(file => {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('Invalid managed runtime file list.');
    const target = path.join(source, file);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('The connector package contains an invalid runtime file.');
    return { file, content: fs.readFileSync(target) };
  });
  const digest = createHash('sha256').update(entries.map(entry => entry.file + '\n' + createHash('sha256').update(entry.content).digest('hex')).join('\n')).digest('hex').slice(0, 20);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)) throw new Error('Invalid connector package version.');
  const root = path.join(options.dataHome || path.join(options.home, '.local', 'share'), 'engram-mcp', 'runtimes', `${metadata.version}-${digest}`);
  helpers.noLinks(root);
  return { root, entrypoint: path.join(root, 'index.js'), pluginModule: path.join(root, 'runtime-plugins.js'), writes: entries.map(entry => ({ file: path.join(root, entry.file), kind: 'text', value: entry.content })) };
}

module.exports = { planWrites, commitWrites, runtimePayload };
