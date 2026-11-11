package main

import (
	"strconv"
	"strings"
)

/*
端口段规则（面板 shared/portRange.ts）：一条 iptables / nftables 规则转一整段端口。

命令是面板拼好下发的（server/agentActionCommands.ts），Agent 这边要做的是认得它们：

  - 就绪检查：nft 的 `dport 20000-20100`、iptables 的 `--dport 20000:20100`；目标同端口时 DNAT
    只写地址（`to 1.2.3.4` / `--to-destination 1.2.3.4`），平移时 iptables 是
    `ip:30000-30100/20000`，nft 引用命名映射表 `@fwx_pr_<规则>_<协议>`。
  - 计数：nft 计数器照旧按 fwx-rule-<id> 注释记；iptables 的计数链按整段匹配
    （`--ctorigdstport 20000:20100 --dport 30000:30100`），标记还是起始端口 fwx-stat-<起始端口>。
  - 快速转发（flowtable）不收段规则：它只把起始端口放进集合，段里其余端口的连接不会进快速路径，
    而一旦按 conntrack 计数，那些端口的流量就漏了。段规则留在普通路径，计数器看得到每个包。

单端口规则走的还是原来的代码，一个字节都不变。
*/

// runningRulePortEnd：段规则的最后一个端口；单端口（或面板没带）返回 0。
func runningRulePortEnd(rule runningRule) int {
	if rule.SourcePortEnd > rule.SourcePort && rule.SourcePort > 0 {
		return rule.SourcePortEnd
	}
	return 0
}

// portSpanEnd 把「0 = 单端口」统一成实际的最后一个端口。
func portSpanEnd(start int, end int) int {
	if end > start {
		return end
	}
	return start
}

// targetSpanEnd：目标段最后一个端口 = 目标起点 + 段长 - 1。
func targetSpanEnd(sourceStart int, sourceEnd int, targetStart int) int {
	return targetStart + portSpanEnd(sourceStart, sourceEnd) - sourceStart
}

func iptablesPortExpr(start int, end int) string {
	if end > start {
		return strconv.Itoa(start) + ":" + strconv.Itoa(end)
	}
	return strconv.Itoa(start)
}

func nftPortRangeMapName(ruleID int, proto string) string {
	return "fwx_pr_" + strconv.Itoa(ruleID) + "_" + proto
}

// kernelLineDportSpan 读出一行 nft / iptables 规则匹配的目的端口（段）。单端口时 end == start。
func kernelLineDportSpan(line string) (string, int, int, bool) {
	for _, proto := range []string{"tcp", "udp"} {
		if !strings.Contains(line, "-p "+proto+" ") && !strings.Contains(line, "meta l4proto "+proto) && !strings.Contains(line, proto+" dport ") {
			continue
		}
		for _, prefix := range []string{"--dport ", proto + " dport "} {
			idx := strings.Index(line, prefix)
			if idx < 0 {
				continue
			}
			fields := strings.Fields(strings.TrimSpace(line[idx+len(prefix):]))
			if len(fields) == 0 {
				continue
			}
			text := strings.Trim(fields[0], "[];,")
			startText, endText := text, ""
			if sep := strings.IndexAny(text, ":-"); sep > 0 {
				startText, endText = text[:sep], text[sep+1:]
			}
			start, err := strconv.Atoi(startText)
			if err != nil || start <= 0 || start > 65535 {
				continue
			}
			end := start
			if endText != "" {
				parsed, err := strconv.Atoi(endText)
				if err != nil || parsed < start || parsed > 65535 {
					continue
				}
				end = parsed
			}
			return proto, start, end, true
		}
	}
	return "", 0, 0, false
}

// kernelLineHasProtoDportSpan：这一行匹配的正好是这一段（单端口规则 end 传 0 或 start）。
func kernelLineHasProtoDportSpan(line string, proto string, start int, end int) bool {
	lineProto, lineStart, lineEnd, ok := kernelLineDportSpan(line)
	return ok && lineProto == strings.TrimSpace(proto) && lineStart == start && lineEnd == portSpanEnd(start, end)
}

// kernelLineDnatTargetToken 取 `--to-destination` / ` to ` 后面那一段原文。
func kernelLineDnatTargetToken(line string) (string, string, bool) {
	tail := line
	if idx := strings.Index(tail, "--to-destination "); idx >= 0 {
		tail = tail[idx+len("--to-destination "):]
	} else if idx := strings.Index(tail, " to "); idx >= 0 {
		tail = tail[idx+len(" to "):]
	} else {
		return "", "", false
	}
	fields := strings.Fields(tail)
	if len(fields) == 0 {
		return "", "", false
	}
	return strings.Trim(fields[0], "\"'`;"), tail, true
}

// kernelLineDnatRangeTargetMatches 核对段规则的 DNAT 目标：同端口只有地址，平移看偏移写法或映射表。
func kernelLineDnatRangeTargetMatches(line string, ruleID int, proto string, sourceStart int, sourceEnd int, targetIP string, targetStart int) bool {
	target := kernelCleanAddress(targetIP)
	token, tail, ok := kernelLineDnatTargetToken(strings.ToLower(line))
	if !ok {
		return false
	}
	if targetStart == sourceStart {
		return kernelCleanAddress(token) == target || target == ""
	}
	targetEnd := targetSpanEnd(sourceStart, sourceEnd, targetStart)
	// iptables：ip:30000-30100/20000，IPv6 带方括号。
	if slash := strings.LastIndex(token, "/"); slash > 0 {
		head := token[:slash]
		colon := strings.LastIndex(head, ":")
		if colon <= 0 {
			return false
		}
		wantPorts := strconv.Itoa(targetStart) + "-" + strconv.Itoa(targetEnd)
		return (target == "" || kernelCleanAddress(head[:colon]) == target) && head[colon+1:] == wantPorts && token[slash+1:] == strconv.Itoa(sourceStart)
	}
	// nft：1.2.3.4:tcp dport map @fwx_pr_<id>_tcp（IPv6 是 [addr]:tcp）。
	colon := strings.LastIndex(token, ":")
	if colon <= 0 || token[colon+1:] != proto {
		return false
	}
	if target != "" && kernelCleanAddress(token[:colon]) != target {
		return false
	}
	return strings.Contains(tail, "dport map @"+nftPortRangeMapName(ruleID, proto))
}

// nftPortRangeMapPresent：平移用的映射表还在（被人 flush 掉整张表时规则和表一起没了，规则那条会先报缺）。
func nftPortRangeMapPresent(text string, ruleID int, proto string) bool {
	return strings.Contains(text, "map "+nftPortRangeMapName(ruleID, proto)+" {")
}
