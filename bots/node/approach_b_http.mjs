// Approach B — Headless HTTP-direct sniper (Node, faster tier than Python).
//
// Same strategy as the Python version, but Node's event loop + V8 give a lower
// per-request overhead, so the release->hit number is typically tighter.
//
//   * keepAlive Agent so the "fire" socket is pooled & warm before the drop
//   * long-poll /status/longpoll; the instant it resolves, fire GET /buy on the
//     pooled (already-open) socket
//
// Run:  node bots/node/approach_b_http.mjs --trials 30

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.MOCK_HOST || '127.0.0.1';
const PORT = Number(process.env.MOCK_PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', '..', 'benchmark', 'results');

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const TRIALS = Number(getArg('--trials', 30));
const APPROACH = getArg('--approach', 'http-direct');
const LANG = getArg('--lang', 'node');

// One keepAlive agent => sockets are pooled and reused (pre-warmed).
const agent = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8 });

function req(pathname, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: HOST, port: PORT, path: pathname, method, agent,
        headers: body ? { 'Content-Type': 'application/json' } : {} },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)); }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function arm(trial) {
  await req('/control/arm', { method: 'POST',
    body: JSON.stringify({ approach: APPROACH, trial, baseDelayMs: 200, jitterMs: 300 }) });
}

async function trialOnce(trial) {
  await req('/health');                 // warm a pooled socket
  // Arm FIRST (resets -> ARMED, schedules a hidden release >=200ms out), THEN attach
  // the long-poll, so we never read a stale RELEASED state from the previous trial.
  await arm(trial);
  const detect = req('/status/longpoll');
  await detect;                          // resolves the instant the server releases
  const raw = await req(`/buy?approach=${APPROACH}&trial=${trial}`); // fire on warm pool
  const data = JSON.parse(raw);
  return data.ok ? Number(data.latency_ns) : null;
}

function summarize(name, ms) {
  const xs = [...ms].sort((a, b) => a - b);
  const p = (q) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(`\n${name}  (n=${xs.length})  server release->hit, milliseconds`);
  console.log(`  min ${xs[0].toFixed(3)}   median ${p(0.5).toFixed(3)}   ` +
              `p95 ${p(0.95).toFixed(3)}   max ${xs[xs.length - 1].toFixed(3)}   mean ${mean.toFixed(3)}`);
}

const rows = [];
for (let i = 0; i < TRIALS; i++) {
  const ns = await trialOnce(i);
  if (ns != null) rows.push({ approach: APPROACH, lang: LANG, trial: i, server_latency_ns: ns });
  await new Promise((r) => setTimeout(r, 30));
}

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const out = path.join(RESULTS_DIR, `${APPROACH}_${LANG}.csv`);
fs.writeFileSync(out,
  'approach,lang,trial,server_latency_ns,client_fire_ns\n' +
  rows.map((r) => `${r.approach},${r.lang},${r.trial},${r.server_latency_ns},`).join('\n') + '\n');

summarize(`${APPROACH} [${LANG}]`, rows.map((r) => r.server_latency_ns / 1e6));
console.log(`  wrote ${out}`);

agent.destroy();
