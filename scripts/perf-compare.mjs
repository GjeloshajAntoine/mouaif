#!/usr/bin/env node
// Compare two performance and memory reports written by perf-profile.mjs.
//
//   node scripts/perf-compare.mjs                      # the two newest runs in perf/runs/
//   node scripts/perf-compare.mjs old.json             # old.json against perf/latest.json
//   node scripts/perf-compare.mjs old.json new.json    # explicit pair, older first
//   node scripts/perf-compare.mjs @HEAD                # the committed perf/latest.json against the working copy
//   node scripts/perf-compare.mjs @HEAD~3 @HEAD        # two committed baselines
//
// Options:
//   --tolerance <pct>      changes inside this band count as "same" (default 15)
//   --all                  also list the metrics that did not change
//   --json                 print the comparison as JSON
//   --fail-on-regression   exit 1 when any metric got worse
//
// A report is "lower is better" throughout, so "worse" means the number rose.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareReports, DEFAULT_TOLERANCE } from './lib/perf-compare.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LATEST = path.join(ROOT, 'perf', 'latest.json');
const RUNS_DIR = path.join(ROOT, 'perf', 'runs');

function parseArgs(argv) {
  const out = { files: [], tolerance: DEFAULT_TOLERANCE, all: false, json: false, failOnRegression: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tolerance') out.tolerance = Number(argv[++i]);
    else if (arg === '--all') out.all = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--fail-on-regression') out.failOnRegression = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--')) throw new Error('unknown option ' + arg);
    else out.files.push(arg);
  }
  if (!Number.isFinite(out.tolerance) || out.tolerance < 0) throw new Error('--tolerance needs a non-negative number');
  return out;
}

const HELP = `usage: node scripts/perf-compare.mjs [base] [head] [options]
  no arguments       the two newest runs in perf/runs/
  one argument       that report against perf/latest.json
  two arguments      base (older) then head (newer)
  @<git ref>         the perf/latest.json committed at that ref
  --tolerance <pct>  noise band, default ${DEFAULT_TOLERANCE}
  --all              also list unchanged metrics
  --json             machine-readable output
  --fail-on-regression  exit 1 when any metric got worse`;

function readReport(spec) {
  let text;
  if (spec.startsWith('@')) {
    const ref = spec.slice(1) || 'HEAD';
    text = execFileSync('git', ['show', ref + ':perf/latest.json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } else {
    text = fs.readFileSync(path.resolve(spec), 'utf8');
  }
  const report = JSON.parse(text);
  if (!report || typeof report !== 'object' || !Array.isArray(report.transcripts)) {
    throw new Error(spec + ' is not a perf-profile report');
  }
  if (report.error) throw new Error(spec + ' is from a failed run (' + report.error.message + ')');
  return report;
}

function newestRuns(count) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).sort().slice(-count).map((f) => path.join(RUNS_DIR, f));
}

function resolveInputs(files) {
  if (files.length > 2) throw new Error('give at most two reports');
  if (files.length === 2) return files;
  if (files.length === 1) return [files[0], LATEST];
  const runs = newestRuns(2);
  if (runs.length < 2) {
    throw new Error('need two runs in perf/runs/ (found ' + runs.length + '); run perf-profile twice, or name the reports to compare');
  }
  return runs;
}

// ---- formatting ------------------------------------------------------------

function fmtValue(n, unit) {
  if (n == null) return '—';
  if (unit === 'bytes') {
    if (Math.abs(n) < 1024) return n + ' B';
    if (Math.abs(n) < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }
  if (unit === 'ms') return Math.abs(n) >= 1000 ? (n / 1000).toFixed(2) + ' s' : Math.round(n) + ' ms';
  return String(Math.round(n * 10) / 10);
}

function fmtDelta(m) {
  if (m.delta == null) return '';
  const sign = m.delta > 0 ? '+' : m.delta < 0 ? '−' : '';
  const body = fmtValue(Math.abs(m.delta), m.unit);
  const pct = m.pct == null ? '' : ' (' + sign + Math.abs(Math.round(m.pct)) + '%)';
  return sign + body + pct;
}

const MARK = { worse: '▲ worse', better: '▼ better', same: '', missing: 'n/a' };

function formatRows(metrics, all, indent) {
  const rows = metrics.filter((m) => all || (m.verdict !== 'same' && m.verdict !== 'missing'));
  const width = Math.max(0, ...rows.map((m) => m.label.length));
  return rows.map((m) => indent + m.label.padEnd(width) + '  '
    + fmtValue(m.base, m.unit).padStart(10) + ' → ' + fmtValue(m.head, m.unit).padEnd(10) + '  '
    + fmtDelta(m).padEnd(18) + MARK[m.verdict]);
}

function render(result, opts) {
  const lines = [];
  const stamp = (r) => r.stamp || r.generatedAt || 'unknown';
  lines.push('base ' + stamp(result.base) + '   head ' + stamp(result.head) + '   noise band ±' + result.tolerance + '%');
  if (result.environment.length) {
    lines.push('', 'Not like-for-like:');
    for (const e of result.environment) lines.push('  ' + e.field + ': ' + (e.base ?? '—') + ' → ' + (e.head ?? '—'));
  }
  const section = (title, metrics, indent = '  ') => {
    const rows = formatRows(metrics, opts.all, indent);
    if (rows.length) lines.push('', title, ...rows);
  };
  section('App shell', result.shell);
  section('Server', result.server);
  for (const t of result.transcripts) {
    const rows = t.rows.base !== t.rows.head ? ' (' + t.rows.base + ' → ' + t.rows.head + ' rows)' : ' (' + t.rows.head + ' rows)';
    section(t.label + rows, t.metrics);
  }
  if (result.unmatched.length) {
    lines.push('', 'Not compared (no chat with this label in the other report):');
    for (const u of result.unmatched) lines.push('  ' + u.label + ' — only in ' + u.only);
  }
  const c = result.counts;
  lines.push('', c.worse + ' worse, ' + c.better + ' better, ' + c.same + ' unchanged' + (c.missing ? ', ' + c.missing + ' missing' : ''));
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }
  const [baseSpec, headSpec] = resolveInputs(args.files);
  const result = compareReports(readReport(baseSpec), readReport(headSpec), { tolerance: args.tolerance });
  console.log(args.json ? JSON.stringify(result, null, 2) : render(result, args));
  return args.failOnRegression && result.counts.worse > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error('perf-compare: ' + e.message);
    process.exitCode = 2;
  }
}

export { parseArgs, render, fmtValue };
