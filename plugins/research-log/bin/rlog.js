#!/usr/bin/env node
'use strict';
// research-log CLI: turns the raw transcript mirror into a journal, digests and a documentary.
// No model calls, no dependencies, Node >= 18. Every file is written to <file>.tmp and renamed.
//
// Commands: extract | status | verify | cost | stats | index | import [--from <dir>] [--dry-run] |
//           digest <journal name> [--budget N] | build-list | check-chapter <chapter.md> | stitch |
//           pause | resume | export [--with-raw]
// Options:  --root <project dir>  (default: nearest folder upwards that contains .research-log)

const fs = require('fs');
const os = require('os');
const path = require('path');

const EXTRACT_VERSION = 5; // bump whenever the journal format or extraction changes: journals regenerate
const PROMPT_SOURCES = new Set(['typed', 'sdk', 'queued', 'suggestion_accepted']);
const MARKER_KINDS = ['stuck', 'idea', 'decision', 'dead-end', 'result', 'insight'];
const MARKER_RE = /^\s*(?:[-*>]\s*)?\**Log (stuck|idea|decision|dead-end|result|insight)(?: \((user|claude|both)\))?:\**\s*(.+)$/i;
const NOTE_RE = /^\s*note:\s*(.+)$/i;
const COMMIT_RE = /^\[\S+[^\]]* ([0-9a-f]{7,})\] (.+)$/m;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const REJECT_PREFIX = "The user doesn't want to proceed";
const INTERRUPT_PREFIX = '[Request interrupted by user';
const MAX_CHAPTER_JOBS = 10;

// §10 redaction. Applied to everything written outside raw/ and state/ (digests in state/ too).
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'private-key'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'jwt'],
  [/sk-[A-Za-z0-9_-]{20,}/g, 'api-key'],
  [/AKIA[0-9A-Z]{16}/g, 'aws'],
  [/github_pat_[A-Za-z0-9_]{50,}/g, 'github'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, 'github'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'slack'],
  [/AIza[0-9A-Za-z_-]{35}/g, 'google'],
];
const CREDENTIAL_RE = /((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)(?!\[REDACTED)\S{6,}/gi;

function redact(s, counts) {
  let out = s;
  for (const [re, label] of PATTERNS) {
    out = out.replace(re, () => { if (counts) counts[label] = (counts[label] || 0) + 1; return `[REDACTED:${label}]`; });
  }
  return out.replace(CREDENTIAL_RE, (m, keep) => { if (counts) counts.credential = (counts.credential || 0) + 1; return `${keep}[REDACTED:credential]`; });
}

// ---------- small helpers ----------
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const trunc = (t, max) => (t.length > max ? `${t.slice(0, max)}…(+${t.length - max} chars)` : t);
const cleanText = (s) => redact(oneLine(s).replace(/\|/g, '¦'));
const hhmmss = (ts) => (ts ? ts.slice(11, 19) : '--:--:--');
const fsize = (f) => { try { return fs.statSync(f).size; } catch (e) { return 0; } };
const exists = (f) => fs.existsSync(f);
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
const stripReminders = (s) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}
function writeIfChanged(file, text) {
  if (exists(file) && readText(file) === text) return false;
  writeAtomic(file, text);
  return true;
}

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n');
  return '';
}

// Reads a file line by line without loading it whole. cb(line, lineNumber).
function forEachLine(file, cb) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let parts = [];
  let no = 0;
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      let start = 0;
      let i;
      while ((i = buf.indexOf(10, start)) !== -1 && i < n) {
        parts.push(Buffer.from(buf.subarray(start, i)));
        cb(Buffer.concat(parts).toString('utf8').replace(/\r$/, ''), ++no);
        parts = [];
        start = i + 1;
      }
      if (start < n) parts.push(Buffer.from(buf.subarray(start, n)));
    }
    if (parts.length) cb(Buffer.concat(parts).toString('utf8').replace(/\r$/, ''), ++no);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- project layout ----------
function findRoot(argRoot) {
  let d = path.resolve(argRoot || process.cwd());
  for (;;) {
    if (exists(path.join(d, '.research-log'))) return d;
    const p = path.dirname(d);
    if (p === d) return null;
    d = p;
  }
}

function layout(root) {
  const R = path.join(root, '.research-log');
  return {
    root, R,
    raw: path.join(R, 'raw'), journal: path.join(R, 'journal'), documentary: path.join(R, 'documentary'),
    state: path.join(R, 'state'), digest: path.join(R, 'state', 'digest'),
    timeline: path.join(R, 'TIMELINE.md'), doc: path.join(R, 'DOCUMENTARY.md'),
    index: path.join(R, 'INDEX.md'), stats: path.join(R, 'STATS.md'),
  };
}

// Raw mirror files: <transcript>.jsonl and rotated <transcript>.jsonl.<epoch>.old
function rawFiles(L) {
  if (!exists(L.raw)) return [];
  return fs.readdirSync(L.raw).filter((f) => /\.jsonl$/.test(f) || /\.jsonl\.\d+\.old$/.test(f)).sort();
}

