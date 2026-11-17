'use strict';
// rlog.js tests T17–T24 (build spec §16). Run: node --test tests/rlog.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const fixture = require('./fixture');

const RLOG = path.join(__dirname, '..', 'bin', 'rlog.js');
const RAW = 'abcd1234-0000-4000-8000-000000000001.jsonl';

// On Windows a bare "bash" resolves to System32\bash.exe (WSL) before PATH; hooks run in Git Bash.
const BASH = process.platform === 'win32'
  ? [process.env.RL_BASH, 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find((p) => p && fs.existsSync(p)) || 'bash'
  : 'bash';
function hasBash() {
  try { execFileSync(BASH, ['-c', 'exit 0']); return true; } catch (e) { return false; }
}

function project(lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl proj '));
  const R = path.join(root, '.research-log');
  for (const d of ['raw', 'journal', 'documentary', 'state']) fs.mkdirSync(path.join(R, d), { recursive: true });
  fs.writeFileSync(path.join(R, 'raw', RAW), `${(lines || fixture.main(root)).join('\n')}\n`);
  return { root, R };
}
function rlog(root, ...args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [RLOG, ...args, '--root', root], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout) };
  }
}
function rlogIn(cwd, env, ...args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [RLOG, ...args], { encoding: 'utf8', cwd, env: { ...process.env, ...env } }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout) };
  }
}
const journalFile = (R) => path.join(R, 'journal', fs.readdirSync(path.join(R, 'journal'))[0]);
const read = (f) => fs.readFileSync(f, 'utf8');

