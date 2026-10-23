/**
 * Pathwise <-> South Brunswick Genesis server  (server.js)
 *
 * CHANGE SUMMARY (v1.0, new file):
 *  - Serves ./public/index.html (your Pathwise file) and injects /connector.js into it. Original HTML is NOT modified on disk.
 *  - POST /api/login signs in to Genesis with your credentials (form login, cookie jar, kept in memory only).
 *  - Pulls: student id -> gradebook summary (courses + %), per-course assignments (category / name / score / max), schedule.
 *  - Maps everything into Pathwise's import shape ({name, courses:[{n,l,p,d,r,t,g,c,cats:[{n,w,gw,items:[{n,s,m,h}]}]}]}).
 *  - Polls every POLL_MIN minutes (default 15), diffs vs. last snapshot, pushes new/changed grades to the page via SSE (/api/events).
 *  - Localhost-only bind + Host/Origin checks (blocks other websites from poking the API).
 *  - NEVER auto-retries a failed password (avoids locking your Genesis account).
 *
 * !! UNTESTED against the live SBHS Genesis (no network path to it from where this was written). URLs/selectors follow
 *    standard Genesis conventions. If a parse comes back empty: run with DEBUG=1, hit /api/raw/<page>, open ./debug/*.html,
 *    and adjust SCHED_QUERY / the parse* functions below. Everything Genesis-specific is in the "GENESIS" section.
 *
 * Run:  npm install && node server.js   (Node 20+)   then open http://localhost:3000
 * Env:  PORT=3000  POLL_MIN=15  DEBUG=1  GENESIS_BASE=https://parents.sbschools.org/genesis
 *       GENESIS_USER / GENESIS_PASS (optional, enables unattended login at startup)  STUDENT_ID (optional override)
 *       SCHED_QUERY (optional override for the schedule page query string)
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const cheerio = require('cheerio');

const PORT = +process.env.PORT || 3000;
const POLL_MIN = Math.max(5, +process.env.POLL_MIN || 15);           // floor 5 min: be polite to the district's server
const BASE = (process.env.GENESIS_BASE || 'https://parents.sbschools.org/genesis').replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;
const DEBUG = !!process.env.DEBUG;
const ROOT = __dirname, PUB = path.join(ROOT, 'public'), DBG = path.join(ROOT, 'debug'), DATA = path.join(ROOT, 'data');
const SNAP = path.join(DATA, 'snapshot.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

/* ============================== GENESIS ============================== */
class Genesis {
  constructor() { this.jar = new Map(); this.sid = process.env.STUDENT_ID || ''; }
  // Fetch with manual redirects so cookies are captured at every hop and never sent off the Genesis origin.
  async req(url, { method = 'GET', form } = {}) {
    let body = form ? new URLSearchParams(form).toString() : undefined;
    for (let hop = 0; hop < 8; hop++) {
      const u = new URL(url, ORIGIN);
      if (u.origin !== ORIGIN) throw new Error('Redirected off Genesis origin: ' + u.origin);
      const headers = { 'user-agent': 'Mozilla/5.0 (Pathwise local sync)', cookie: [...this.jar].map(([k, v]) => k + '=' + v).join('; ') };
      if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
      const res = await fetch(u, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1)); }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), u).href;
        if (![307, 308].includes(res.status)) { method = 'GET'; body = undefined; }
        continue;
      }
      return { html: await res.text(), url: u.href, status: res.status };
    }
    throw new Error('Too many redirects');
  }
  loggedOut(html) { return /name=["']j_password["']/i.test(html); }
  async login(user, pass) {
    this.jar.clear();
    await this.req(`${BASE}/parents?gohome=true`);                                   // seeds JSESSIONID
    const r = await this.req(`${BASE}/j_security_check`, { method: 'POST', form: { j_username: user, j_password: pass } });
    if (this.loggedOut(r.html) || /invalid (user|login|password)/i.test(r.html)) throw new Error('Genesis rejected the login (bad username/password, or this account uses SSO/MFA).');
    const home = r.html.includes('studentid') ? r : await this.req(`${BASE}/parents?gohome=true`);
    if (!this.sid) { const m = home.html.match(/studentid=(\d+)/i); if (m) this.sid = m[1]; }
    if (!this.sid) throw new Error('Logged in but could not find a student id. Set STUDENT_ID in the environment.');
    this.name = clean(cheerio.load(home.html)('.studentName, #studentName, .name').first().text()) || '';
    return home.html;
  }
  async page(label, query) {
    const r = await this.req(`${BASE}/parents?${query}&studentid=${this.sid}`);
    if (this.loggedOut(r.html)) { const e = new Error('SESSION_EXPIRED'); e.expired = true; throw e; }
    // Vercel's deployed function filesystem is read-only (except /tmp). Keep
    // diagnostics in memory there; only save raw HTML when running locally.
    if (DEBUG && process.env.VERCEL !== '1') {
      try {
        fs.mkdirSync(DBG, { recursive: true });
        fs.writeFileSync(path.join(DBG, label.replace(/\W+/g, '_') + '.html'), r.html);
      } catch (err) {
        // Debug file output is optional and must never break the Genesis request.
        console.warn('[Pathwise] Could not write debug HTML:', err.message);
      }
    }
    return r.html;
  }
}

// --- parsers (Genesis-specific; tune these first if output is empty) ---
const re = { frac: /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/, pct: /(\d{1,3}(?:\.\d+)?)\s*%/ };
const cellsOf = ($, tr) => $(tr).children('th,td').map((_, c) => clean($(c).text())).get();
const leafTables = $ => $('table').filter((_, t) => !$(t).find('table').length);   // innermost tables only: avoids double-counting nested layouts

function inspectGradebook(html) {
  const $ = cheerio.load(html);
  const tables = $('table').map((_, t) => ({
    headers: $(t).find('tr').first().find('th,td').map((__, c) => clean($(c).text())).get().slice(0, 12),
    rows: $(t).find('tr').slice(0, 8).map((__, tr) => ({
      cells: cellsOf($, tr).slice(0, 12),
      links: $(tr).find('a').map((___, a) => ({ text: clean($(a).text()).slice(0, 100), href: ($(a).attr('href') || '').slice(0, 300) })).get().slice(0, 5)
    })).get()
  })).get().filter(t => t.rows.length).slice(0, 8);
  return { title: clean($('title').text()), urlHints: $('form').map((_, f) => $(f).attr('action') || '').get().slice(0, 5), tables, bodyTextStart: clean($('body').text()).slice(0, 1800) };
}

function parseGradebook(html) {                // -> [{n, g, code, section, mp}]
  const $ = cheerio.load(html), out = [], grouped = new Map();
  // SB Genesis uses separate onclick handlers for the course title and its grade.
  // Pair them by the exact courseCode/courseSection/markingPeriod arguments.
  $('[onclick*="goToCourseSummary"]').each((_, el) => {
    const onclick = $(el).attr('onclick') || '';
    const m = onclick.match(/goToCourseSummary\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/i);
    if (!m) return;
    const key = [m[1], m[2], m[3]].join(':');
    const label = clean($(el).text());
    if (!grouped.has(key)) grouped.set(key, { code: m[1], section: m[2], mp: m[3], labels: [] });
    if (label) grouped.get(key).labels.push(label);
  });
  for (const c of grouped.values()) {
    const title = c.labels.find(x => !/^\d{1,3}(?:\.\d+)?\s*(?:\([A-F][+-]?\))?$/i.test(x) && !/^MP\d+$/i.test(x));
    const gradeLabel = c.labels.find(x => /^\d{1,3}(?:\.\d+)?\s*(?:\([A-F][+-]?\))?$/i.test(x));
    if (!title || !gradeLabel) continue;
    const gm = gradeLabel.match(/\d{1,3}(?:\.\d+)?/);
    if (!gm) continue;
    const g = Number(gm[0]);
    if (g > 100) continue;
    out.push({ n: title, g, code: c.code, section: c.section, mp: c.mp });
  }
  if (out.length) return out;

  // Generic fallback for Genesis variants with course links and percentage cells.
  const seen = new Set();
  $('tr').each((_, tr) => {
    const a = $(tr).find('a').filter((_, el) => /courseCode|courseSection|coursesummary/i.test($(el).attr('href') || '')).first();
    const href = a.attr('href') || '';
    const cells = cellsOf($, tr), m = cells.map(x => x.match(re.pct)).find(Boolean);
    const n = clean(a.text()) || cells.find(x => /[A-Za-z]{4}/.test(x) && !re.pct.test(x) && x.length < 70);
    if (!m || !n || seen.has(n)) return;
    seen.add(n);
    const q = href ? new URL(href, ORIGIN).searchParams : new URLSearchParams();
    out.push({ n, g: +m[1], code: q.get('courseCode') || '', section: q.get('courseSection') || '', mp: q.get('mp') || '' });
  });
  return out;
}
function parseAssignments(html) {              // -> {items:[{cat,n,s,m}], weights:{cat:w}}
  const $ = cheerio.load(html), items = [], weights = {};
  // South Brunswick's course summary has a three-column assignment list: Due | Assignment | Grade.
  // Category is shown as a small italic label inside the assignment cell, and scores look like 42 / 50.
  $('table').each((_, table) => {
    const header = $(table).find('tr').filter((__, tr) => {
      const cells = cellsOf($, tr).map(x => x.toLowerCase());
      return cells.some(x => x === 'due') && cells.some(x => x === 'assignment') && cells.some(x => x === 'grade');
    }).first();
    if (!header.length) return;
    let active = false;
    $(table).find('tr').each((__, tr) => {
      if (tr === header[0]) { active = true; return; }
      if (!active) return;
      const cells = $(tr).children('td,th');
      if (cells.length < 3) return;
      const date = clean(cells.eq(0).text());
      const assignmentCell = cells.eq(1);
      const gradeCell = cells.eq(2);
      const name = clean(assignmentCell.find('b').last().text()) || clean(assignmentCell.text().replace(/\b(?:Performance|Homework|Assessment|Classwork)\b/gi, ''));
      if (!name || /^(?:due|assignment|grade)$/i.test(name)) return;
      const gradeText = clean(gradeCell.text());
      const frac = gradeText.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
      if (!frac) return; // ungraded entries are intentionally not fabricated into scores
      const cat = clean(assignmentCell.find('div[style*="italic"]').first().text()) || 'Other';
      const idMatch = (assignmentCell.find('[id^="divDescription"]').attr('id') || '').match(/(\d+)$/);
      items.push({ cat, n: name, s: Number(frac[1]), m: Number(frac[2]), date, id: idMatch ? idMatch[1] : '' });
    });
  });
  // Read category weights from the separate Grading Information table.
  leafTables($).each((_, t) => {
    $(t).find('tr').each((__, tr) => {
      const cells = cellsOf($, tr);
      if (cells.length < 2 || /^(category|type)$/i.test(cells[0])) return;
      const w = cells[1].match(/(\d+(?:\.\d+)?)\s*%?/);
      if (w && /%/.test(cells[1])) weights[cells[0]] = Number(w[1]);
    });
  });
  return { items, weights };
}
function parseSchedule(html) {                 // -> [{n,p,periodLabel,d,r,t,start,end,date}]
  const $ = cheerio.load(html), out = [];
  const title = clean($('tr.listheading').first().text());
  const dateMatch = title.match(/Student Schedule\s*\(([^)]+)\)/i);
  const rows = $('tr.listrow, tr.listrowselected, tr.listrowselected2');
  if (rows.length) {
    // A/B is a property of this date's schedule. The lunch label is the
    // day marker; never assign A to every course just because one class says A-Day
    // without first confirming the response is a single-date schedule.
    let observedDay = '';
    rows.each((_, tr) => {
      const text = clean($(tr).text());
      const m = text.match(/\b([AB])-Day\b/i);
      if (m) observedDay = m[1].toUpperCase();
    });
    rows.each((_, tr) => {
      const cells = $(tr).children('td');
      if (cells.length < 2) return;
      const left = cells.eq(0), right = cells.eq(1);
      const periodText = clean(left.find('b').first().text());
      const pm = periodText.match(/Period\s*(\d+)([A-Z]?)/i);
      if (!pm) return;
      const times = left.find('div').map((__, el) => clean($(el).text())).get()
        .filter(x => /^\d{1,2}:\d{2}\s*(?:AM|PM)$/i.test(x));
      const course = clean(right.find('b').first().text());
      if (!course) return;
      const detail = right.children('div').map((__, el) => clean($(el).text())).get();
      const teacher = detail[0] || '';
      const roomText = detail.find(x => /^Room\s+/i.test(x)) || '';
      out.push({
        n: course,
        p: Number(pm[1]),
        periodLabel: periodText,
        d: observedDay || 'Unknown',
        r: roomText.replace(/^Room\s+/i, ''),
        t: teacher,
        start: times[0] || '', end: times[1] || '',
        date: dateMatch ? dateMatch[1] : ''
      });
    });
    if (out.length) return out;
  }

  // Fallback for Genesis layouts that expose a conventional schedule table.
  leafTables($).each((_, t) => {
    let ix = null;
    $(t).find('tr').each((_, tr) => {
      const cells = cellsOf($, tr); if (!cells.length) return;
      const low = cells.map(x => x.toLowerCase()), f = k => low.findIndex(x => k.some(w => x.includes(w)));
      if (!ix && f(['course']) >= 0 && f(['period', 'time']) >= 0) { ix = { n: f(['course']), p: f(['period']), t: f(['teacher', 'instructor']), r: f(['room']), d: f(['day']) }; return; }
      if (!ix || !cells[ix.n]) return;
      const per = (cells[ix.p] || '').match(/\d+/);
      const dayTxt = (ix.d >= 0 ? cells[ix.d] : '') + ' ' + (cells[ix.p] || '');
      const days = [...new Set([...dayTxt.matchAll(/\b([AB])\b/g)].map(x => x[1]))];
      out.push({ n: cells[ix.n], p: per ? +per[0] : 0, d: days.length === 1 ? days[0] : 'Unknown', r: cells[ix.r] || '', t: cells[ix.t] || '', start: '', end: '' });
    });
  });
  return out;
}