// ---------- §8 parse one raw file ----------
// Path tidying: project-root paths become relative and home folders become "~", so journal lines
// are short, portable, and do not carry the user's account name into git.
const HOME_RES = [
  /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`<>|]+/g,
  /\/[a-z]\/Users\/[^/\s"'`]+/g,
  /\/(?:home|Users)\/[^/\s"'`]+/g,
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = '[\\\\/]+';

// Matches a folder written as C:\a\b, C:/a/b or /c/a/b (any slash, any case), not a longer name.
function rootRegex(root) {
  const parts = String(root).replace(/[\\/]+$/, '').split(/[\\/]+/);
  if (parts.length < 2 || !parts[parts.length - 1]) return null;
  const forms = [parts.map(escapeRe).join(SEP)];
  const drive = /^([A-Za-z]):$/.exec(parts[0]);
  if (drive) forms.push(SEP + [drive[1], ...parts.slice(1).map(escapeRe)].join(SEP));
  return new RegExp(`(?:${forms.join('|')})(?![A-Za-z0-9._-])(${SEP})?`, 'gi');
}

function makeTidy(projectRoot) {
  const roots = new Map();
  const add = (r) => { if (r && !roots.has(r) && roots.size < 6) { const re = rootRegex(r); if (re) roots.set(r, re); } };
  add(projectRoot);
  const tidy = (s) => {
    let out = String(s);
    for (const re of roots.values()) out = out.replace(re, (m, sep) => (sep ? '' : '.'));
    for (const re of HOME_RES) out = out.replace(re, '~');
    return out;
  };
  tidy.add = add;
  return tidy;
}
// Commands: drop a leading `cd <dir> &&`, keep only the first line of a multi-line command
// (heredoc scripts otherwise flood the journal).
function tidyCommand(s) {
  const t = s.replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '') || s;
  const lines = t.split('\n');
  const first = lines[0].trim();
  return lines.length > 1 ? `${first} …(+${lines.length - 1} lines)` : first;
}

