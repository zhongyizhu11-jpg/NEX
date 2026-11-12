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

type rampWindow struct {
	first5, first15, steady float64
	collapsed               bool
}

// rampWindows 从 ramp 的速率序列里算：前 5 秒、前 15 秒的平均，最后 5 秒（稳态）的平均，
// 以及「塌了」：前 15 秒平均低于带宽的 30%。
func rampWindows(res loadResult, rateMbps float64) rampWindow {
	step := float64(res.SeriesStepMs) / 1000
	if step <= 0 || len(res.SeriesMbps) == 0 {
		return rampWindow{}
	}
	avg := func(fromSec, toSec float64) float64 {
		sum, n := 0.0, 0
		for i, v := range res.SeriesMbps {
			t := float64(i) * step
			if t >= fromSec && t+step <= toSec+1e-9 {
				sum += v
				n++
			}
		}
		if n == 0 {
			return 0
		}
		return sum / float64(n)
	}
	total := float64(len(res.SeriesMbps)) * step
	w := rampWindow{first5: avg(0, 5), first15: avg(0, 15), steady: avg(total-5, total)}
	w.collapsed = rateMbps > 0 && w.first15 < 0.3*rateMbps
	return w
}

type rmemReportRecord struct {
	RTTms       int        `json:"rttMs"`
	LossPct     float64    `json:"lossPct"`
	RateMb      float64    `json:"rateMbps"`
	Path        string     `json:"path"`
	Test        string     `json:"test"`
	RmemDefault int        `json:"rmemDefault"`
	Result      loadResult `json:"result"`
}

type rmemKey struct {
	Rate    float64
	RTTms   int
	LossPct float64
	Path    string
}

type rmemCell struct {
	first5, first15, steady []float64
	collapsed, rampRuns     int
	rpcP50, rpcP99, rpcMbps []float64
	rpcCollapsed            int
	fixedRound, fixedP50    []float64
	errors                  int
}

func rmemLabel(v int) string {
	if v >= 1<<20 && v%(1<<20) == 0 {
		return fmt.Sprintf("%d MiB", v>>20)
	}
	return fmt.Sprintf("%d KiB", v>>10)
}

// cmdRmemReport 把 rmem 的结果汇总成 Markdown 表：每个格子是每次结果的中位数。
func cmdRmemReport(args []string) error {
	fs := flag.NewFlagSet("rmem-report", flag.ExitOnError)
	_ = fs.Parse(args)
	cells := map[rmemKey]map[int]*rmemCell{}
	rmemSeen := map[int]bool{}
	for _, file := range fs.Args() {
		f, err := os.Open(file)
		if err != nil {
			return err
		}
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 1<<20), 16<<20)
		for scanner.Scan() {
			var rec rmemReportRecord
			if err := json.Unmarshal(scanner.Bytes(), &rec); err != nil {
				f.Close()
				return err
			}
			key := rmemKey{rec.RateMb, rec.RTTms, rec.LossPct, rec.Path}
			if cells[key] == nil {
				cells[key] = map[int]*rmemCell{}
			}
			cell := cells[key][rec.RmemDefault]
			if cell == nil {
				cell = &rmemCell{}
				cells[key][rec.RmemDefault] = cell
			}
			rmemSeen[rec.RmemDefault] = true
			cell.errors += rec.Result.Errors
			switch rec.Test {
			case "ramp":
				w := rampWindows(rec.Result, rec.RateMb)
				cell.first5 = append(cell.first5, w.first5)
				cell.first15 = append(cell.first15, w.first15)
				cell.steady = append(cell.steady, w.steady)
				cell.rampRuns++
				if w.collapsed {
					cell.collapsed++
				}
			case "rpc":
				cell.rpcP50 = append(cell.rpcP50, percentile(rec.Result.RTTMs, 0.5))
				cell.rpcP99 = append(cell.rpcP99, percentile(rec.Result.RTTMs, 0.99))
				cell.rpcMbps = append(cell.rpcMbps, rec.Result.Mbps)
				// 不复用时 rpc 里那条下载也是新连接（第 3–10 秒）：同样记「塌」
				if rec.RateMb > 0 && rec.Result.Mbps < 0.3*rec.RateMb {
					cell.rpcCollapsed++
				}
			case "fixed":
				cell.fixedRound = append(cell.fixedRound, rec.Result.RoundMs...)
				cell.fixedP50 = append(cell.fixedP50, percentile(rec.Result.DoneMs, 0.5))
			}
		}
		f.Close()
		if err := scanner.Err(); err != nil {
			return err
		}
	}
	var rmems []int
	for v := range rmemSeen {
		rmems = append(rmems, v)
	}
	sort.Ints(rmems)
	var keys []rmemKey
	for key := range cells {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if a.Rate != b.Rate {
			return a.Rate < b.Rate
		}
		if a.RTTms != b.RTTms {
			return a.RTTms < b.RTTms
		}
		if a.LossPct != b.LossPct {
			return a.LossPct < b.LossPct
		}
		return pathOrder(a.Path) < pathOrder(b.Path)
	})
	var heads []string
	for _, v := range rmems {
		heads = append(heads, rmemLabel(v))
	}
	table := func(title string, format func(*rmemCell) string) {
		fmt.Printf("\n%s\n\n| 带宽 | 往返 | 丢包 | 路径 | %s |\n| --- | --- | --- | --- |%s\n", title, strings.Join(heads, " | "), strings.Repeat(" --- |", len(heads)))
		for _, key := range keys {
			var cols []string
			for _, v := range rmems {
				cell := cells[key][v]
				if cell == nil {
					cols = append(cols, "-")
					continue
				}
				text := format(cell)
				if cell.errors > 0 {
					text += fmt.Sprintf("（失败 %d）", cell.errors)
				}
				cols = append(cols, text)
			}
			fmt.Printf("| %g | %d ms | %g%% | %s | %s |\n", key.Rate, key.RTTms, key.LossPct, key.Path, strings.Join(cols, " | "))
		}
	}
	table("#### 新连接：前 5 秒 / 前 15 秒 / 最后 5 秒的平均 Mbit/s（中位数），塌掉的次数", func(c *rmemCell) string {
		if c.rampRuns == 0 {
			return "-"
		}
		return fmt.Sprintf("%.0f / %.0f / %.0f（塌 %d/%d）", median(c.first5), median(c.first15), median(c.steady), c.collapsed, c.rampRuns)
	})
	table("#### 下载跑着时新开的一问一答：往返 p50 / p99 ms（每次的分位数取中位数），括号里是那条下载第 3–10 秒的 Mbit/s 中位数，和它低于带宽 30% 的次数", func(c *rmemCell) string {
		if len(c.rpcP50) == 0 {
			return "-"
		}
		return fmt.Sprintf("%.0f / %.0f（%.0f，塌 %d/%d）", median(c.rpcP50), median(c.rpcP99), median(c.rpcMbps), c.rpcCollapsed, len(c.rpcMbps))
	})
	table("#### 多流：每轮 16 条流同时各下载 2 MiB，一轮全部收完的时间 ms，中位数 / 最大（括号里是单条流完成时间 p50 的中位数）", func(c *rmemCell) string {
		if len(c.fixedRound) == 0 {
			return "-"
		}
		return fmt.Sprintf("%.0f / %.0f（%.0f）", median(c.fixedRound), percentile(c.fixedRound, 1), median(c.fixedP50))
	})
	return nil
}
