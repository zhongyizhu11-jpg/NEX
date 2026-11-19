package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

/*
A14：FXP 出口事件的正则要对得上 FXP 现在打的日志。

testdata/fxp_endpoint_log_sample.txt 里是从 forwardx-fxp/endpoint_pool.go 抄来的四行格式串（出口本身两行、UDP 那一侧两行）。这里拿它们按 FXP 的
写法拼出日志行喂给解析；仓库里看得到 FXP 的源码时，再核对那两行格式串还在里面 —— FXP 改了日志而没改这边，
这个测试就会红。UDP 那一侧的两行以前不认，UDP 中断从来不进面板的出口事件。
*/
func TestFXPEndpointEventsMatchCurrentFXPLogFormat(t *testing.T) {
	file, err := os.Open(filepath.Join("testdata", "fxp_endpoint_log_sample.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	formats := []string{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		formats = append(formats, line)
	}
	if len(formats) != 4 || !strings.HasPrefix(formats[0], "exit endpoint unhealthy ") || !strings.HasPrefix(formats[1], "exit endpoint recovered ") ||
		!strings.HasPrefix(formats[2], "exit endpoint udp unreachable ") || !strings.HasPrefix(formats[3], "exit endpoint udp recovered ") {
		t.Fatalf("样本应当是「unhealthy」「recovered」「udp unreachable」「udp recovered」四行格式串：%q", formats)
	}
	if source, err := os.ReadFile(filepath.Join("..", "forwardx-fxp", "endpoint_pool.go")); err == nil {
		for _, format := range formats {
			if !strings.Contains(string(source), `"`+format+`"`) {
				t.Fatalf("forwardx-fxp/endpoint_pool.go 里已经没有这行日志格式了：%q —— 同步改 testdata/fxp_endpoint_log_sample.txt 和 fxpEndpointLogPattern", format)
			}
		}
	}

	fxpEndpointEventMu.Lock()
	saved := fxpEndpointEvents
	fxpEndpointEvents = map[string]fxpEndpointEvent{}
	fxpEndpointEventMu.Unlock()
	t.Cleanup(func() {
		fxpEndpointEventMu.Lock()
		fxpEndpointEvents = saved
		fxpEndpointEventMu.Unlock()
	})
	spec := fxpSpec{Role: "entry", TunnelID: 3, RuleID: 8}
	const endpoint = "203.0.113.8:62444"
	// FXP 用 log.Printf：前面带日期时间
	unhealthy := "2026/11/18 12:00:00 " + fmt.Sprintf(formats[0], 1, endpoint, 5*time.Second, errors.New("dial tcp 203.0.113.8:62444: i/o timeout"))
	recordFXPEndpointLog(spec, unhealthy)
	events := fxpEndpointEventsSnapshot()
	if len(events) != 1 || events[0].Status != "unhealthy" || events[0].Endpoint != endpoint || !strings.Contains(events[0].Message, "i/o timeout") || strings.Contains(events[0].Message, "retryIn") {
		t.Fatalf("现行格式的「出口异常」没解析对（%q）：%#v", unhealthy, events)
	}
	startedAt := events[0].StartedAt
	recordFXPEndpointLog(spec, "2026/11/18 12:00:07 "+fmt.Sprintf(formats[1], 1, endpoint))
	events = fxpEndpointEventsSnapshot()
	if len(events) != 1 || events[0].Status != "recovered" || events[0].Endpoint != endpoint || events[0].StartedAt != startedAt {
		t.Fatalf("现行格式的「出口恢复」没解析对：%#v", events)
	}
	// UDP 那一侧：照样报成 unhealthy / recovered，带 Side=udp，和出口本身分开记（不覆盖上面那条）。
	recordFXPEndpointLog(spec, "2026/11/18 12:01:00 "+fmt.Sprintf(formats[2], 1, endpoint, errors.New("no pong for 3 rounds")))
	var udpEvent, tcpEvent fxpEndpointEvent
	for _, event := range fxpEndpointEventsSnapshot() {
		if event.Endpoint != endpoint {
			continue
		}
		if event.Side == fxpEndpointSideUDP {
			udpEvent = event
		} else {
			tcpEvent = event
		}
	}
	if udpEvent.Status != "unhealthy" || !strings.HasPrefix(udpEvent.Message, "udp: ") || !strings.Contains(udpEvent.Message, "no pong") || tcpEvent.Status != "recovered" {
		t.Fatalf("UDP 那一侧的「不通」没解析对，或者覆盖了出口本身的状态：udp=%#v tcp=%#v", udpEvent, tcpEvent)
	}
	udpStartedAt := udpEvent.StartedAt
	recordFXPEndpointLog(spec, "2026/11/18 12:01:09 "+fmt.Sprintf(formats[3], 1, endpoint))
	for _, event := range fxpEndpointEventsSnapshot() {
		if event.Endpoint == endpoint && event.Side == fxpEndpointSideUDP {
			udpEvent = event
		}
	}
	if udpEvent.Status != "recovered" || udpEvent.StartedAt != udpStartedAt || udpEvent.Message != "udp" {
		t.Fatalf("UDP 那一侧的「恢复」没解析对：%#v", udpEvent)
	}
	// 同一段里别的 UDP 日志（「开始回 ping 了」「从没回过 ping」）不是状态变化，不认。
	before := len(fxpEndpointEventsSnapshot())
	recordFXPEndpointLog(spec, "exit endpoint answers udp pings now index=1 endpoint=192.0.2.9:1\nexit endpoint never answered a udp ping index=1 endpoint=192.0.2.9:1: peer runs an outdated FXP")
	if after := len(fxpEndpointEventsSnapshot()); after != before {
		t.Fatalf("不是状态变化的 UDP 日志被当成了事件：%d → %d", before, after)
	}
	// 老版本 FXP 的格式（带 index=N）照样认
	recordFXPEndpointLog(spec, "exit endpoint unhealthy index=1 endpoint=198.51.100.2:62444 reason=refused")
	found := false
	for _, event := range fxpEndpointEventsSnapshot() {
		if event.Endpoint == "198.51.100.2:62444" && event.Status == "unhealthy" && event.Message == "refused" {
			found = true
		}
	}
	if !found {
		t.Fatal("带 index= 的老格式也要认")
	}
}