function parseRaw(L, rawName) {
  const file = path.join(L.raw, rawName);
  const seen = new Set();
  const uses = new Map();
  const events = [];
  const items = []; // digest items
  let sid = '';
  let branch = '';
  let firstTs = '';
  let lastTs = '';
  let skipped = 0;
  let prompts = 0;
  let edits = null; // { paths: [], ts, line }
  const tidy = makeTidy(L.root);
  const relPath = (p) => (p ? tidy(p).replace(/\\/g, '/') : '');

  const ev =(ts, kind, who, text, line) => events.push({ ts, kind, who, text, line });
  const dg = (ts, tag, text) => items.push({ ts, tag, text: redact(oneLine(text)) });
  const flushEdits = () => {
    if (!edits || !edits.paths.length) { edits = null; return; }
    const shown = edits.paths.slice(0, 5).join(', ');
    const more = edits.paths.length > 5 ? ` (+${edits.paths.length - 5} more)` : '';
    const text = `${edits.paths.length} ${edits.paths.length === 1 ? 'file' : 'files'}: ${shown}${more}`;
    ev(edits.ts, 'edit', '-', text, edits.line);
    dg(edits.ts, 'E', text);
    edits = null;
  };

  forEachLine(file, (line, no) => {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch (e) { skipped++; return; }
    if (!o || (o.type !== 'user' && o.type !== 'assistant' && o.type !== 'system')) return;
    if (o.uuid) { if (seen.has(o.uuid)) return; seen.add(o.uuid); }
    if (o.isSidechain) return;
    if (o.sessionId) sid = o.sessionId;
    if (o.gitBranch) branch = o.gitBranch;
    const ts = o.timestamp || lastTs;
    if (!ts) return;
    lastTs = ts;
    if (!firstTs) firstTs = ts;
    if (o.cwd) tidy.add(o.cwd);
    const c = o.message && o.message.content;

    if (o.type === 'system') {
      if (o.subtype === 'compact_boundary') { ev(ts, 'compact', '-', 'context compacted', no); dg(ts, 'S', 'context compacted'); }
      return;
    }

    if (o.type === 'assistant') {
      if (!Array.isArray(c)) return;
      for (const x of c) {
        if (!x) continue;
        if (x.type === 'tool_use') {
          uses.set(x.id, x);
        } else if (x.type === 'text' && x.text) {
          const said = tidy(x.text);
          if (said.trim().length >= 20) dg(ts, 'A', said);
          for (const l of said.split('\n')) {
            const m = MARKER_RE.exec(l);
            if (!m) continue;
            const kind = m[1].toLowerCase();
            const who = (m[2] || 'claude').toLowerCase();
            ev(ts, kind, who, trunc(cleanText(m[3]), 300), no);
            dg(ts, 'L', `${kind} (${who}): ${m[3]}`);
          }
        }
      }
      return;
    }

    // user lines
    if (o.promptSource !== undefined && o.promptSource !== null) {
      if (!PROMPT_SOURCES.has(o.promptSource)) return;
      flushEdits();
      const text = tidy(stripReminders(contentText(c))).trim() || '[non-text prompt]';
      prompts++;
      ev(ts, 'prompt', 'user', trunc(cleanText(text), 400), no);
      dg(ts, 'U', text);
      for (const l of text.split('\n')) {
        const m = NOTE_RE.exec(l);
        if (m) ev(ts, 'note', 'user', trunc(cleanText(m[1]), 400), no);
      }
      return;
    }
    const list = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    for (const x of list) {
      if (!x) continue;
      if (x.type === 'text' && typeof x.text === 'string' && x.text.startsWith(INTERRUPT_PREFIX)) {
        ev(ts, 'interrupt', 'user', 'interrupted', no);
        dg(ts, 'U', '[interrupted the assistant]');
      } else if (x.type === 'tool_result') {
        const use = uses.get(x.tool_use_id);
        const tool = (use && use.name) || 'tool';
        const input = (use && use.input) || {};
        const file = input.file_path || input.notebook_path;
        const target = input.command
          ? oneLine(tidyCommand(tidy(input.command)))
          : oneLine((file && relPath(file)) || tidy(input.pattern || input.url || input.description || ''));
        const body = contentText(x.content);
        if (!x.is_error && EDIT_TOOLS.has(tool)) {
          // Only edits that succeeded count; rejected or failed ones appear as reject/fail.
          const p = relPath(file);
          if (!edits) edits = { paths: [], ts, line: no };
          if (p && !edits.paths.includes(p)) edits.paths.push(p);
          edits.ts = ts; edits.line = no;
        }
        if (x.is_error) {
          if (body.startsWith(REJECT_PREFIX) || o.toolDenialKind === 'user-rejected') {
            const text = trunc(cleanText(`${tool}: ${trunc(target, 100)}`), 300);
            ev(ts, 'reject', 'user', text, no);
            dg(ts, 'X', `rejected by user: ${tool}: ${trunc(target, 100)}`);
          } else {
            const lines = body.replace(/<\/?tool_use_error>/g, '').split('\n').map((s) => s.trim()).filter(Boolean);
            const ex = /^Exit code (\d+)$/.exec(lines[0] || '');
            const rest = ex ? lines.slice(1) : lines;
            // The most telling line: the first that names an error, else the first line.
            // "SomeError: message" beats a line that merely mentions an error (e.g. `throw new Error(...)`).
            const named = /^(?:[\w.]+\.)?\w*(?:Error|Exception)\b[^:]{0,60}: \S/;
            const hint = /error|exception|cannot|can't|not found|no such|denied|failed|refused|invalid|undefined/i;
            const noise = /^(?:at |throw |raise |\^|File ")/;
            const telling = rest.find((s) => named.test(s)) || rest.find((s) => hint.test(s) && !noise.test(s)) || rest[0] || 'error';
            const err = tidy(ex ? `exit ${ex[1]}: ${telling}` : telling);
            const text = `${tool}: ${trunc(target, 100)} -> ${trunc(oneLine(err), 160)}`;
            ev(ts, 'fail', '-', trunc(cleanText(text), 300), no);
            dg(ts, 'X', text);
          }
        } else if (tool === 'Bash' && /git commit/.test(input.command || '')) {
          const m = COMMIT_RE.exec(body);
          if (m) { const text = `${m[1]} ${m[2]}`; ev(ts, 'commit', '-', trunc(cleanText(text), 200), no); dg(ts, 'C', text); }
        }
      }
    }
  });
  flushEdits();

  // Off-the-record ranges recorded by the hooks: "<from>\t<to>\t<utc>" per skipped batch.
  const gapsFile = path.join(L.raw, `${rawName.replace(/\.\d+\.old$/, '')}.gaps`);
  if (!/\.old$/.test(rawName) && exists(gapsFile)) {
    const rows = readText(gapsFile).split('\n').map((l) => l.split('\t')).filter((r) => r.length >= 3);
    let cur = null;
    const flush = () => {
      if (!cur) return;
      const text = `off the record until ${hhmmss(cur.until)}`;
      events.push({ ts: cur.ts, kind: 'paused', who: '-', text, line: '-' });
      items.push({ ts: cur.ts, tag: 'S', text });
      cur = null;
    };
    for (const [from, to, at] of rows) {
      if (cur && cur.to === from) { cur.to = to; cur.until = at; } else { flush(); cur = { from, to, ts: at, until: at }; }
    }
    flush();
  }
  const order = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
  const sortStable = (arr) => arr.map((x, i) => [x, i]).sort((a, b) => order(a[0], b[0]) || a[1] - b[1]).map((x) => x[0]);
  return {
    rawName, sid, sid8: (sid || rawName).slice(0, 8), branch, firstTs, skipped, prompts,
    events: sortStable(events), items: sortStable(items), rawSize: fsize(file),
  };
}

// ---------- §9 journal ----------
function journalBaseName(p) {
  const t = p.firstTs;
  return `${t.slice(0, 10)}_${t.slice(11, 13)}${t.slice(14, 16)}_${p.sid8}`;
}

// Adds a "--- YYYY-MM-DD ---" line wherever the date changes, so a session that runs over several
// days stays readable (times alone would appear to jump backwards).
function withDayLines(list, startTs, fmt) {
  let day = startTs.slice(0, 10);
  const out = [];
  for (const x of list) {
    const d = (x.ts || '').slice(0, 10);
    if (d && d !== day) { day = d; out.push(`--- ${d} ---`); }
    out.push(fmt(x));
  }
  return out;
}

function renderJournal(p) {
  const t = p.firstTs;
  const head = `# Session ${p.sid8} · ${t.slice(0, 10)} ${t.slice(11, 16)} UTC · branch ${p.branch || '-'}`;
  const rows = withDayLines(p.events, t, (e) => `${hhmmss(e.ts)} | ${e.kind} | ${e.who} | ${e.text} | L${e.line}`);
  return `${[head, ...rows, `<!-- events:${p.events.length} skipped:${p.skipped} raw:${p.rawSize} -->`].join('\n')}\n`;
}

function gapsSize(L, rawName) {
  return /\.old$/.test(rawName) ? 0 : fsize(path.join(L.raw, `${rawName}.gaps`));
}
function cacheKey(L, rawName) {
  return `${EXTRACT_VERSION} ${fsize(path.join(L.raw, rawName))} ${gapsSize(L, rawName)}`;
}
function readCache(L, rawName) {
  const [key, jname] = readText(path.join(L.state, `${rawName}.xsize`)).trim().split('\t');
  return { key: key || '', jname: jname || '' };
}

// Returns [{rawName, jname, changed}] for every raw file with at least one dated line.
function extract(L, opts = {}) {
  const used = new Set();
  const out = [];
  for (const rawName of rawFiles(L)) {
    const cache = readCache(L, rawName);
    const key = cacheKey(L, rawName);
    if (!opts.force && cache.key === key && cache.jname && exists(path.join(L.journal, `${cache.jname}.md`))) {
      used.add(cache.jname);
      out.push({ rawName, jname: cache.jname, changed: false });
      continue;
    }
    const p = parseRaw(L, rawName);
    if (!p.firstTs) continue;
    let jname = cache.jname && !used.has(cache.jname) ? cache.jname : journalBaseName(p);
    for (let i = 2; used.has(jname); i++) jname = `${journalBaseName(p)}_${i}`;
    used.add(jname);
    const changed = writeIfChanged(path.join(L.journal, `${jname}.md`), renderJournal(p));
    writeAtomic(path.join(L.state, `${rawName}.xsize`), `${key}\t${jname}\n`);
    out.push({ rawName, jname, changed });
  }
  const files = journalFiles(L);
  const timeline = ['# Research timeline', '', ...files.map((f) => readText(path.join(L.journal, f)))].join('\n');
  writeIfChanged(L.timeline, timeline.endsWith('\n') ? timeline : `${timeline}\n`);
  const sessions = readJournals(L, files);
  writeIfChanged(L.index, renderIndex(sessions, readChapters(L)));
  writeIfChanged(L.stats, renderStats(sessions).full);
  return out;
}

function journalFiles(L) {
  return exists(L.journal) ? fs.readdirSync(L.journal).filter((f) => f.endsWith('.md')).sort() : [];
}

// ---------- index and stats: generated from journal/, zero tokens, deterministic ----------
const ROW_RE = /^(\d\d:\d\d:\d\d) \| ([a-z-]+) \| ([a-z-]+) \| (.*) \| L(\d+|-)$/;

// Journal files back into events with full timestamps (header date, then "--- date ---" lines).
function readJournals(L, files) {
  return files.map((f) => {
    const jname = f.replace(/\.md$/, '');
    const events = [];
    let date = '';
    for (const l of readText(path.join(L.journal, f)).split('\n')) {
      let m = /^# Session \S+ · (\d{4}-\d\d-\d\d) /.exec(l);
      if (m) { date = m[1]; continue; }
      m = /^--- (\d{4}-\d\d-\d\d) ---$/.exec(l);
      if (m) { date = m[1]; continue; }
      m = ROW_RE.exec(l);
      if (m && date) events.push({ at: Date.parse(`${date}T${m[1]}Z`), date, time: m[1], kind: m[2], who: m[3], text: m[4] });
    }
    return { jname, events };
  });
}

function fmtDur(ms) {
  if (ms < 60000) return '<1 min';
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const fmtWhen = (e) => `${e.date} ${e.time.slice(0, 5)}`;
const sessionLink = (s) => `[${s.jname}](journal/${s.jname}.md)`;
const countBy = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const topN = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
const mdTable = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)];

