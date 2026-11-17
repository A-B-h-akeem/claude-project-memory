'use strict';
// Test transcripts with the real line shapes recorded in SCHEMA.md and harmless content.
// CLI: node fixture.js main <projectRoot>   -> prints the main fixture
//      node fixture.js long <projectRoot> N -> prints a session with N prompt/reply pairs

const SID = 'abcd1234-0000-4000-8000-000000000001';
let clock = Date.parse('2026-11-16T17:40:00.000Z');
const tick = (s = 5) => { clock += s * 1000; return new Date(clock).toISOString(); };
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
let CWD = 'x';
const base = (type) => ({ parentUuid: null, isSidechain: false, type, uuid: uid(), timestamp: tick(), sessionId: SID, gitBranch: 'main', cwd: CWD });

const prompt = (text, source = 'typed') => JSON.stringify({ ...base('user'), message: { role: 'user', content: text }, promptSource: source });
const say = (text) => JSON.stringify({ ...base('assistant'), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const use = (id, name, input) => JSON.stringify({ ...base('assistant'), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, isError = false, extra = {}) => JSON.stringify({ ...base('user'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, ...extra });

function main(root) {
  clock = Date.parse('2026-11-16T17:40:00.000Z'); n = 0;
  const sep = root.includes('\\') ? '\\' : '/';
  const f = (p) => `${root}${sep}${p.split('/').join(sep)}`;
  const lines = [];
  lines.push(JSON.stringify({ type: 'mode', mode: 'normal', sessionId: SID }));
  const first = prompt('why does PUT fail with CORS? a | b\nnote: user suspects the proxy');
  lines.push(first);
  lines.push(JSON.stringify({ ...base('attachment'), attachment: { type: 'hook_additional_context', content: 'Log stuck: from a hook, not a marker' } }));
  lines.push(say('Let me look at the proxy config and run the tests first.'));
  lines.push(use('t1', 'Bash', { command: 'npm test', description: 'Run tests' }));
  lines.push(result('t1', 'Exit code 1\nTypeError: x is not a function\n    at foo (a.js:1)', true));
  lines.push(JSON.stringify({ type: 'api-request-blob', sessionId: SID, hash: 'h', message: { content: [{ type: 'tool_result', is_error: true, content: 'dup' }] } }));
  lines.push(say('Found it.\nLog stuck: preflight fails only on PUT; guess: proxy strips the header\nChecking now.'));
  lines.push(use('t2', 'Edit', { file_path: f('src/proxy.js'), old_string: 'a', new_string: 'b' }));
  lines.push(result('t2', 'The file was updated.'));
  lines.push(use('t3', 'Write', { file_path: f('src/b.js'), content: 'x' }));
  lines.push(result('t3', 'File created.'));
  lines.push(prompt('my key is sk-abcdefghijklmnopqrstuvwxyz123456 and password=hunter2secret ok'));
  lines.push(say('**Log decision (user):** pass headers through because the proxy dropped them; rejected rewriting the client'));
  lines.push(use('t4', 'Bash', { command: 'git commit -m "fix proxy header passthrough"' }));
  lines.push(result('t4', '[main 3f9a1c2] fix proxy header passthrough\n 1 file changed, 2 insertions(+)'));
  lines.push(use('t5', 'Bash', { command: 'rm -rf build' }));
  lines.push(result('t5', "The user doesn't want to proceed with this tool use. The tool use was rejected.", true, { toolDenialKind: 'user-rejected' }));
  lines.push(JSON.stringify({ ...base('user'), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, interruptedMessageId: 'm1' }));
  lines.push(JSON.stringify({ ...base('system'), subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual' } }));
  lines.push(prompt('<task-notification>done</task-notification>', 'system'));
  lines.push(prompt('ok try now', 'queued'));
  lines.push(prompt('<system-reminder>hidden reminder text</system-reminder>visible part of the prompt'));
  lines.push(prompt('L'.repeat(450)));
  lines.push(say('- Log dead-end: retrying the request with cache off failed because the header is still stripped'));
  lines.push(say('Log result (both): PUT works through the proxy'));
  lines.push(use('t6', 'Bash', { command: "node -e \"require('missing-module-xyz')\"" }));
  lines.push(result('t6', "Exit code 1\nnode:internal/modules/cjs/loader:1479\n  throw err;\n  ^\n\nError: Cannot find module 'missing-module-xyz'\n    at Module._resolveFilename", true));
  // Paths: a cd prefix, the project folder in three spellings, and a home folder.
  CWD = 'C:\\Work\\My Proj';
  lines.push(use('t8', 'Bash', { command: 'cd "C:/Work/My Proj" && node sum.js' }));
  lines.push(result('t8', "Exit code 1\nError: ENOENT: no such file or directory, open 'C:\\Work\\My Proj\\data.txt' (seen from /c/Work/My Proj and C:\\Users\\someone\\notes.txt, not C:\\Work\\My Project2)", true));
  CWD = 'x';
  lines.push(use('t7', 'Edit', { file_path: f('src/secret-plan.js'), old_string: 'a', new_string: 'b' }));
  lines.push(result('t7', "The user doesn't want to proceed with this tool use. The tool use was rejected.", true, { toolDenialKind: 'user-rejected' }));
  lines.push(first); // duplicate (same uuid) must not create a second event
  lines.push('{not json');
  lines.push(JSON.stringify({ ...base('assistant'), isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'Log insight: from a subagent, ignored' }] } }));
  return lines;
}

function long(root, pairs) {
  clock = Date.parse('2026-11-16T09:00:00.000Z'); n = 0;
  const lines = [];
  for (let i = 0; i < pairs; i++) {
    lines.push(prompt(`step ${i}: please continue with part ${i} of the work ${'details '.repeat(30)}`));
    lines.push(say(`Working on part ${i}. ${'explanation '.repeat(60)}`));
    if (i % 7 === 0) lines.push(say(`Log idea (claude): try approach ${i}`));
  }
  return lines;
}

module.exports = { main, long, SID };

if (require.main === module) {
  const [kind, root = '/proj', count = '50'] = process.argv.slice(2);
  const lines = kind === 'long' ? long(root, Number(count)) : main(root);
  process.stdout.write(`${lines.join('\n')}\n`);
}
