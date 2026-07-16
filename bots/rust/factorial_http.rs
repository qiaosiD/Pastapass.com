// Parameterized HTTP-direct factorial runner (Rust, std-only) — the Rust twin of
// bots/python/factorial_http.py. connection {cold,warm} × mode {reactive,proactive}.
//
// Same hand-rolled minimal HTTP/1.1 client as approach_b_http.rs (raw TcpStream, no deps).
// Adds proactive firing: parse the launch instant from /control/arm, sleep to it, then fire
// (retrying if the server flips a hair late). On loopback both clocks are the SAME machine
// clock, so the offset is exactly 0 — no clock-sync round-trip needed.
//
// Build & run:
//   rustc -O bots/rust/factorial_http.rs -o /tmp/rf
//   MOCK_PORT=3997 /tmp/rf --connection cold --mode proactive --id RS-HD-CO-PX --trials 30
//
// Output CSV: benchmark/results/factorial/<id>.csv

use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn host() -> String { env::var("MOCK_HOST").unwrap_or_else(|_| "127.0.0.1".into()) }
fn port() -> u16 { env::var("MOCK_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(3000) }

fn connect() -> TcpStream {
    let s = TcpStream::connect((host().as_str(), port())).expect("connect failed (is the mock server running?)");
    s.set_nodelay(true).ok(); // Nagle off -> minimum latency
    s.set_read_timeout(Some(Duration::from_secs(35))).ok();
    s
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn content_length(headers: &str) -> usize {
    for line in headers.split("\r\n") {
        let l = line.to_ascii_lowercase();
        if let Some(rest) = l.strip_prefix("content-length:") {
            return rest.trim().parse().unwrap_or(0);
        }
    }
    0
}

fn round_trip(stream: &mut TcpStream, req: &str) -> String {
    stream.write_all(req.as_bytes()).expect("write");
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut tmp = [0u8; 2048];
    let header_end = loop {
        let n = stream.read(&mut tmp).expect("read");
        if n == 0 { return String::new(); }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find(&buf, b"\r\n\r\n") { break pos + 4; }
    };
    let headers = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let need = header_end + content_length(&headers);
    while buf.len() < need {
        let n = stream.read(&mut tmp).expect("read body");
        if n == 0 { break; }
        buf.extend_from_slice(&tmp[..n]);
    }
    String::from_utf8_lossy(&buf[header_end..need.min(buf.len())]).to_string()
}

fn get_req(path: &str) -> String {
    format!("GET {} HTTP/1.1\r\nHost: {}\r\nConnection: keep-alive\r\n\r\n", path, host())
}

fn arm(approach: &str, trial: usize, jitter: u32) -> Option<u64> {
    let mut ctrl = connect();
    let body = format!(
        "{{\"approach\":\"{}\",\"trial\":{},\"baseDelayMs\":250,\"jitterMs\":{}}}",
        approach, trial, jitter
    );
    let req = format!(
        "POST /control/arm HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{}",
        host(), body.len(), body
    );
    parse_launch_ms(&round_trip(&mut ctrl, &req))
}

fn parse_launch_ms(json: &str) -> Option<u64> {
    let key = "\"launch\":";
    let start = json.find(key)? + key.len();
    let rest = json[start..].trim_start();
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    rest[..end].parse().ok()
}

fn parse_latency_ms(json: &str) -> Option<f64> {
    let key = "\"latency_ns\":\"";
    let start = json.find(key)? + key.len();
    let end = json[start..].find('"')? + start;
    let ns: f64 = json[start..end].parse().ok()?;
    Some(ns / 1e6)
}

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 }

fn warm_socket() -> TcpStream {
    let mut f = connect();
    round_trip(&mut f, &get_req("/health")); // warm it: hot & idle BEFORE the drop
    f
}

fn run_trial(approach: &str, trial: usize, cold: bool, proactive: bool) -> Option<f64> {
    let buy = get_req(&format!("/buy?approach={}&trial={}", approach, trial));
    if !proactive {
        // REACTIVE: long-poll the signal; the instant it returns, fire.
        let mut warm = if cold { None } else { Some(warm_socket()) };
        arm(approach, trial, 300);
        let mut detect = connect();
        round_trip(&mut detect, &get_req("/status/longpoll")); // blocks until release
        let mut fire = if cold { connect() } else { warm.take().unwrap() }; // COLD: handshake in-window
        parse_latency_ms(&round_trip(&mut fire, &buy))
    } else {
        // PROACTIVE: sync to the launch instant and fire there (blind), retry if server flips late.
        let mut warm = if cold { None } else { Some(warm_socket()) };
        let launch = arm(approach, trial, 0)?; // jitter 0 -> a known launch instant
        loop {
            let now = now_ms();
            if now >= launch { break; }
            let dt = launch - now;
            if dt > 3 { thread::sleep(Duration::from_millis(dt - 3)); } // coarse-sleep, then spin
        }
        let mut fire = if cold { connect() } else { warm.take().unwrap() }; // COLD: open at the instant
        let t0 = now_ms();
        loop {
            if let Some(v) = parse_latency_ms(&round_trip(&mut fire, &buy)) { return Some(v); }
            if now_ms() - t0 > 150 { return None; }
            thread::sleep(Duration::from_micros(300));
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let get = |k: &str, d: &str| -> String {
        args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned().unwrap_or_else(|| d.to_string())
    };
    let connection = get("--connection", "warm");
    let mode = get("--mode", "reactive");
    let id = get("--id", "RS-HD-XX-XX");
    let trials: usize = get("--trials", "30").parse().unwrap_or(30);
    let lang = get("--lang", "rust");
    let cold = connection == "cold";
    let proactive = mode == "proactive";
    let approach = "http-direct";

    let mut ms: Vec<f64> = Vec::new();
    let mut rows: Vec<String> = Vec::new();
    for i in 0..trials {
        if let Some(v) = run_trial(approach, i, cold, proactive) {
            ms.push(v);
            rows.push(format!("{},{},{},{},{},{},{:.0}", id, lang, approach, connection, mode, i, v * 1e6));
        }
        thread::sleep(Duration::from_millis(30));
    }

    fs::create_dir_all("benchmark/results/factorial").ok();
    let out = format!("benchmark/results/factorial/{}.csv", id);
    let csv = format!("id,lang,transport,connection,mode,trial,server_latency_ns\n{}\n", rows.join("\n"));
    fs::write(&out, csv).ok();

    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if !ms.is_empty() {
        let p = |q: f64| ms[((q * ms.len() as f64) as usize).min(ms.len() - 1)];
        let mean = ms.iter().sum::<f64>() / ms.len() as f64;
        println!("{}  n={}  min {:.3}  median {:.3}  p95 {:.3}  mean {:.3}", id, ms.len(), ms[0], p(0.5), p(0.95), mean);
    }
    println!("  wrote {}", out);
}