// For a stuck line: time until the next result line in the same session, or null.
function timeToResult(s, i) {
  const r = s.events.slice(i + 1).find((x) => x.kind === 'result');
  return r ? r.at - s.events[i].at : null;
}

const INDEX_SECTIONS = [
  ['decision', 'Decisions'], ['stuck', 'Stuck points'], ['idea', 'Ideas'], ['dead-end', 'Dead ends'],
  ['result', 'Results'], ['insight', 'Insights'], ['note', 'Your notes'],
];

// Chapter sections that map onto index kinds (headings fixed by templates/chapter-prompt.md).
const CHAPTER_SECTIONS = {
  'Decisions': 'decision', 'Stuck points': 'stuck', 'Ideas and who proposed them': 'idea', 'Dead ends': 'dead-end', 'Results': 'result',
};

// documentary/<jname>.md -> { jname: { kind: [item, ...] } }; bullets, or plain lines when a part has none.
function readChapters(L) {
  const out = {};
  if (!exists(L.documentary)) return out;
  for (const f of fs.readdirSync(L.documentary).filter((x) => x.endsWith('.md')).sort()) {
    const parts = {};
    let kind = null;
    for (const raw of readText(path.join(L.documentary, f)).split('\n')) {
      const h = /^##\s+(.+?)\s*$/.exec(raw);
      if (h) { kind = CHAPTER_SECTIONS[h[1]] || null; continue; }
      if (/^#\s/.test(raw)) { kind = null; continue; }
      const line = raw.replace(/^\s*[-*]\s+/, '').trim();
      if (!kind || !line || /^none\.?$/i.test(line)) continue;
      (parts[kind] = parts[kind] || []).push(line);
    }
    out[f.replace(/\.md$/, '')] = parts;
  }
  return out;
}

// Log lines come first. Sessions without any log line (from before the plugin, or a model that
// wrote none) are filled in from their documentary chapter, if one has been built.
function renderIndex(sessions, chapters = {}) {
  const by = Object.fromEntries(INDEX_SECTIONS.map(([k]) => [k, []]));
  const fromCh = Object.fromEntries(INDEX_SECTIONS.map(([k]) => [k, []]));
  for (const s of sessions) {
    s.events.forEach((e, i) => { if (by[e.kind]) by[e.kind].push({ s, e, i }); });
    const ch = chapters[s.jname];
    if (ch && !s.events.some((e) => MARKER_KINDS.includes(e.kind))) {
      for (const [k, items] of Object.entries(ch)) items.forEach((text) => fromCh[k].push({ s, text }));
    }
  }
  const counts = INDEX_SECTIONS.map(([k, t]) => `${by[k].length + fromCh[k].length} ${t.toLowerCase()}`).join(' · ');
  const out = ['# Research index', '',
    `Every log line in journal/, grouped by kind; sessions without log lines are filled in from their chapter. Generated; do not edit. ${counts}.`, ''];
  for (const [k, title] of INDEX_SECTIONS) {
    out.push(`## ${title}`, '');
    if (!by[k].length && !fromCh[k].length) { out.push('none', ''); continue; }
    for (const { s, e, i } of by[k]) {
      const who = k === 'note' ? '' : ` (${e.who})`;
      let after = '';
      if (k === 'stuck') { const t = timeToResult(s, i); after = t === null ? ' → no result later in the session' : ` → next result after ${fmtDur(t)}`; }
      out.push(`- ${fmtWhen(e)}${who} ${e.text}${after} · ${sessionLink(s)}`);
    }
    for (const { s, text } of fromCh[k]) {
      out.push(`- ${s.jname.slice(0, 10)} (from chapter) ${text} · [${s.jname}](documentary/${s.jname}.md)`);
    }
    out.push('');
  }
  return `${out.join('\n').trim()}\n`;
}

const ACTIVE_GAP_CAP = 30 * 60 * 1000;
function activeMs(events) {
  let t = 0;
  for (let i = 1; i < events.length; i++) { const d = events[i].at - events[i - 1].at; if (d > 0) t += Math.min(d, ACTIVE_GAP_CAP); }
  return t;
}

// Short error class for a fail line: errno code, else a named error class, else the exit code.
function errorType(text) {
  const after = text.split(' -> ').slice(1).join(' -> ');
  const code = /\b(E[A-Z]{3,})\b/.exec(after);
  if (code) return code[1];
  const cls = /\b([A-Za-z]*(?:Error|Exception))\b/.exec(after);
  if (cls) return cls[1];
  const ex = /^exit (\d+)/.exec(after);
  return ex ? `exit ${ex[1]}` : 'other';
}

function editedFiles(e) {
  return e.text.replace(/^\d+ files?: /, '').replace(/ \(\+\d+ more\)$/, '').split(', ').filter(Boolean);
}

function renderStats(sessions) {
  const all = sessions.flatMap((s) => s.events);
  const kinds = countBy(all, (e) => e.kind);
  const n = (k) => kinds[k] || 0;
  const markers = all.filter((e) => MARKER_KINDS.includes(e.kind));
  const days = [...new Set(all.map((e) => e.date))].sort();
  const files = {};
  all.filter((e) => e.kind === 'edit').forEach((e) => editedFiles(e).forEach((f) => { files[f] = (files[f] || 0) + 1; }));
  const who = (k) => { const c = countBy(all.filter((e) => e.kind === k), (e) => e.who); return [c.user || 0, c.claude || 0, c.both || 0]; };
  const stuck = [];
  sessions.forEach((s) => s.events.forEach((e, i) => { if (e.kind === 'stuck') stuck.push(timeToResult(s, i)); }));
  const solved = stuck.filter((t) => t !== null).sort((a, b) => a - b);
  const fails = all.filter((e) => e.kind === 'fail');
  const list = (obj, k) => topN(obj, k).map(([a, b]) => `${a} ${b}`).join(', ');
  const summary = [
    '# Research stats', '',
    'Generated from journal/; do not edit. Times are UTC. Active time adds up the gaps between events, each capped at 30 min.', '',
    '## Overview', '',
    ...mdTable(['Measure', 'Value'], [
      ['Sessions', `${sessions.length}${days.length ? ` (${days[0]} to ${days[days.length - 1]}, ${days.length} active days)` : ''}`],
      ['Active time', fmtDur(sessions.reduce((t, s) => t + activeMs(s.events), 0))],
      ['Prompts', n('prompt')],
      ['Log lines', markers.length ? `${markers.length} (${list(countBy(markers, (e) => e.kind), 9)})` : 0],
      ['Commits', n('commit')],
      ['Files edited', `${Object.keys(files).length} distinct`],
    ]), '',
    '## Who proposed what', '',
    ...mdTable(['Kind', 'user', 'claude', 'both'], [['Ideas', ...who('idea')], ['Decisions', ...who('decision')], ['Notes', n('note'), '-', '-']]), '',
    '## Human oversight', '',
    ...mdTable(['Measure', 'Count'], [['Rejected tool calls', n('reject')], ['Interruptions', n('interrupt')], ['Context compactions', n('compact')], ['Off-the-record gaps', n('paused')]]), '',
    '## Stuck points', '',
    ...mdTable(['Measure', 'Value'], [
      ['Stuck points', stuck.length],
      ['Followed by a result in the same session', solved.length],
      ['Median time to that result', solved.length ? fmtDur(solved[(solved.length - 1) >> 1]) : '-'],
    ]), '',
    '## Failures', '',
    `${fails.length} failed tool calls${fails.length ? `: ${list(countBy(fails, (e) => e.text.split(':')[0]), 6)}` : ''}.`, '',
    ...(fails.length ? [...mdTable(['Error', 'Count'], topN(countBy(fails, (e) => errorType(e.text)), 10)), ''] : []),
    '## Most edited files', '',
    ...(Object.keys(files).length ? mdTable(['File', 'Turns with edits'], topN(files, 10)) : ['none']), '',
  ];
  const perSession = ['## Per session', '', ...mdTable(['Session', 'Active', 'Prompts', 'Fails', 'Edits', 'Commits', 'Log lines'],
    sessions.map((s) => {
      const c = countBy(s.events, (e) => e.kind);
      return [sessionLink(s), fmtDur(activeMs(s.events)), c.prompt || 0, c.fail || 0, c.edit || 0, c.commit || 0,
        s.events.filter((e) => MARKER_KINDS.includes(e.kind)).length];
    }))];
  return { summary: `${summary.join('\n').trim()}\n`, full: `${[...summary, ...perSession].join('\n').trim()}\n` };
}

// ---------- import: bring in transcripts from before the plugin was installed ----------
function projectsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

function readHead(file, n) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(n); return b.toString('utf8', 0, fs.readSync(fd, b, 0, n, 0)); } finally { fs.closeSync(fd); }
}

