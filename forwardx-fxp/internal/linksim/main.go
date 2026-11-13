// Command linksim 是给 FXP 量「丢包 + 高延迟线路」用的用户态链路模拟器和压测驱动，只给测试 /
// 基准用，不进发布包。
//
// 为什么自己做：这台开发机的内核没有 netem（tc qdisc add ... netem 报 Specified qdisc kind is
// unknown）。linksim 用两个网络命名空间 + 两块 TUN 网卡搭一条「线路」：A 侧内核发往 B 的每个 IP 包
// 都从 A 的 TUN 读出来，在用户态按设定的单向延迟、随机丢包率、带宽上限（瓶颈队列，满了尾丢）处理，
// 再写进 B 的 TUN，反方向同理。两端跑的是真实的内核 TCP：重传、拥塞控制（BBR / CUBIC）、
// 接收窗口、TCP_NOTSENT_LOWAT 全是真的。
//
//	nexsim-a (10.231.0.1, nexsim-ta) ──TUN── linksim ──TUN── nexsim-b (10.231.0.2, nexsim-tb)
//	  压测客户端 + FXP 入口                      延迟 / 丢包 / 限速              FXP 出口 + 目标服务
//
// 只建、只删带 nexsim 前缀的命名空间和网卡，不碰机器上别的命名空间、网卡和进程。
//
// 子命令：
//
//	linksim up    -rtt 200ms -loss 0.5 -rate 200     建命名空间和线路，前台跑到 Ctrl-C，退出时清理
//	linksim down                                     清掉残留的 nexsim-a / nexsim-b（上次异常退出时）
//	linksim sink  -listen :7001                      目标服务（在 nexsim-b 里跑）：按请求下发 / 回声
//	linksim load  -addr 127.0.0.1:7100 -mode bulk    压测客户端（在 nexsim-a 里跑），结果打 JSON
//	linksim bench -fxp ./fxp -label before -out r.jsonl
//	                                                 整套矩阵：建线路 → 每个链路设定 × 每种路径
//	                                                 起 FXP 出口 / 入口 → 跑负载 → 记结果 → 清理
//	linksim report r.jsonl                           把结果汇总成 Markdown 表（中位数）
//	linksim rmem -fxp ./fxp -wg ./wgsim -out m.jsonl 对比 tcp_rmem 中间值（见 rmem_linux.go）
//	linksim rmem-report m.jsonl                      汇总 rmem 的结果
//
// 例：
//
//	cd forwardx-fxp
//	go build -o /tmp/fxp . && go build -o /tmp/linksim ./internal/linksim
//	sudo /tmp/linksim bench -fxp /tmp/fxp -label after -out /tmp/r.jsonl -runs 3
//	/tmp/linksim report /tmp/r.jsonl
//
// 手动用：`linksim up -rtt 200ms -loss 2 -rate 200` 跑着，另开终端
// `ip netns exec nexsim-b iperf3 -s` / `ip netns exec nexsim-a iperf3 -c 10.231.0.2`。
package main

import (
	"fmt"
	"os"
)

func usage() {
	fmt.Fprintln(os.Stderr, "usage: linksim up|down|sink|load|bench|report|rmem|rmem-report [flags]（见源码开头的说明）")
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	args := os.Args[2:]
	var err error
	switch os.Args[1] {
	case "up":
		err = cmdUp(args)
	case "down":
		err = cmdDown(args)
	case "sink":
		err = cmdSink(args)
	case "load":
		err = cmdLoad(args)
	case "bench":
		err = cmdBench(args)
	case "report":
		err = cmdReport(args)
	case "rmem":
		err = cmdRmem(args)
	case "rmem-report":
		err = cmdRmemReport(args)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "linksim:", err)
		os.Exit(1)
	}
}
