// mock-site/server.js
//
// Zero-dependency mock "drop" site + timing authority for benchmarking sniper bots.
//   Run:  node mock-site/server.js        (listens on 127.0.0.1:3000)
//
// WHY THIS EXISTS
// ---------------
// We want to A/B test several bot strategies by how fast they can hit a "BUY" the
// instant it goes live. The hard part of that measurement is CLOCK SYNC: comparing a
// timestamp taken on the bot's machine to one taken on the server is meaningless at
// the microsecond scale. So this server is the SINGLE CLOCK OF RECORD:
//
//   * it stamps t_release the moment it makes the button live
//   * it stamps t_hit     the moment the /buy request lands
//   * latency = t_hit - t_release   (both from process.hrtime.bigint(), monotonic ns,
//                                    in ONE process => no cross-machine sync error)
//
// Every approach ultimately calls the same /buy endpoint, so the number is directly
// comparable across Python / Node / Go / browser / raw-socket strategies.
//
// The release moment is JITTERED and never told to the bot, so a strategy has to truly
// react to the signal rather than predict the clock.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

// ---- State machine ---------------------------------------------------------
const STATE = { IDLE: 'IDLE', ARMED: 'ARMED', RELEASED: 'RELEASED' };
let state = STATE.IDLE;
let tRelease = null;          // bigint ns, set exactly at the drop
let releaseTimer = null;
let meta = { approach: null, trial: null };

const pendingLongpolls = new Set(); // res objects held open until release (HTTP bots)
const sseClients = new Set();       // res objects for Server-Sent Events (browser bots)
const results = [];                 // [{approach, trial, latency_ns, t_release_ns, t_hit_ns}]
let lastResult = null;

const nowNs = () => process.hrtime.bigint();

function resetToIdle() {
  state = STATE.IDLE;
  tRelease = null;
  if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
}

// Called exactly at the (hidden, jittered) drop moment.
function doRelease() {
  releaseTimer = null;
  tRelease = nowNs();               // <-- authoritative release timestamp
  state = STATE.RELEASED;
  const payload = JSON.stringify({ released: true, t_release_ns: tRelease.toString() });

  // Wake every waiting HTTP long-poll at once.
  for (const res of pendingLongpolls) {
    try { res.writeHead(200, jsonHeaders()); res.end(payload); } catch (_) {}
  }
  pendingLongpolls.clear();

  // Push to every SSE (browser) client.
  for (const res of sseClients) {
    try { res.write(`event: release\ndata: ${payload}\n\n`); } catch (_) {}
  }
}

// ---- helpers ---------------------------------------------------------------
function jsonHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
  };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, jsonHeaders());
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// ---- router ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // NOTE: for /buy we must timestamp before ANY other work.
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') { res.writeHead(204, jsonHeaders()); return res.end(); }

  // -------- /buy : the thing every approach races to hit --------------------
  if (p === '/buy') {
    const tHit = nowNs();                       // stamp FIRST
    if (state !== STATE.RELEASED || tRelease === null) {
      return sendJson(res, 409, { ok: false, error: 'not-released' }); // fired too early
    }
    const latency = tHit - tRelease;
    const rec = {
      approach: url.searchParams.get('approach') || meta.approach || 'unknown',
      trial: Number(url.searchParams.get('trial') ?? meta.trial ?? -1),
      latency_ns: latency.toString(),
      t_release_ns: tRelease.toString(),
      t_hit_ns: tHit.toString(),
    };
    results.push(rec);
    lastResult = rec;
    return sendJson(res, 200, { ok: true, latency_ns: latency.toString() });
  }

  // -------- /status/longpoll : HTTP bots block here until release -----------
  if (p === '/status/longpoll') {
    if (state === STATE.RELEASED && tRelease !== null) {
      return sendJson(res, 200, { released: true, t_release_ns: tRelease.toString() });
    }
    pendingLongpolls.add(res);
    // Safety valve so a bot never hangs forever if a run is abandoned.
    const safety = setTimeout(() => {
      if (pendingLongpolls.delete(res)) {
        try { sendJson(res, 200, { released: false, timeout: true }); } catch (_) {}
      }
    }, 30000);
    req.on('close', () => { clearTimeout(safety); pendingLongpolls.delete(res); });
    return;
  }

  // -------- /events : SSE stream for browser bots ---------------------------
  if (p === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    // NOTE: we deliberately do NOT replay a prior release to a newly-connected client.
    // A sniper must only react to a release that happens AFTER it is listening;
    // replaying stale state would fire /buy against an old t_release (huge bogus latency).
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // -------- /control/arm : schedule a hidden, jittered release --------------
  if (p === '/control/arm' && method === 'POST') {
    const body = await readJson(req);
    resetToIdle();
    state = STATE.ARMED;
    meta = { approach: body.approach ?? null, trial: body.trial ?? null };
    const base = Number(body.baseDelayMs ?? 200);
    const jitter = Number(body.jitterMs ?? 300);
    const delay = base + Math.random() * jitter;   // hidden from the bot
    releaseTimer = setTimeout(doRelease, delay);
    return sendJson(res, 200, { ok: true, state });
  }

  // -------- /control/reset --------------------------------------------------
  if (p === '/control/reset' && method === 'POST') {
    resetToIdle();
    results.length = 0;
    lastResult = null;
    return sendJson(res, 200, { ok: true });
  }

  // -------- introspection ---------------------------------------------------
  if (p === '/control/state') return sendJson(res, 200, { state, armedListeners: pendingLongpolls.size + sseClients.size });
  if (p === '/results/last') return sendJson(res, 200, lastResult || {});
  if (p === '/results') return sendJson(res, 200, results);
  if (p === '/health') return sendJson(res, 200, { ok: true });

  // -------- static page -----------------------------------------------------
  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(INDEX_HTML);
  }

  res.writeHead(404, jsonHeaders());
  res.end(JSON.stringify({ error: 'not-found' }));
});

// Long-polls hold the response open; disable Node's request timeout so they don't get cut.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 60000;

server.listen(PORT, HOST, () => {
  console.log(`[mock] MockPasta timing server on http://${HOST}:${PORT}`);
  console.log(`[mock] endpoints: / (page)  /events (SSE)  /status/longpoll  /buy  /control/arm  /results`);
});