// Claude Code keeps a folder's transcripts in projects/<path with every non-alphanumeric char as "-">.
// Long or unusual names may differ, so fall back to a folder whose transcripts record this cwd.
function findTranscriptDir(root) {
  const base = projectsDir();
  if (!exists(base)) return null;
  const dirs = fs.readdirSync(base);
  const want = path.resolve(root).replace(/[^A-Za-z0-9]/g, '-').toLowerCase();
  const hit = dirs.find((d) => d.toLowerCase() === want);
  if (hit) return path.join(base, hit);
  const norm = (p) => path.resolve(p).toLowerCase();
  for (const d of dirs) {
    const dir = path.join(base, d);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (e) { continue; }
    for (const f of files.slice(0, 3)) {
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(readHead(path.join(dir, f), 65536));
      if (!m) continue;
      try { if (norm(JSON.parse(`"${m[1]}"`)) === norm(root)) return dir; } catch (e) { /* ignore */ }
      break;
    }
  }
  return null;
}

// Byte length up to and including the last newline (0 if none): complete lines only.
function completeLength(file) {
  const size = fsize(file);
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(65536);
    for (let end = size; end > 0;) {
      const start = Math.max(0, end - b.length);
      const n = fs.readSync(fd, b, 0, end - start, start);
      const i = b.subarray(0, n).lastIndexOf(10);
      if (i !== -1) return start + i + 1;
      end = start;
    }
    return 0;
  } finally { fs.closeSync(fd); }
}

