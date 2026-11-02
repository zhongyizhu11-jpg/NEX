//go:build race

package main

// raceDetectorEnabled：go test -race 时为 true。竞态检测把热路径拖慢好几倍，
// 只量吞吐、丢包下限的断言在这种模式下没有意义（每晚的 race 任务用得到）。
const raceDetectorEnabled = true