test('T17 journal has every event kind in the contract format', () => {
  const { root, R } = project();
  assert.strictEqual(rlog(root, 'extract').code, 0);
  const files = fs.readdirSync(path.join(R, 'journal'));
  assert.deepStrictEqual(files, ['2026-11-16_1740_abcd1234.md']);
  const j = read(journalFile(R));
  const rows = j.split('\n');
  assert.match(rows[0], /^# Session abcd1234 · 2026-11-16 17:40 UTC · branch main$/);
  const has = (re) => assert.ok(rows.some((r) => re.test(r)), `missing ${re}`);
  has(/^\d\d:\d\d:\d\d \| prompt \| user \| why does PUT fail with CORS\? a ¦ b note: user suspects the proxy \| L2$/);
  has(/\| note \| user \| user suspects the proxy \| L2$/);
  has(/\| fail \| - \| Bash: npm test -> exit 1: TypeError: x is not a function \| L6$/);
  has(/\| stuck \| claude \| preflight fails only on PUT; guess: proxy strips the header \| L8$/);
  has(/\| edit \| - \| 2 files: src\/proxy\.js, src\/b\.js \| L12$/);
  has(/\| fail \| - \| Bash: node -e "require\('missing-module-xyz'\)" -> exit 1: Error: Cannot find module 'missing-module-xyz' \|/);
  has(/\| reject \| user \| Edit: src\/secret-plan\.js \|/);
  has(/\| fail \| - \| Bash: node sum\.js -> exit 1: Error: ENOENT: no such file or directory, open 'data\.txt' \(seen from \. and ~\\notes\.txt, not C:\\Work\\My Project2\) \|/);
  assert.ok(!j.includes('someone'), 'home folder name removed');
  const { parseRaw } = require(RLOG);
  const heredoc = [
    JSON.stringify({ type: 'assistant', uuid: 'h1', timestamp: '2026-11-16T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'h', name: 'Bash', input: { command: "python - <<'EOF'\nimport x\nprint(1)\nEOF" } }] } }),
    JSON.stringify({ type: 'user', uuid: 'h2', timestamp: '2026-11-16T10:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 'h', is_error: true, content: "Exit code 1\nModuleNotFoundError: No module named 'x'" }] } }),
  ];
  const hp = project(heredoc);
  const ev = parseRaw(require(RLOG).layout(hp.root), RAW).events.find((e) => e.kind === 'fail');
  assert.strictEqual(ev.text, "Bash: python - <<'EOF' …(+3 lines) -> exit 1: ModuleNotFoundError: No module named 'x'");
  assert.ok(!rows.some((r) => /\| edit \|.*secret-plan/.test(r)), 'rejected edit is not an edit');
  has(/\| decision \| user \| pass headers through because the proxy dropped them; rejected rewriting the client \|/);
  has(/\| commit \| - \| 3f9a1c2 fix proxy header passthrough \|/);
  has(/\| reject \| user \| Bash: rm -rf build \|/);
  has(/\| interrupt \| user \| interrupted \|/);
  has(/\| compact \| - \| context compacted \|/);
  has(/\| prompt \| user \| ok try now \|/);
  has(/\| prompt \| user \| visible part of the prompt \|/);
  has(/\| prompt \| user \| L{400}…\(\+50 chars\) \|/);
  has(/\| dead-end \| claude \| retrying the request with cache off failed because the header is still stripped \|/);
  has(/\| result \| both \| PUT works through the proxy \|/);
  assert.ok(!j.includes('task-notification'), 'system-sourced prompt excluded');
  assert.ok(!j.includes('hidden reminder'), 'system reminders stripped');
  assert.ok(!j.includes('from a hook'), 'attachment lines ignored');
  assert.ok(!j.includes('from a subagent'), 'sidechain ignored');
  assert.match(rows[rows.length - 2], /^<!-- events:\d+ skipped:1 raw:\d+ -->$/);
  assert.ok(fs.existsSync(path.join(R, 'TIMELINE.md')));
});

test('T18 extract is deterministic and rebuildable', () => {
  const { root, R } = project();
  rlog(root, 'extract');
  const a = read(journalFile(R));
  const generated = ['TIMELINE.md', 'INDEX.md', 'STATS.md'].map((f) => read(path.join(R, f)));
  rlog(root, 'extract');
  assert.strictEqual(read(journalFile(R)), a);
  fs.rmSync(path.join(R, 'journal'), { recursive: true });
  ['TIMELINE.md', 'INDEX.md', 'STATS.md'].forEach((f) => fs.rmSync(path.join(R, f)));
  fs.readdirSync(path.join(R, 'state')).filter((f) => f.endsWith('.xsize')).forEach((f) => fs.rmSync(path.join(R, 'state', f)));
  rlog(root, 'extract');
  assert.strictEqual(read(journalFile(R)), a);
  assert.deepStrictEqual(['TIMELINE.md', 'INDEX.md', 'STATS.md'].map((f) => read(path.join(R, f))), generated);
});

test('T19 corrupt and duplicated lines', () => {
  const lines = fixture.main('/p');
  const { root, R } = project([...lines, ...lines.slice(1, 10)]);
  rlog(root, 'extract');
  const j = read(journalFile(R));
  assert.match(j, /skipped:1 /);
  assert.strictEqual((j.match(/why does PUT fail/g) || []).length, 1);
  assert.strictEqual((j.match(/\| fail \| - \| Bash: npm test/g) || []).length, 1);
});

test('T20 secrets never leave raw/', () => {
  const { root, R } = project();
  rlog(root, 'extract');
  const j = read(journalFile(R));
  assert.ok(!j.includes('sk-abcdefghij') && !j.includes('hunter2secret'));
  assert.match(j, /\[REDACTED:api-key\]/);
  assert.match(j, /password=\[REDACTED:credential\]/);
  const out = rlog(root, 'digest', '2026-11-16_1740_abcd1234').out.trim();
  const d = read(out);
  assert.ok(!d.includes('sk-abcdefghij') && !d.includes('hunter2secret'));
  const ex = rlog(root, 'export', '--with-raw').out;
  assert.match(ex, /api-key \d+/);
  assert.match(ex, /credential \d+/);
  const dest = ex.trim().split('\n').pop();
  for (const f of fs.readdirSync(path.join(dest, 'raw'))) {
    const t = read(path.join(dest, 'raw', f));
    assert.ok(!t.includes('sk-abcdefghij') && !t.includes('hunter2secret'));
  }
  const { redact } = require(RLOG);
  const samples = ['AKIA1234567890ABCDEF', `ghp_${'a'.repeat(36)}`, 'xoxb-1234567890-abc', `AIza${'b'.repeat(35)}`,
    'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q', '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    `github_pat_${'c'.repeat(50)}`, 'token: abcdef123'];
  for (const s of samples) assert.match(redact(s), /^(token: )?\[REDACTED:[a-z-]+\]$/, s);
});

test('T21 digest respects the budget and is deterministic', () => {
  const { root, R } = project(fixture.long('/p', 200));
  rlog(root, 'extract');
  const name = fs.readdirSync(path.join(R, 'journal'))[0].replace(/\.md$/, '');
  const f = rlog(root, 'digest', name, '--budget', '2000').out.trim();
  const a = read(f);
  assert.ok(a.length <= 8000, `digest is ${a.length} chars`);
  assert.match(a.split('\n')[0], /^<!-- raw:\d+ session:abcd1234 -->$/);
  rlog(root, 'digest', name, '--budget', '2000');
  assert.strictEqual(read(f), a);
  const big = read(rlog(root, 'digest', name, '--budget', '100000').out.trim());
  assert.match(big, / U: step 0: please continue/);
  assert.match(big, / L: idea \(claude\): try approach 0/);
});

test('T22 check-chapter rejects invented quotes and a wrong first line', () => {
  const { root, R } = project();
  const digest = read(rlog(root, 'digest', '2026-11-16_1740_abcd1234').out.trim());
  const first = digest.split('\n')[0];
  const ch = path.join(R, 'documentary', '2026-11-16_1740_abcd1234.md');
  fs.writeFileSync(ch, `${first}\n# t\nThe user said "this sentence was never said by anyone".\n`);
  assert.strictEqual(rlog(root, 'check-chapter', ch).code, 1);
  fs.writeFileSync(ch, `<!-- raw:1 session:x -->\n# t\n`);
  assert.strictEqual(rlog(root, 'check-chapter', ch).code, 1);
  fs.writeFileSync(ch, `${first}\n# t\nWe saw "preflight fails only on PUT" and "PUT works through the proxy".\n`);
  const ok = rlog(root, 'check-chapter', ch);
  assert.strictEqual(ok.code, 0, ok.out);
  rlog(root, 'stitch');
  assert.match(read(path.join(R, 'DOCUMENTARY.md')), /## Contents\n- \[t\]\(documentary\/2026-11-16_1740_abcd1234\.md\)/);
});

test('T23 build-list picks missing and stale chapters only', () => {
  const { root, R } = project();
  const one = fixture.long('/p', 1); // a 1-prompt session in a second raw file
  fs.writeFileSync(path.join(R, 'raw', 'ffff0000-1.jsonl'), `${one.map((l) => l.replace(/abcd1234-0000/g, 'ffff0000-0000')).join('\n')}\n`);
  let out = rlog(root, 'build-list').out.trim().split('\n').filter(Boolean);
  assert.strictEqual(out.length, 1, out.join('\n'));
  const [dg, ch] = out[0].split('\t');
  fs.writeFileSync(ch, read(dg).split('\n')[0] + '\n# t\n');
  assert.strictEqual(rlog(root, 'build-list').out.trim(), '', 'up to date');
  fs.appendFileSync(path.join(R, 'raw', RAW), `${fixture.long('/p', 1)[0]}\n`);
  out = rlog(root, 'build-list').out.trim().split('\n').filter(Boolean);
  assert.strictEqual(out.length, 1, 'stale chapter listed');
});

test('multi-day session gets day lines; named error beats a throw line', () => {
  const line = (ts, extra) => JSON.stringify({ parentUuid: null, isSidechain: false, uuid: ts, timestamp: ts, sessionId: 'abcd1234-x', ...extra });
  const prompt = (ts, text) => line(ts, { type: 'user', message: { role: 'user', content: text }, promptSource: 'typed' });
  const { root, R } = project([
    prompt('2026-11-16T23:50:00.000Z', 'first day'),
    line('2026-11-16T23:51:00.000Z', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'node x.js' } }] } }),
    line('2026-11-16T23:52:00.000Z', { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: 'Exit code 1\nx.js:3\n    throw new Error(message);\n    ^\n\nTypeError: boom is not defined\n    at main (x.js:3)' }] } }),
    prompt('2026-11-17T00:10:00.000Z', 'second day'),
    prompt('2026-11-19T08:00:00.000Z', 'third day'),
  ]);
  rlog(root, 'extract');
  const rows = read(journalFile(R)).split('\n');
  assert.deepStrictEqual(rows.filter((r) => r.startsWith('---')), ['--- 2026-11-17 ---', '--- 2026-11-19 ---']);
  assert.ok(rows.indexOf('--- 2026-11-17 ---') < rows.findIndex((r) => r.includes('second day')));
  assert.ok(rows.some((r) => /\| fail \| - \| Bash: node x\.js -> exit 1: TypeError: boom is not defined \|/.test(r)), rows.join('\n'));
  const name = fs.readdirSync(path.join(R, 'journal'))[0].replace(/\.md$/, '');
  assert.match(read(rlog(root, 'digest', name).out.trim()), /\n--- 2026-11-17 ---\n00:10:00 U: second day/);
  assert.strictEqual(rlog(root, 'verify').code, 0);
});