function importSessions(L, { from, dryRun }) {
  const dir = from ? path.resolve(from) : findTranscriptDir(L.root);
  if (!dir || !exists(dir)) {
    console.log(`No Claude Code transcripts found for ${L.root}${from ? '' : ` (looked in ${projectsDir()})`}.`);
    return 1;
  }
  let imported = 0;
  let skipped = 0;
  let bytes = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
    const src = path.join(dir, f);
    const dst = path.join(L.raw, f);
    const off = path.join(L.state, `${f}.off`);
    // Already mirrored by the hooks (or imported before): leave it to them.
    if (exists(off) || exists(dst)) { skipped++; continue; }
    const end = completeLength(src);
    if (!end) { skipped++; continue; }
    imported++; bytes += end;
    if (dryRun) continue;
    fs.mkdirSync(L.raw, { recursive: true });
    fs.mkdirSync(L.state, { recursive: true });
    fs.copyFileSync(src, `${dst}.tmp`);
    if (fsize(`${dst}.tmp`) > end) fs.truncateSync(`${dst}.tmp`, end);
    fs.renameSync(`${dst}.tmp`, dst);
    writeAtomic(off, `${end}\n`); // if this session is resumed, the hooks continue from here
  }
  const mb = (bytes / 1048576).toFixed(1);
  if (dryRun) {
    console.log(`Would import ${imported} session(s), ${mb} MB, from ${dir}; ${skipped} already logged.`);
    return 0;
  }
  const entries = extract(L);
  console.log(`Imported ${imported} session(s), ${mb} MB, from ${dir}; ${skipped} already logged.`);
  console.log(`Journal now has ${entries.length} session(s). See ${L.index} and ${L.stats}.`);
  return 0;
}

// The folder for `import` in a project where no session has run with the plugin yet.
function initFolder(root) {
  const R = path.join(root, '.research-log');
  for (const d of ['raw', 'journal', 'documentary', 'state']) fs.mkdirSync(path.join(R, d), { recursive: true });
  const tpl = path.join(__dirname, '..', 'templates');
  if (!exists(path.join(R, 'README.md'))) fs.copyFileSync(path.join(tpl, 'README.md'), path.join(R, 'README.md'));
  if (!exists(path.join(R, '.gitignore'))) fs.copyFileSync(path.join(tpl, 'gitignore'), path.join(R, '.gitignore'));
}

// ---------- §12 digest ----------
const DIGEST_LEVELS = [{ U: 500, A: 400 }, { U: 500, A: 200 }, { U: 500, A: 100 }, { U: 200, A: 100 }, { U: 200, A: 0 }];
const OTHER_CAPS = { X: 300, L: 300, E: 300, C: 200, S: 200 };

function renderDigest(p, budgetTokens) {
  const head = `<!-- raw:${p.rawSize} session:${p.sid8} -->`;
  const maxChars = budgetTokens * 4;
  const render = (lvl) => withDayLines(
    p.items.filter((it) => !(it.tag === 'A' && lvl.A === 0)),
    p.firstTs,
    (it) => `${hhmmss(it.ts)} ${it.tag}: ${trunc(it.text, lvl[it.tag] || OTHER_CAPS[it.tag] || 300)}`,
  );
  let lines = [];
  for (const lvl of DIGEST_LEVELS) {
    lines = render(lvl);
    const text = [head, ...lines].join('\n');
    if (text.length <= maxChars) return `${text}\n`;
  }
  // Still too long: keep the start (40%) and the end (60%) of the session.
  const budget = maxChars - head.length - 60;
  const headPart = [];
  const tailPart = [];
  let used = 0;
  for (const l of lines) { if (used + l.length + 1 > budget * 0.4) break; headPart.push(l); used += l.length + 1; }
  for (let i = lines.length - 1; i >= headPart.length; i--) {
    if (used + lines[i].length + 1 > budget) break;
    tailPart.unshift(lines[i]); used += lines[i].length + 1;
  }
  const omitted = lines.length - headPart.length - tailPart.length;
  return `${[head, ...headPart, `… (${omitted} lines omitted) …`, ...tailPart].join('\n')}\n`;
}

function writeDigest(L, rawName, jname, budget) {
  const p = parseRaw(L, rawName);
  const file = path.join(L.digest, `${jname}.txt`);
  writeAtomic(file, renderDigest(p, budget));
  return file;
}

// ---------- §13 documentary ----------
function firstLine(f) { return readText(f).split('\n')[0].trim(); }

function buildList(L) {
  const jobs = [];
  for (const { rawName, jname } of extract(L)) {
    const journal = readText(path.join(L.journal, `${jname}.md`));
    const prompts = (journal.match(/^\d\d:\d\d:\d\d \| prompt \|/gm) || []).length;
    if (prompts < 2) continue;
    const chapter = path.join(L.documentary, `${jname}.md`);
    const size = fsize(path.join(L.raw, rawName));
    const m = /^<!-- raw:(\d+) /.exec(firstLine(chapter));
    if (exists(chapter) && m && Number(m[1]) === size) continue;
    jobs.push({ rawName, jname, chapter });
  }
  jobs.slice(0, MAX_CHAPTER_JOBS).forEach((j) => {
    const digest = writeDigest(L, j.rawName, j.jname, 8000);
    console.log(`${digest}\t${j.chapter}`);
  });
  if (jobs.length > MAX_CHAPTER_JOBS) console.log(`+${jobs.length - MAX_CHAPTER_JOBS} more`);
}

