// Approach B — Headless HTTP-direct sniper (Go, compiled tier).
//
// Go's compiled goroutine/net stack gives the lowest per-request overhead of the
// runnable options here — typically a tight release->hit distribution with a very
// low floor. Same strategy as the Python/Node versions:
//
//   * a keep-alive Transport so the "fire" socket is pooled & warm before the drop
//   * long-poll /status/longpoll; the instant it returns, fire GET /buy on the pool
//
// Install Go (not present on this machine yet):  https://go.dev/dl/
// Run:  go run bots/go/approach_b_http.go --trials 30
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var (
	host = envOr("MOCK_HOST", "127.0.0.1")
	port = envOr("MOCK_PORT", "3000")
)

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func base() string { return "http://" + host + ":" + port }

// One client with a keep-alive transport => pooled, pre-warmed sockets.
var client = &http.Client{
	Transport: &http.Transport{
		MaxIdleConns:        16,
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     60 * time.Second,
		DisableKeepAlives:   false,
	},
	Timeout: 35 * time.Second,
}

func get(path string) (string, error) {
	resp, err := client.Get(base() + path)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b), nil
}

func arm(approach string, trial int) error {
	body := fmt.Sprintf(`{"approach":%q,"trial":%d,"baseDelayMs":200,"jitterMs":300}`, approach, trial)
	resp, err := client.Post(base()+"/control/arm", "application/json", strings.NewReader(body))
	if err != nil {
		return err
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return nil
}

func trialOnce(approach string, trial int) (float64, bool) {
	get("/health") // warm a pooled socket

	// Arm FIRST (resets -> ARMED, schedules a hidden release >=200ms out), THEN attach
	// the long-poll in a goroutine, so we never read a stale RELEASED state.
	arm(approach, trial)
	done := make(chan string, 1)
	go func() { s, _ := get("/status/longpoll"); done <- s }()
	<-done // returns the instant the server releases

	raw, err := get(fmt.Sprintf("/buy?approach=%s&trial=%d", approach, trial))
	if err != nil {
		return 0, false
	}
	var data struct {
		Ok        bool   `json:"ok"`
		LatencyNs string `json:"latency_ns"`
	}
	if json.Unmarshal([]byte(raw), &data) != nil || !data.Ok {
		return 0, false
	}
	var ns float64
	fmt.Sscanf(data.LatencyNs, "%f", &ns)
	return ns / 1e6, true // -> ms
}

func main() {
	trials := flag.Int("trials", 30, "number of trials")
	approach := flag.String("approach", "http-direct", "approach label")
	lang := flag.String("lang", "go", "lang label")
	flag.Parse()

	var ms []float64
	var rows []string
	for i := 0; i < *trials; i++ {
		if v, ok := trialOnce(*approach, i); ok {
			ms = append(ms, v)
			rows = append(rows, fmt.Sprintf("%s,%s,%d,%.0f,", *approach, *lang, i, v*1e6))
		}
		time.Sleep(30 * time.Millisecond)
	}

	dir := filepath.Join("benchmark", "results")
	os.MkdirAll(dir, 0o755)
	out := filepath.Join(dir, fmt.Sprintf("%s_%s.csv", *approach, *lang))
	os.WriteFile(out, []byte("approach,lang,trial,server_latency_ns,client_fire_ns\n"+strings.Join(rows, "\n")+"\n"), 0o644)

	sort.Float64s(ms)
	if len(ms) > 0 {
		p := func(q float64) float64 { return ms[min(len(ms)-1, int(q*float64(len(ms))))] }
		sum := 0.0
		for _, v := range ms {
			sum += v
		}
		fmt.Printf("\n%s [%s]  (n=%d)  server release->hit, milliseconds\n", *approach, *lang, len(ms))
		fmt.Printf("  min %.3f   median %.3f   p95 %.3f   max %.3f   mean %.3f\n",
			ms[0], p(0.5), p(0.95), ms[len(ms)-1], sum/float64(len(ms)))
	}
	fmt.Printf("  wrote %s\n", out)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