function scheduleDates(html) {
  const $ = cheerio.load(html), dates = [];
  // Genesis's date picker emits date-specific onclick handlers. Extract only
  // date strings from those handlers; never guess school days from weekdays.
  $('[onclick]').each((_, el) => {
    const v = $(el).attr('onclick') || '';
    const patterns = [
      /ajaxGetBellScheduleForDate\(\s*['"][^'"]+['"]\s*,\s*['"](\d{1,2}\/\d{1,2}\/\d{4})['"]/i,
      /switchScheduleDate\(\s*['"][^'"]+['"]\s*,\s*['"](\d{1,2}\/\d{1,2}\/\d{4})['"]/i
    ];
    for (const pattern of patterns) { const m = v.match(pattern); if (m && !dates.includes(m[1])) dates.push(m[1]); }
    const id = ($(el).attr('id') || '').match(/^dateCell(\d{1,2}\/\d{1,2}\/\d{4})/i);
    if (id && !dates.includes(id[1])) dates.push(id[1]);
  });
  return dates;
}

function unwrapJsonHtml(body) {
  const raw = String(body || '').trim();
  if (!raw) return '';
  try { const parsed = JSON.parse(raw); if (typeof parsed === 'string') return parsed; } catch (_) {}
  return raw;
}

async function fetchLiveSchedule(g) {
  // Genesis renders the schedule in an AJAX fragment on Student Summary.
  // Fetch that exact endpoint instead of guessing at a normal schedule tab.
  const summary = await g.page('studentsummary', 'tab1=studentdata&tab2=studentsummary&action=form');
  const $ = cheerio.load(summary);
  const dateFromButton = scheduleDates(summary);
  const hiddenDate = clean($('[id^="scheduleDate"]').first().attr('value') || '');
  const scheduleDateMatch = summary.match(/ajaxGetBellScheduleForDate\(\s*['"][^'"]+['"]\s*,\s*['"](\d{1,2}\/\d{1,2}\/\d{4})['"]/i);
  const currentDate = (dateFromButton[0] || (scheduleDateMatch && scheduleDateMatch[1]) || '');
  let dates = [...dateFromButton];
  if (currentDate && !dates.includes(currentDate)) dates.unshift(currentDate);

  // Ask Genesis for the date-picker window, which usually exposes adjacent
  // school days. Responses are JSON-encoded HTML, so unwrap before parsing.
  if (hiddenDate) {
    // Match the page's own initial date-picker call (empty direction), then
    // inspect adjacent windows. The date picker can return a JSON string.
    for (const direction of ['', 'next', 'previous']) {
      try {
        const qs = new URLSearchParams({ tab1: 'studentdata', tab2: 'studentsummary', action: 'ajaxGetDatesForViewingSchedule', direction, lastDisplayDate: '', scheduleDate: hiddenDate, schedView: 'daily' });
        const body = await g.page('schedule_dates_' + (direction || 'initial'), qs.toString());
        const pickerHtml = unwrapJsonHtml(body);
        for (const d of scheduleDates(pickerHtml)) if (!dates.includes(d)) dates.push(d);
      } catch (e) { if (e.expired) throw e; }
    }
  }

  // Current date first, then a small number of adjacent dates to discover both
  // A and B templates without repeatedly hitting Genesis.
  if (currentDate) dates = [currentDate, ...dates.filter(d => d !== currentDate)];
  dates = dates.slice(0, 8);
  const merged = new Map();
  for (const date of dates) {
    try {
      const qs = new URLSearchParams({ tab1: 'studentdata', tab2: 'studentsummary', action: 'ajaxGetBellScheduleForDateJsp', scheduleDate: date, schedView: 'list', mpToView: '' });
      const html = await g.page('schedule_' + date.replace(/\//g, '-'), qs.toString());
      const parsed = parseSchedule(html);
      for (const item of parsed) {
        // Deduplicate repeated A/B templates by day + period + class. Keep the
        // first real time/room/teacher data from Genesis.
        const key = [item.d, item.periodLabel, norm(item.n)].join('|');
        if (!merged.has(key)) merged.set(key, item);
      }
      await sleep(100);
      // Once both day types have been observed, further date requests add little.
      const knownDays = new Set([...merged.values()].map(x => x.d).filter(x => x === 'A' || x === 'B'));
      if (knownDays.has('A') && knownDays.has('B')) break;
    } catch (e) { if (e.expired) throw e; }
  }
  return [...merged.values()];
}
const level = n => /\bAP\b|Advanced Placement/i.test(n) ? 'AP' : /Honors|\bHon\b/i.test(n) ? 'Honors' : 'CP';
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function pull(g) {                        // full sync -> Pathwise import JSON
  const gradebookHtml = await g.page('gradebook', 'tab1=studentdata&tab2=gradebook&tab3=weeklysummary&action=form');
  const gb = parseGradebook(gradebookHtml);
  if (!gb.length) {
    const e = new Error('Signed in to Genesis, but Pathwise could not recognize any classes in the gradebook.');
    if (DEBUG) e.debug = inspectGradebook(gradebookHtml);
    throw e;
  }
  let sched = [];
  try { sched = await fetchLiveSchedule(g); } catch (e) { if (e.expired) throw e; if (DEBUG) console.warn('[Pathwise] Schedule fetch failed:', e.message); }
  const courses = [];
  for (const c of gb) {
    await sleep(300);                                                           // gentle pacing between course pages
    let a = { items: [], weights: {} };
    try {
      // Plain-text Genesis gradebook layouts don't expose courseCode/courseSection
      // links. Do not request an assignment page without those identifiers.
      if (c.code && c.section) {
        const qs = new URLSearchParams({ tab1: 'studentdata', tab2: 'gradebook', tab3: 'coursesummary', action: 'form', courseCode: c.code, courseSection: c.section });
        if (c.mp) qs.set('mp', c.mp);
        a = parseAssignments(await g.page('assign_' + c.n, qs.toString()));
      }
    } catch (e) { if (e.expired) throw e; }
    const catNames = [...new Set(a.items.map(i => i.cat))];
    const eq = catNames.length ? Math.round(100 / catNames.length) : 0;        // fallback when Genesis doesn't expose weights
    const cats = catNames.map(cn => { const w = a.weights[cn] ?? eq; return { n: cn, w, gw: w, items: a.items.filter(i => i.cat === cn).map(i => ({ n: i.n, s: i.s, m: i.m, due: i.date || '', h: 0 })) }; });
    const cn = norm(c.n);
    const match = sched.find(x => norm(x.n) === cn) || sched.find(x => norm(x.n).includes(cn) || cn.includes(norm(x.n))); 
    const s = match || {};
    // Only assign the observed day to courses actually present in the returned daily schedule.
    // Missing courses are left unknown rather than inventing their A/B rotation.
    courses.push({ n: c.n, l: level(c.n), p: s.p || 1, d: s.d || 'Unknown', r: s.r || '', t: s.t || '', start: s.start || '', end: s.end || '', periodLabel: s.periodLabel || '', g: c.g, c: 1, cats });
  }
  if (!courses.length) throw new Error('Signed in to Genesis, but no classes could be imported.');
  return { name: g.name || undefined, accountKey: g.accountKey || undefined, school: 'sb', schedule: sched, courses, syncedAt: new Date().toISOString() };
}


module.exports = { Genesis, pull, parseGradebook, parseAssignments, parseSchedule, scheduleDates, inspectGradebook };