test('B index groups every log line by kind with links', () => {
  const { root, R } = project();
  rlog(root, 'extract');
  const idx = read(path.join(R, 'INDEX.md'));
  const link = '[2026-11-16_1740_abcd1234](journal/2026-11-16_1740_abcd1234.md)';
  assert.match(idx, /1 decisions · 1 stuck points · 0 ideas · 1 dead ends · 1 results · 0 insights · 1 your notes/);
  assert.ok(idx.includes(`(user) pass headers through because the proxy dropped them; rejected rewriting the client · ${link}`), idx);
  assert.match(idx, /## Stuck points\n\n- 2026-11-16 17:40 \(claude\) preflight fails only on PUT; guess: proxy strips the header → next result after (<1 min|\d+ min) ·/);
  assert.match(idx, /## Ideas\n\nnone/);
  assert.match(idx, /## Your notes\n\n- 2026-11-16 \d\d:\d\d user suspects the proxy ·/);
  assert.match(rlog(root, 'index').out, /1 decisions/);
  // This session has log lines, so a chapter must not add duplicates.
  fs.writeFileSync(path.join(R, 'documentary', '2026-11-16_1740_abcd1234.md'), '<!-- x -->\n# t\n## Decisions\n- duplicate decision\n');
  rlog(root, 'stitch');
  assert.ok(!read(path.join(R, 'INDEX.md')).includes('duplicate decision'));
});

test('B sessions without log lines are filled in from their chapter', () => {
  const line = (ts, extra) => JSON.stringify({ parentUuid: null, isSidechain: false, uuid: ts, timestamp: ts, sessionId: 'bbbb0000-x', ...extra });
  const { root, R } = project([line('2026-11-10T09:00:00.000Z', { type: 'user', message: { role: 'user', content: 'old work' }, promptSource: 'typed' })]);
  rlog(root, 'extract');
  const name = fs.readdirSync(path.join(R, 'journal'))[0].replace(/\.md$/, '');
  fs.writeFileSync(path.join(R, 'documentary', `${name}.md`), [
    '<!-- raw:1 session:bbbb0000 -->', '# 2026-11-10 — Old work', '**Goal:** g.', '## What happened', '- 09:00 something',
    '## Stuck points', '- The build hung on step 3; unresolved at end of session.', '## Ideas and who proposed them', '- Cache the step (user).',
    '## Decisions', 'Use SQLite because it needs no server; rejected Postgres.', '## Dead ends', 'none', '## Results', '- none', '## Open at the end', '- x',
  ].join('\n'));
  rlog(root, 'stitch');
  const idx = read(path.join(R, 'INDEX.md'));
  const link = `[${name}](documentary/${name}.md)`;
  assert.ok(idx.includes(`## Decisions\n\n- 2026-11-10 (from chapter) Use SQLite because it needs no server; rejected Postgres. · ${link}`), idx);
  assert.ok(idx.includes('- 2026-11-10 (from chapter) The build hung on step 3; unresolved at end of session.'));
  assert.ok(idx.includes('- 2026-11-10 (from chapter) Cache the step (user).'));
  assert.match(idx, /## Dead ends\n\nnone/);
  assert.match(idx, /## Results\n\nnone/);
  assert.ok(!idx.includes('something'), 'What happened is not indexed');
  rlog(root, 'extract');
  assert.ok(read(path.join(R, 'INDEX.md')).includes('Use SQLite'), 'extract keeps chapter entries');
});

test('C stats measure attribution, oversight, stuck points, failures and edits', () => {
  const { root, R } = project();
  rlog(root, 'extract');
  const st = read(path.join(R, 'STATS.md'));
  const row = (a, b) => assert.ok(st.includes(`| ${a} | ${b} |`), `missing | ${a} | ${b} |\n${st}`);
  row('Sessions', '1 (2026-11-16 to 2026-11-16, 1 active days)');
  row('Prompts', 5);
  row('Commits', 1);
  row('Decisions', '1 | 0 | 0');
  row('Notes', '1 | - | -');
  row('Rejected tool calls', 2);
  row('Interruptions', 1);
  row('Context compactions', 1);
  row('Stuck points', 1);
  row('Followed by a result in the same session', 1);
  assert.match(st, /3 failed tool calls: Bash 3\./);
  row('ENOENT', 1); row('TypeError', 1); row('Error', 1);
  row('src/proxy.js', 1);
  assert.match(st, /## Per session\n\n\| Session \| Active/);
  const cli = rlog(root, 'stats').out;
  assert.match(cli, /## Overview/);
  assert.ok(!cli.includes('## Per session'), 'CLI summary leaves out the per-session table');
  const { errorType } = require(RLOG);
  assert.strictEqual(errorType('Bash: x -> exit 2: /usr/bin/bash: line 3: syntax'), 'exit 2');
  assert.strictEqual(errorType('Read: a -> EISDIR: illegal operation'), 'EISDIR');
});

test('A import copies past transcripts, sets offsets, skips logged ones, is idempotent', () => {
  const { root, R } = project([]);
  fs.rmSync(path.join(R, 'raw', RAW));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'rl transcripts '));
  const lines = fixture.main(root);
  fs.writeFileSync(path.join(src, 'aaaa.jsonl'), `${lines.join('\n')}\n`);
  const partial = `${lines.slice(0, 6).join('\n')}\n{"partial":`;
  fs.writeFileSync(path.join(src, 'bbbb.jsonl'), partial.replace(/abcd1234-0000/g, 'bbbb0000-0000'));
  fs.writeFileSync(path.join(src, 'cccc.jsonl'), `${lines[1]}\n`);
  fs.writeFileSync(path.join(R, 'state', 'cccc.jsonl.off'), '10\n'); // already mirrored by the hooks
  const dry = rlog(root, 'import', '--from', src, '--dry-run');
  assert.match(dry.out, /Would import 2 session\(s\)/);
  assert.deepStrictEqual(fs.readdirSync(path.join(R, 'raw')), []);
  const out = rlog(root, 'import', '--from', src);
  assert.match(out.out, /Imported 2 session\(s\), [\d.]+ MB, from .*; 1 already logged\./);
  assert.strictEqual(read(path.join(R, 'raw', 'aaaa.jsonl')), read(path.join(src, 'aaaa.jsonl')));
  const b = read(path.join(R, 'raw', 'bbbb.jsonl'));
  assert.ok(b.endsWith('\n') && !b.includes('partial'), 'only complete lines imported');
  assert.strictEqual(read(path.join(R, 'state', 'bbbb.jsonl.off')).trim(), String(Buffer.byteLength(b)));
  assert.strictEqual(fs.readdirSync(path.join(R, 'journal')).length, 2);
  assert.match(rlog(root, 'import', '--from', src).out, /Imported 0 session\(s\).*3 already logged/);
  assert.strictEqual(rlog(root, 'verify').code, 0);
});

test('A import finds the transcript folder itself and works before the first session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl fresh '));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'rl cfg '));
  const dir = path.join(cfg, 'projects', path.resolve(root).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dddd.jsonl'), `${fixture.main(root).join('\n')}\n`);
  const out = rlogIn(root, { CLAUDE_CONFIG_DIR: cfg }, 'import');
  assert.strictEqual(out.code, 0, out.out);
  assert.match(out.out, /Imported 1 session\(s\)/);
  assert.ok(fs.existsSync(path.join(root, '.research-log', '.gitignore')), 'folder created with templates');
  assert.ok(fs.existsSync(path.join(root, '.research-log', 'INDEX.md')));
  // Fallback: an unexpected folder name is found through the cwd recorded in the transcript.
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rl fresh2 '));
  const odd = path.join(cfg, 'projects', 'shortened-name-1234');
  fs.mkdirSync(odd);
  fs.writeFileSync(path.join(odd, 'eeee.jsonl'), `${JSON.stringify({ type: 'user', cwd: root2, uuid: 'u', timestamp: '2026-11-16T10:00:00Z', message: { content: 'hi' }, promptSource: 'typed' })}\n`);
  assert.match(rlogIn(root2, { CLAUDE_CONFIG_DIR: cfg }, 'import').out, /Imported 1 session\(s\)/);
  const home = rlogIn(os.homedir(), { CLAUDE_CONFIG_DIR: cfg }, 'import', '--root', os.homedir());
  assert.strictEqual(home.code, 1);
});

test('A after import, the hooks continue from the imported offset without duplicates', { skip: !hasBash() }, () => {
  const { root, R } = project([]);
  fs.rmSync(path.join(R, 'raw', RAW));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'rl live '));
  const t = path.join(src, 'ffff.jsonl');
  const lines = fixture.main(root);
  fs.writeFileSync(t, `${lines.slice(0, 10).join('\n')}\n`);
  rlog(root, 'import', '--from', src);
  fs.appendFileSync(t, `${lines.slice(10, 20).join('\n')}\n`); // the session is resumed and grows
  const hook = path.join(__dirname, '..', 'hooks', 'hook.sh');
  execFileSync(BASH, [hook, 'stop'], { input: JSON.stringify({ session_id: 'ffff', transcript_path: t }), env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  assert.strictEqual(read(path.join(R, 'raw', 'ffff.jsonl')), read(t));
});

test('T24 verify', () => {
  const { root, R } = project();
  rlog(root, 'extract');
  const v = rlog(root, 'verify');
  assert.strictEqual(v.code, 0, v.out);
  const rawFile = path.join(R, 'raw', RAW);
  const full = read(rawFile);
  fs.writeFileSync(rawFile, full.slice(0, -5));
  assert.strictEqual(rlog(root, 'verify').code, 1);
  fs.writeFileSync(rawFile, full);
  fs.rmSync(journalFile(R));
  assert.strictEqual(rlog(root, 'verify').code, 1);
});
