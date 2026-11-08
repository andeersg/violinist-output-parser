#!/usr/bin/env node
'use strict';

/**
 * Violinist output parser.
 *
 * Reads the JSON debug log produced by Violinist and prints a condensed,
 * readable report. Works both as a GitHub Action (inputs via INPUT_* env vars)
 * and as a plain CLI: `node index.js path/to/output.json` or via stdin.
 *
 * No dependencies on purpose, so the action runs without `npm install`.
 */

const fs = require('fs');

// ---------------------------------------------------------------------------
// Inputs / GitHub helpers
// ---------------------------------------------------------------------------

function getInput(name) {
  const val = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return val ? val.trim() : '';
}

function bool(v, dflt) {
  if (v === '') return dflt;
  return ['true', '1', 'yes', 'on'].includes(v.toLowerCase());
}

const isActions = process.env.GITHUB_ACTIONS === 'true';

function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function annotate(level, msg, title) {
  if (isActions) {
    const props = title ? ` title=${escapeData(title).replace(/:/g, '%3A').replace(/,/g, '%2C')}` : '';
    console.log(`::${level}${props}::${escapeData(msg)}`);
  }
}

function group(title, fn) {
  if (isActions) console.log(`::group::${title}`);
  else console.log(`\n--- ${title} ---`);
  fn();
  if (isActions) console.log('::endgroup::');
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${name}=${value}\n`);
}

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// Reading input
// ---------------------------------------------------------------------------

function readRaw() {
  const file = getInput('file') || process.argv[2];
  if (file && file !== '-') return fs.readFileSync(file, 'utf8');
  const json = getInput('json');
  if (json) return json;
  const envName = getInput('env') || 'JSON_OUTPUT';
  if (process.env[envName]) return process.env[envName];
  // Never read stdin inside Actions: it may be an open pipe and would hang the job.
  if (!isActions && !process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => (data += d));
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', reject);
    });
  }
  throw new Error('No input. Expected the Violinist output in $JSON_OUTPUT (or the `file`/`json`/`env` inputs, or stdin).');
}

function parse(raw) {
  if (!raw || !raw.trim()) throw new Error('The Violinist output is empty (did the Violinist step run?).');
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Violinist output is sometimes surrounded by other text; grab the array.
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start !== -1 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

// Messages that are pure noise for a human reading the result.
const NOISE = [
  /^Licence key/,
  /^Queue runner revision/,
  /^Creating command /,
  /^PHP \d/,
  /^Composer version/,
  /^Cloning repository/,
  /^Repository cloned/,
  /^Running composer install/,
  /^composer install completed/,
  /^Checking private status/,
  /^Checking default branch/,
  /^Checking for security issues/,
  /^Security update available for/,
  /^Checking only direct dependencies/,
  /^Checking all \(not only direct/,
  /^Removing \S+ because it has no match in the allow list/,
  /^The following updates were found/,
  /^Current commit (SHA|timestamp)/,
  /^Config suggested/,
  /^The option number_of_concurrent_updates/,
  /^Trying to retrieve changelog/,
  /^Changelog retrieved/,
  /^Changed files retrieved/,
  /^Checking out default branch/,
  /^Cleaning up after update check/,
  /^phpstan\/extension-installer/,
  /^>\s/, // raw composer script output
];

const isNoise = (m) => NOISE.some((re) => re.test(m));

function analyze(entries) {
  const r = {
    repo: null,
    php: null,
    composer: null,
    defaultBranch: null,
    commit: null,
    startedAt: null,
    finishedAt: null,
    advisories: [],
    updates: [],
    packages: new Map(), // name -> { name, status, url, notes[], errors[], changes[] }
    filteredByAllowList: [],
    errors: [],
    warnings: [],
    other: [],
  };

  const pkg = (name) => {
    if (!r.packages.has(name)) {
      r.packages.set(name, { name, status: null, url: null, branch: null, indirect: null, notes: [], errors: [], changes: [] });
    }
    return r.packages.get(name);
  };

  let current = null;
  let pendingBranch = null;
  let m;

  for (const e of entries) {
    const msg = String(e.message ?? '').trim();
    const ctx = e.context && typeof e.context === 'object' && !Array.isArray(e.context) ? e.context : {};
    if (e.timestamp) {
      r.startedAt ??= e.timestamp;
      r.finishedAt = e.timestamp;
    }

    // --- run metadata --------------------------------------------------
    if ((m = msg.match(/^PHP (\S+)/))) r.php = m[1];
    if ((m = msg.match(/^Composer version (\S+)/))) r.composer = m[1];
    if ((m = msg.match(/^Starting update check for (\S+)/))) { r.repo = m[1]; continue; }
    if ((m = msg.match(/^Default branch set in project is (\S+)/))) { r.defaultBranch = m[1]; continue; }
    if ((m = msg.match(/^Current commit SHA for \S+ is (\w+)/))) r.commit = m[1];
    if ((m = msg.match(/^Removing (\S+) because it has no match in the allow list/))) {
      r.filteredByAllowList.push(m[1]);
      continue;
    }

    // --- security advisories ---------------------------------------------
    if (ctx.result && /security advisories/i.test(msg)) {
      for (const [name, data] of Object.entries(ctx.result)) {
        for (const a of data.advisories || []) {
          r.advisories.push({
            package: name,
            title: a.title,
            cve: a.cve,
            severity: a.severity || 'unknown',
            link: a.link,
            affected: a.affectedVersions,
          });
        }
      }
      continue;
    }

    // --- available updates -----------------------------------------------
    if (e.type === 'update' && Array.isArray(ctx.packages)) {
      for (const p of ctx.packages) {
        r.updates.push({
          name: p.name,
          from: p.version,
          to: p.latest,
          status: p['latest-status'],
          direct: p['direct-dependency'],
          abandoned: p.abandoned,
        });
      }
      continue;
    }

    // --- per-package processing ------------------------------------------
    if (e.type === 'pr_exists' || (m = msg.match(/^Skipping (\S+) because (.+)/))) {
      const name = ctx.package || (msg.match(/^Skipping (\S+)/) || [])[1];
      if (name) {
        const p = pkg(name);
        const reason = (msg.match(/because (.+)/) || [])[1] || 'skipped';
        p.status = e.type === 'pr_exists' ? 'PR already exists' : `Skipped: ${reason}`;
        if (ctx.url) p.url = ctx.url;
        if (current === p) current = null;
        continue;
      }
    }
    if ((m = msg.match(/^Checking out new branch: (\S+)/))) { pendingBranch = m[1]; continue; }
    if ((m = msg.match(/^Running composer update for package (\S+)(?: to update the indirect dependency (\S+))?/))) {
      current = pkg(m[1]);
      current.branch = pendingBranch;
      if (m[2] && m[2] !== m[1]) {
        current.indirect = m[2];
        current.notes.push(`Updated via ${m[1]} to bump indirect dependency ${m[2]}`);
      }
      pendingBranch = null;
      continue;
    }
    if ((m = msg.match(/^Successfully ran command composer update for package (\S+)/))) {
      pkg(m[1]).status ??= 'Updated';
      continue;
    }
    if (/^Checking out default branch|^Cleaning up after update check/.test(msg)) {
      current = null;
      continue;
    }
    // Composer update output: extract the lock file changes.
    if (current && /Lock file operations:/.test(msg)) {
      const lockSection = msg.split(/Writing lock file/)[0];
      for (const line of lockSection.split('\n')) {
        const u = line.match(/^\s*- (Upgrading|Downgrading|Installing|Removing) (\S+)(?: \((.+?)\))?/);
        if (u) current.changes.push(`${u[1]} ${u[2]}${u[3] ? ` (${u[3]})` : ''}`);
      }
      continue;
    }
    if ((m = msg.match(/^Updating the PR of (\S+) since (.+)/))) {
      pkg(m[1]).notes.push(`Updating existing PR: ${m[2]}`);
      continue;
    }

    // --- errors / leftovers ----------------------------------------------
    if (e.type === 'error') {
      r.errors.push({ msg, pkg: current?.name });
      if (current) current.errors.push(msg);
      continue;
    }
    if (/exception|failed|warning/i.test(msg) && !msg.includes('\n')) {
      r.warnings.push({ msg, pkg: current?.name });
      if (current) current.notes.push(`⚠ ${msg}`);
      continue;
    }
    if (isNoise(msg) || msg.includes('\n')) continue; // multi-line = raw tool output

    if (current) current.notes.push(msg);
    else r.other.push(msg);
  }

  // Final status per package.
  for (const p of r.packages.values()) {
    const notes = p.notes.join('\n');
    if (p.status === 'Updated' || !p.status) {
      if (p.errors.length && !/Will try to update the PR/.test(notes)) p.status = 'Failed';
      else if (/Pull request created|Created pull request/i.test(notes)) p.status = 'PR created';
      else if (/Will try to update the PR|Updating existing PR/.test(notes)) p.status = 'Existing PR updated';
      else if (/up to date\. Not pushing/i.test(notes)) p.status = 'PR up to date';
      else p.status = p.status || 'Unknown';
    }
  }

  return r;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
const fmtTime = (t) => (t ? new Date(t * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '?');

// The package entry that handled an update: either the package itself, or the
// direct dependency Violinist updated to bump an indirect one.
function resultFor(r, name) {
  if (r.packages.has(name)) return { p: r.packages.get(name), via: null };
  for (const p of r.packages.values()) if (p.indirect === name) return { p, via: p.name };
  return { p: null, via: null };
}

function statusIcon(s) {
  if (/failed/i.test(s)) return '❌';
  if (/skipped|already exists|up to date/i.test(s)) return '⏭️';
  if (/created|updated/i.test(s)) return '✅';
  return '❔';
}

function printConsole(r, { showOther }) {
  const line = '─'.repeat(60);
  console.log(c.bold(`\nViolinist report${r.repo ? ` for ${r.repo}` : ''}`));
  console.log(line);
  const meta = [
    r.defaultBranch && `branch ${r.defaultBranch}${r.commit ? ` @ ${r.commit.slice(0, 7)}` : ''}`,
    r.php && `PHP ${r.php}`,
    r.composer && `Composer ${r.composer}`,
    `ran ${fmtTime(r.startedAt)} (${(r.finishedAt || 0) - (r.startedAt || 0)}s)`,
  ].filter(Boolean);
  console.log(c.dim(meta.join(' · ')));

  console.log(c.bold(`\nAvailable updates (${r.updates.length})`));
  if (!r.updates.length) console.log('  none');
  const w = Math.max(0, ...r.updates.map((u) => u.name.length));
  for (const u of r.updates) {
    const { p, via } = resultFor(r, u.name);
    const tags = [u.direct === false && 'indirect', u.abandoned && 'ABANDONED', u.status].filter(Boolean).join(', ');
    console.log(`  ${u.name.padEnd(w)}  ${u.from} → ${c.green(u.to)}  ${c.dim(tags)}${p ? `  ${statusIcon(p.status)} ${p.status}${via ? ` (via ${via})` : ''}` : ''}`);
  }

  if (r.packages.size) {
    console.log(c.bold('\nUpdate results'));
    for (const p of r.packages.values()) {
      console.log(`  ${statusIcon(p.status)} ${c.bold(p.name)}: ${p.status}${p.url ? `  ${c.cyan(p.url)}` : ''}`);
      if (p.branch) console.log(c.dim(`      branch: ${p.branch}`));
      for (const n of p.notes) console.log(c.dim(`      • ${n}`));
      for (const er of p.errors) console.log(c.red(`      ✖ ${er}`));
      if (p.changes.length) {
        console.log(c.dim(`      lock file changes (${p.changes.length}):`));
        for (const ch of p.changes) console.log(c.dim(`        - ${ch}`));
      }
    }
  }

  console.log(c.bold(`\nSecurity advisories (${r.advisories.length})`));
  if (!r.advisories.length) console.log('  none');
  for (const a of [...r.advisories].sort((x, y) => (SEVERITY_ORDER[x.severity] ?? 9) - (SEVERITY_ORDER[y.severity] ?? 9))) {
    const sev = /critical|high/.test(a.severity) ? c.red(a.severity.toUpperCase()) : c.yellow(a.severity.toUpperCase());
    console.log(`  [${sev}] ${c.bold(a.package)}: ${a.title}`);
    console.log(c.dim(`      ${[a.cve, a.link].filter(Boolean).join('  ')}`));
  }

  if (r.errors.length || r.warnings.length) {
    console.log(c.bold('\nErrors & warnings'));
    for (const e of r.errors) console.log(c.red(`  ✖ ${e.pkg ? `[${e.pkg}] ` : ''}${e.msg}`));
    for (const e of r.warnings) console.log(c.yellow(`  ⚠ ${e.pkg ? `[${e.pkg}] ` : ''}${e.msg}`));
  }

  if (r.filteredByAllowList.length) {
    console.log(c.dim(`\n${r.filteredByAllowList.length} packages ignored (not in allow list).`));
  }

  if (showOther && r.other.length) {
    group(`Other messages (${r.other.length})`, () => r.other.forEach((o) => console.log(`  ${o}`)));
  }
  console.log('');
}

function md(r) {
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const out = [];
  out.push(`## 🎻 Violinist report${r.repo ? ` for \`${r.repo}\`` : ''}`);
  out.push(
    [
      r.defaultBranch && `Branch \`${r.defaultBranch}\`${r.commit ? ` @ \`${r.commit.slice(0, 7)}\`` : ''}`,
      r.php && `PHP ${r.php}`,
      r.composer && `Composer ${r.composer}`,
      `${fmtTime(r.startedAt)}`,
    ]
      .filter(Boolean)
      .join(' · '),
  );

  out.push(`\n### Available updates (${r.updates.length})`);
  if (r.updates.length) {
    out.push('| Package | From | To | Type | Result |', '|---|---|---|---|---|');
    for (const u of r.updates) {
      const { p, via } = resultFor(r, u.name);
      const result = p
        ? `${statusIcon(p.status)} ${p.url ? `[${p.status}](${p.url})` : p.status}${via ? ` (via \`${via}\`)` : ''}`
        : '—';
      const type = [u.status, u.direct === false && 'indirect', u.abandoned && '**abandoned**'].filter(Boolean).join(', ');
      out.push(`| \`${u.name}\` | ${u.from} | ${u.to} | ${esc(type)} | ${esc(result)} |`);
    }
  } else out.push('_No updates found._');

  const detailed = [...r.packages.values()].filter((p) => p.notes.length || p.errors.length || p.changes.length);
  for (const p of detailed) {
    out.push(`\n<details><summary>${statusIcon(p.status)} <code>${p.name}</code> — ${p.status}</summary>\n`);
    if (p.branch) out.push(`Branch: \`${p.branch}\`\n`);
    for (const n of p.notes) out.push(`- ${n}`);
    for (const e of p.errors) out.push(`- ❌ ${e}`);
    if (p.changes.length) {
      out.push('\nLock file changes:\n```');
      out.push(...p.changes);
      out.push('```');
    }
    out.push('</details>');
  }

  out.push(`\n### Security advisories (${r.advisories.length})`);
  if (r.advisories.length) {
    out.push('| Severity | Package | Advisory | CVE |', '|---|---|---|---|');
    for (const a of [...r.advisories].sort((x, y) => (SEVERITY_ORDER[x.severity] ?? 9) - (SEVERITY_ORDER[y.severity] ?? 9))) {
      const title = a.link ? `[${esc(a.title)}](${a.link})` : esc(a.title);
      out.push(`| ${a.severity} | \`${a.package}\` | ${title} | ${a.cve || ''} |`);
    }
  } else out.push('_None._');

  if (r.errors.length || r.warnings.length) {
    out.push('\n### Errors & warnings');
    for (const e of r.errors) out.push(`- ❌ ${e.pkg ? `\`${e.pkg}\`: ` : ''}${e.msg}`);
    for (const e of r.warnings) out.push(`- ⚠️ ${e.pkg ? `\`${e.pkg}\`: ` : ''}${e.msg}`);
  }

  if (r.filteredByAllowList.length) {
    out.push(
      `\n<details><summary>${r.filteredByAllowList.length} packages ignored (not in allow list)</summary>\n\n` +
        r.filteredByAllowList.map((n) => `\`${n}\``).join(', ') +
        '\n</details>',
    );
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let entries;
  try {
    entries = parse(await readRaw());
  } catch (err) {
    annotate('error', `Could not read Violinist output: ${err.message}`);
    console.error(`Could not read Violinist output: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(entries)) {
    console.error('Expected the Violinist output to be a JSON array of log entries.');
    process.exitCode = 1;
    return;
  }

  const r = analyze(entries);
  printConsole(r, { showOther: bool(getInput('show-other'), true) });

  for (const e of r.errors) annotate('error', e.msg, e.pkg ? `Violinist: ${e.pkg}` : 'Violinist');
  if (bool(getInput('annotate-warnings'), false)) {
    for (const e of r.warnings) annotate('warning', e.msg, e.pkg ? `Violinist: ${e.pkg}` : 'Violinist');
  }

  if (process.env.GITHUB_STEP_SUMMARY && bool(getInput('summary'), true)) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md(r));
  }

  setOutput('updates-count', r.updates.length);
  setOutput('advisories-count', r.advisories.length);
  setOutput('errors-count', r.errors.length);

  if (bool(getInput('fail-on-error'), false) && r.errors.length) {
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { analyze, md, parse };
