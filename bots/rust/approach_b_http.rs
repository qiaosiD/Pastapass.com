// Approach B — Headless HTTP-direct sniper (Rust, absolute-floor tier).
//
// Deliberately std-only: no tokio/hyper/reqwest. Raw TcpStream + a hand-rolled minimal
// HTTP/1.1 client with TCP_NODELAY (Nagle off). This is the lowest-overhead runnable
// strategy in the repo — no async runtime, no framework, just sockets.
//
// Same shape as the Python/Node/Go versions:
//   * a warm "fire" socket, opened & kept idle before the drop
//   * long-poll /status/longpoll; the instant it returns, fire GET /buy on the warm socket
//
// Install Rust (not present yet):  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
// Build & run (std-only, no Cargo needed):
//   rustc -O bots/rust/approach_b_http.rs -o /tmp/rustbot && /tmp/rustbot --trials 30
//
// Output CSV: benchmark/results/http-direct_rust.csv

use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread;
use std::time::Duration;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 3000;

fn connect() -> TcpStream {
    let s = TcpStream::connect((HOST, PORT)).expect("connect failed (is the mock server running?)");
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

// Send a raw request and return the response body. Reuses a keep-alive socket cleanly
// by reading exactly Content-Length bytes.
fn round_trip(stream: &mut TcpStream, req: &str) -> String {
    stream.write_all(req.as_bytes()).expect("write");
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut tmp = [0u8; 2048];
    let header_end = loop {
        let n = stream.read(&mut tmp).expect("read");
        if n == 0 {
            return String::new();
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find(&buf, b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let headers = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let need = header_end + content_length(&headers);
    while buf.len() < need {
        let n = stream.read(&mut tmp).expect("read body");
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    String::from_utf8_lossy(&buf[header_end..need.min(buf.len())]).to_string()
}

fn get_req(path: &str) -> String {
    format!("GET {} HTTP/1.1\r\nHost: {}\r\nConnection: keep-alive\r\n\r\n", path, HOST)
}

fn arm(approach: &str, trial: usize) {
    let mut ctrl = connect();
    let body = format!(
        "{{\"approach\":\"{}\",\"trial\":{},\"baseDelayMs\":200,\"jitterMs\":300}}",
        approach, trial
    );
    let req = format!(
        "POST /control/arm HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{}",
        HOST, body.len(), body
    );
    round_trip(&mut ctrl, &req);
}

fn parse_latency_ms(json: &str) -> Option<f64> {
    // find "latency_ns":"<digits>"
    let key = "\"latency_ns\":\"";
    let start = json.find(key)? + key.len();
    let end = json[start..].find('"')? + start;
    let ns: f64 = json[start..end].parse().ok()?;
    Some(ns / 1e6)
}

fn trial_once(approach: &str, trial: usize) -> Option<f64> {
    let mut fire = connect();
    round_trip(&mut fire, &get_req("/health")); // warm the fire socket

    // Arm FIRST (resets -> ARMED, schedules a hidden release >=200ms out), THEN long-poll.
    arm(approach, trial);

    let mut detect = connect();
    round_trip(&mut detect, &get_req("/status/longpoll")); // blocks until release

    // FIRE on the pre-warmed socket.
    let body = round_trip(&mut fire, &get_req(&format!("/buy?approach={}&trial={}", approach, trial)));
    parse_latency_ms(&body)
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let get = |k: &str, d: &str| -> String {
        args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned().unwrap_or_else(|| d.to_string())
    };
    let trials: usize = get("--trials", "30").parse().unwrap_or(30);
    let approach = get("--approach", "http-direct");
    let lang = get("--lang", "rust");

    let mut ms: Vec<f64> = Vec::new();
    let mut rows: Vec<String> = Vec::new();
    for i in 0..trials {
        if let Some(v) = trial_once(&approach, i) {
            ms.push(v);
            rows.push(format!("{},{},{},{:.0},", approach, lang, i, v * 1e6));
        }
        thread::sleep(Duration::from_millis(30));
    }

    fs::create_dir_all("benchmark/results").ok();
    let out = format!("benchmark/results/{}_{}.csv", approach, lang);
    let csv = format!("approach,lang,trial,server_latency_ns,client_fire_ns\n{}\n", rows.join("\n"));
    fs::write(&out, csv).ok();

    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if !ms.is_empty() {
        let p = |q: f64| ms[((q * ms.len() as f64) as usize).min(ms.len() - 1)];
        let mean = ms.iter().sum::<f64>() / ms.len() as f64;
        println!("\n{} [{}]  (n={})  server release->hit, milliseconds", approach, lang, ms.len());
        println!(
            "  min {:.3}   median {:.3}   p95 {:.3}   max {:.3}   mean {:.3}",
            ms[0], p(0.5), p(0.95), ms[ms.len() - 1], mean
        );
    }
    println!("  wrote {}", out);
}
