package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
)

// percentile 取 q 分位（q=1 是最大值）。空切片返回 0。
func percentile(samples []float64, q float64) float64 {
	if len(samples) == 0 {
		return 0
	}
	sorted := append([]float64(nil), samples...)
	sort.Float64s(sorted)
	idx := int(float64(len(sorted)) * q)
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

func median(samples []float64) float64 {
	if len(samples) == 0 {
		return 0
	}
	sorted := append([]float64(nil), samples...)
	sort.Float64s(sorted)
	mid := len(sorted) / 2
	if len(sorted)%2 == 0 {
		return (sorted[mid-1] + sorted[mid]) / 2
	}
	return sorted[mid]
}

// reportRecord 和 benchRecord 字段一样；report 在所有平台上都能跑，单独定义一份。
type reportRecord struct {
	Label   string     `json:"label"`
	RTTms   int        `json:"rttMs"`
	LossPct float64    `json:"lossPct"`
	Path    string     `json:"path"`
	Test    string     `json:"test"`
	Streams int        `json:"streams"`
	Result  loadResult `json:"result"`
}

type reportKey struct {
	RTTms   int
	LossPct float64
	Path    string
	Streams int
}

type reportCell struct {
	mbps    []float64
	samples []float64
	errors  int
}

func cmdReport(args []string) error {
	fs := flag.NewFlagSet("report", flag.ExitOnError)
	labelsFlag := fs.String("labels", "", "按这个顺序列出的标签（默认按文件里出现的顺序）")
	_ = fs.Parse(args)
	cells := map[string]map[reportKey]map[string]*reportCell{} // test → key → label → cell
	var labels []string
	seen := map[string]bool{}
	for _, file := range fs.Args() {
		f, err := os.Open(file)
		if err != nil {
			return err
		}
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 1<<20), 16<<20)
		for scanner.Scan() {
			var rec reportRecord
			if err := json.Unmarshal(scanner.Bytes(), &rec); err != nil {
				f.Close()
				return err
			}
			if !seen[rec.Label] {
				seen[rec.Label] = true
				labels = append(labels, rec.Label)
			}
			if cells[rec.Test] == nil {
				cells[rec.Test] = map[reportKey]map[string]*reportCell{}
			}
			key := reportKey{rec.RTTms, rec.LossPct, rec.Path, rec.Streams}
			if cells[rec.Test][key] == nil {
				cells[rec.Test][key] = map[string]*reportCell{}
			}
			cell := cells[rec.Test][key][rec.Label]
			if cell == nil {
				cell = &reportCell{}
				cells[rec.Test][key][rec.Label] = cell
			}
			cell.mbps = append(cell.mbps, rec.Result.Mbps)
			cell.errors += rec.Result.Errors
			cell.samples = append(cell.samples, rec.Result.DoneMs...)
			cell.samples = append(cell.samples, rec.Result.RTTMs...)
		}
		f.Close()
		if err := scanner.Err(); err != nil {
			return err
		}
	}
	if *labelsFlag != "" {
		labels = strings.Split(*labelsFlag, ",")
	}
	for _, test := range []string{"bulk", "fixed", "rpc", "rpc-shared"} {
		byKey := cells[test]
		if len(byKey) == 0 {
			continue
		}
		var keys []reportKey
		for key := range byKey {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(i, j int) bool {
			a, b := keys[i], keys[j]
			if a.RTTms != b.RTTms {
				return a.RTTms < b.RTTms
			}
			if a.LossPct != b.LossPct {
				return a.LossPct < b.LossPct
			}
			if a.Path != b.Path {
				return pathOrder(a.Path) < pathOrder(b.Path)
			}
			return a.Streams < b.Streams
		})
		switch test {
		case "bulk":
			fmt.Println("\n### bulk：总速率 Mbit/s（中位数）")
		case "fixed":
			fmt.Println("\n### fixed：每条流的完成时间 ms，p50 / p90 / 最大（所有轮次摊平）")
		case "rpc":
			fmt.Println("\n### rpc：一条下载跑着时，新开的一问一答连接的往返 ms，p50 / p99（下载速率 Mbit/s）")
		case "rpc-shared":
			fmt.Println("\n### rpc-shared：先开一问一答、紧接着开下载（复用时常在同一条会话上），往返 ms，p50 / p99（下载速率 Mbit/s）")
		}
		fmt.Printf("\n| 往返 | 丢包 | 路径 | 流数 | %s |\n", strings.Join(labels, " | "))
		fmt.Printf("| --- | --- | --- | --- |%s\n", strings.Repeat(" --- |", len(labels)))
		for _, key := range keys {
			var cols []string
			for _, label := range labels {
				cell := byKey[key][label]
				if cell == nil {
					cols = append(cols, "-")
					continue
				}
				var text string
				switch test {
				case "bulk":
					text = fmt.Sprintf("%.1f", median(cell.mbps))
				case "fixed":
					text = fmt.Sprintf("%.0f / %.0f / %.0f", percentile(cell.samples, 0.5), percentile(cell.samples, 0.9), percentile(cell.samples, 1))
				case "rpc", "rpc-shared":
					text = fmt.Sprintf("%.0f / %.0f (%.0f)", percentile(cell.samples, 0.5), percentile(cell.samples, 0.99), median(cell.mbps))
				}
				if cell.errors > 0 {
					text += fmt.Sprintf("（失败 %d）", cell.errors)
				}
				cols = append(cols, text)
			}
			fmt.Printf("| %dms | %g%% | %s | %d | %s |\n", key.RTTms, key.LossPct, key.Path, key.Streams, strings.Join(cols, " | "))
		}
	}
	return nil
}

func pathOrder(path string) int {
	for i, p := range []string{"direct", "v1", "v2", "v3-nomux", "v3-mux", "v3ws-nomux", "v3ws-mux"} {
		if p == path {
			return i
		}
	}
	return 100
}
