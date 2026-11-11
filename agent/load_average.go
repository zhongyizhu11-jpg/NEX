package main

import (
	"math"
	"os"
	"strconv"
	"strings"
)

/*
系统平均负载（2.2.255 起随心跳和实时指标报 loadAverage）。

/proc/loadavg 的前三个数：1 / 5 / 15 分钟里在跑和在等（CPU、磁盘）的任务数的滑动平均。它不是百分比，
4 核的机器到 4 才算满，所以不和 cpuUsage 混在一起，面板只拿来展示。

不放进紧凑指标数组 m：m 里全是整数，面板按下标取、一律取整；负载是小数，而且可能整个没有。
读不到 /proc/loadavg 的平台（或内容不对）就不带这个字段 —— 面板看到没有就什么都不多画，
不拿 0 充数（0.00 是「完全空闲」，和「不知道」是两回事）。
*/

const loadAveragePath = "/proc/loadavg"

// 测试里替换
var readLoadAverageFile = func() ([]byte, error) {
	return os.ReadFile(loadAveragePath)
}

// parseLoadAverage 取 /proc/loadavg 的前三个数；不足三个、不是数、负数、NaN / Inf 都算读不到。
func parseLoadAverage(raw string) []float64 {
	fields := strings.Fields(raw)
	if len(fields) < 3 {
		return nil
	}
	values := make([]float64, 3)
	for i := range values {
		value, err := strconv.ParseFloat(fields[i], 64)
		if err != nil || value < 0 || math.IsNaN(value) || math.IsInf(value, 0) {
			return nil
		}
		values[i] = value
	}
	return values
}

func systemLoadAverage() []float64 {
	raw, err := readLoadAverageFile()
	if err != nil {
		return nil
	}
	return parseLoadAverage(string(raw))
}

// addLoadAverageReport 读得到负载就往上报里加 loadAverage: [1 分钟, 5 分钟, 15 分钟]；读不到就不加。
func addLoadAverageReport(payload map[string]any) {
	if values := systemLoadAverage(); len(values) == 3 {
		payload["loadAverage"] = values
	}
}