function normalizeQuote(s) { return s.replace(/\s+/g, ' ').trim(); }

function checkChapter(L, chapterArg) {
  const chapter = path.resolve(chapterArg);
  const digestFile = path.join(L.digest, `${path.basename(chapter, '.md')}.txt`);
  const failures = [];
  if (!exists(chapter)) failures.push(`chapter not found: ${chapter}`);
  if (!exists(digestFile)) failures.push(`digest not found: ${digestFile}`);
  if (!failures.length) {
    const text = readText(chapter);
    const digest = normalizeQuote(readText(digestFile));
    if (firstLine(chapter) !== firstLine(digestFile)) failures.push(`first line must be exactly: ${firstLine(digestFile)}`);
    const re = /["“]([^"“”\n]{12,}?)["”]/g;
    let m;
    while ((m = re.exec(text))) {
      if (!digest.includes(normalizeQuote(m[1]))) failures.push(`quote not found in the digest: "${m[1]}"`);
    }
  }
  failures.forEach((f) => console.log(f));
  if (!failures.length) console.log('ok');
  return failures.length ? 1 : 0;
}

function stitch(L) {
  const files = exists(L.documentary) ? fs.readdirSync(L.documentary).filter((f) => f.endsWith('.md')).sort() : [];
  const chapters = files.map((f) => {
    const body = readText(path.join(L.documentary, f)).replace(/^<!--[^\n]*-->\n/, '').trim();
    const title = (body.split('\n').find((l) => l.startsWith('# ')) || `# ${f}`).slice(2).trim();
    return { f, title, body };
  });
  const toc = chapters.map((c) => `- [${c.title}](documentary/${c.f})`);
  const text = ['# Research documentary', '', '## Contents', ...toc, '', ...chapters.map((c) => `${c.body}\n\n---\n`)].join('\n');
  writeIfChanged(L.doc, `${text.trim()}\n`);
  writeIfChanged(L.index, renderIndex(readJournals(L, journalFiles(L)), readChapters(L))); // new chapters fill the index
  console.log(`${L.doc} (${chapters.length} chapters)`);
}

// ---------- §11 status / verify / cost ----------
function journalEvents(L, jname) {
  return readText(path.join(L.journal, `${jname}.md`)).split('\n')
    .map((l) => /^(\d\d:\d\d:\d\d) \| ([a-z-]+) \| ([a-z-]+) \| (.*) \| L(\d+|-)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ kind: m[2], who: m[3], text: m[4] }));
}

function costRows(L, entries) {
  const injected = {};
  for (const l of readText(path.join(L.state, 'injected.log')).split('\n')) {
    const [, sid8, , bytes] = l.split('\t');
    if (sid8 !== undefined && bytes) injected[sid8] = (injected[sid8] || 0) + Number(bytes);
  }
  return entries.map(({ jname }) => {
    const sid8 = jname.split('_')[2] || '';
    const markers = journalEvents(L, jname).filter((e) => MARKER_KINDS.includes(e.kind));
    const markerChars = markers.reduce((n, e) => n + e.text.length + 14, 0);
    const inj = injected[sid8] || 0;
    return { jname, sid8, inj, markers: markers.length, markerChars, tokens: Math.round((inj + markerChars) / 4) };
  });
}

function cost(L, entries) {
  const rows = costRows(L, entries || extract(L));
  rows.forEach((r) => console.log(`${r.jname}: injected ${r.inj} B, ${r.markers} markers (${r.markerChars} chars), ~${r.tokens} tokens`));
  const avg = rows.length ? Math.round(rows.reduce((n, r) => n + r.tokens, 0) / rows.length) : 0;
  console.log(`average overhead per session: ~${avg} tokens (bytes / 4)`);
}

function status(L) {
  const entries = extract(L);
  const counts = {};
  for (const { jname } of entries) for (const e of journalEvents(L, jname)) counts[e.kind] = (counts[e.kind] || 0) + 1;
  const offs = exists(L.state) ? fs.readdirSync(L.state).filter((f) => f.endsWith('.off')) : [];
  const last = offs.reduce((t, f) => Math.max(t, fs.statSync(path.join(L.state, f)).mtimeMs), 0);
  const errors = readText(path.join(L.state, 'hook-errors.log')).split('\n').filter(Boolean).length;
  console.log(`research-log at ${L.R}`);
  console.log(`sessions: ${entries.length}   paused: ${exists(path.join(L.state, 'PAUSED')) ? 'YES' : 'no'}   hook errors: ${errors}   node ${process.version}`);
  console.log(`last sync: ${last ? new Date(last).toISOString() : 'never'}`);
  console.log(`events: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  console.log(`index: ${L.index}   stats: ${L.stats}`);
  cost(L, entries);
}

function verify(L) {
  const problems = [];
  const info = [];
  const sessions = readText(path.join(L.state, 'sessions')).split('\n').filter(Boolean);
  const byName = new Map(sessions.map((p) => [p.split(/[\\/]/).pop(), p]));
  let skipped = 0;
  for (const rawName of rawFiles(L)) {
    const rawFile = path.join(L.raw, rawName);
    const size = fsize(rawFile);
    if (size > 0) {
      const fd = fs.openSync(rawFile, 'r');
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, size - 1);
      fs.closeSync(fd);
      if (b[0] !== 10) problems.push(`${rawName}: does not end with a newline (truncated?)`);
    }
    const cache = readCache(L, rawName);
    const p = parseRaw(L, rawName);
    skipped += p.skipped;
    if (!p.firstTs) continue;
    const jfile = path.join(L.journal, `${cache.jname || journalBaseName(p)}.md`);
    if (!exists(jfile)) problems.push(`${rawName}: journal file missing (run: rlog.js extract)`);
    else if (cache.key !== cacheKey(L, rawName)) info.push(`${rawName}: journal is behind the raw mirror (run: rlog.js extract)`);
    else if (readText(jfile) !== renderJournal(p)) problems.push(`${rawName}: journal differs from what the raw mirror produces`);
    if (/\.old$/.test(rawName)) continue;
    const off = Number(readText(path.join(L.state, `${rawName}.off`)).trim() || 0);
    const t = byName.get(rawName);
    if (t && exists(t) && off > fsize(t)) info.push(`${rawName}: transcript is shorter than the saved offset (it will be rotated on the next sync)`);
    const gapBytes = readText(path.join(L.raw, `${rawName}.gaps`)).split('\n').filter(Boolean)
      .reduce((n, l) => { const [a, b2] = l.split('\t'); return n + (Number(b2) - Number(a)); }, 0);
    if (size < off - gapBytes) problems.push(`${rawName}: mirror has ${size} bytes but ${off - gapBytes} were recorded as copied`);
    if (gapBytes) info.push(`${rawName}: ${gapBytes} bytes off the record`);
  }
  const errors = readText(path.join(L.state, 'hook-errors.log')).split('\n').filter(Boolean).length;
  if (skipped) info.push(`${skipped} unparsable raw lines skipped`);
  if (errors) info.push(`${errors} hook errors logged in state/hook-errors.log`);
  problems.forEach((x) => console.log(`FAIL ${x}`));
  info.forEach((x) => console.log(`info ${x}`));
  console.log(problems.length ? `verify: ${problems.length} problem(s)` : 'verify: ok');
  return problems.length ? 1 : 0;
}

// ---------- §15 pause / resume / export ----------
function exportAll(L, withRaw) {
  extract(L);
  const date = new Date().toISOString().slice(0, 10);
  const dest = path.join(L.R, 'export', date);
  const copy = (src, dst) => { if (exists(src)) fs.cpSync(src, dst, { recursive: true }); };
  fs.mkdirSync(dest, { recursive: true });
  copy(L.journal, path.join(dest, 'journal'));
  copy(L.documentary, path.join(dest, 'documentary'));
  for (const f of ['TIMELINE.md', 'INDEX.md', 'STATS.md', 'DOCUMENTARY.md', 'README.md']) copy(path.join(L.R, f), path.join(dest, f));
  if (withRaw) {
    const counts = {};
    fs.mkdirSync(path.join(dest, 'raw'), { recursive: true });
    for (const rawName of rawFiles(L)) {
      const out = fs.openSync(path.join(dest, 'raw', rawName), 'w');
      forEachLine(path.join(L.raw, rawName), (line) => fs.writeSync(out, `${redact(line, counts)}\n`));
      fs.closeSync(out);
    }
    const summary = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    console.log(`raw included, redactions: ${summary}`);
  }
  console.log(dest);
}

// ---------- main ----------
function main(argv) {
  const args = argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(name); if (i === -1) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
  const flag = (name) => { const i = args.indexOf(name); if (i === -1) return false; args.splice(i, 1); return true; };
  const rootArg = opt('--root');
  const budget = Number(opt('--budget', 8000));
  const withRaw = flag('--with-raw');
  const fromArg = opt('--from');
  const dryRun = flag('--dry-run');
  const [cmd = 'status', arg] = args;
  let root = findRoot(rootArg);
  if (!root && cmd === 'import') {
    // First use in a project: create the folder here, but never in the home dir or a drive root.
    root = path.resolve(rootArg || process.cwd());
    if (root === path.resolve(os.homedir()) || path.dirname(root) === root) { console.log(`Refusing to create .research-log in ${root}.`); return 1; }
    if (!dryRun) initFolder(root);
  }
  if (!root) { console.log('No .research-log folder here or above. Start a Claude Code session in the project first, or run: rlog.js import'); return 1; }
  const L = layout(root);
  switch (cmd) {
    case 'extract': extract(L); return 0;
    case 'status': status(L); return 0;
    case 'verify': return verify(L);
    case 'cost': cost(L); return 0;
    case 'digest': {
      const entry = extract(L).find((e) => e.jname === String(arg || '').replace(/\.md$/, ''));
      if (!entry) { console.log(`no journal named ${arg}`); return 1; }
      console.log(writeDigest(L, entry.rawName, entry.jname, budget));
      return 0;
    }
    case 'build-list': buildList(L); return 0;
    case 'check-chapter': return checkChapter(L, arg || '');
    case 'stitch': stitch(L); return 0;
    case 'pause': fs.mkdirSync(L.state, { recursive: true }); fs.writeFileSync(path.join(L.state, 'PAUSED'), new Date().toISOString()); console.log('paused'); return 0;
    case 'resume': fs.rmSync(path.join(L.state, 'PAUSED'), { force: true }); console.log('resumed'); return 0;
    case 'export': exportAll(L, withRaw); return 0;
    case 'import': return importSessions(L, { from: fromArg, dryRun });
    case 'index': {
      extract(L);
      console.log(readText(L.index).split('\n')[2] || '');
      console.log(L.index);
      return 0;
    }
    case 'stats':
      extract(L);
      process.stdout.write(renderStats(readJournals(L, journalFiles(L))).summary);
      console.log(`\nPer-session table: ${L.stats}`);
      return 0;
    default: console.log(`unknown command: ${cmd}`); return 1;
  }
}

if (require.main === module) {
  try { process.exitCode = main(process.argv); } catch (e) { console.error(`rlog: ${e.stack || e.message}`); process.exitCode = 2; }
}
module.exports = {
  redact, parseRaw, renderJournal, renderDigest, extract, layout, checkChapter, verify, MARKER_RE,
  readJournals, renderIndex, renderStats, errorType, findTranscriptDir, completeLength,
};
