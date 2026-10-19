package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/*
「挑哪个出口」这件事只能有一处说了算。

这一套东西是一点点长出来的：健康标记、冷却、退避、三档择优、后台探测 ——
它们全都挂在 dialSelectedSecureTCP 这一条路上。谁要是图省事在别处直接
dialSecureTCP，那条路就会**悄悄**拿不到其中任何一样：死节点不会被跳过、
不会退避、也不会被探回来。而它照样能跑通，测试也照样绿 —— 只是线上会
时不时卡十几秒。

这一类「A 改了 B 没跟上」这个仓库里已经踩到过不止一次，包括我自己：上一版
改完出口择优，就漏了 udp_direct.go 里那份自己抄的循环。所以这里直接把允许
直连的地方钉死，多出一处就红。
*/
func TestExitDialingStaysBehindTheSelector(t *testing.T) {
	// 允许直接调 dialSecureTCP 的地方，以及为什么。
	allowed := map[string]string{
		"main.go:dialSelectedSecureTCP":      "UDP-over-TCP 旧会话的择优入口（TCP 会话走 selectedTransport）",
		"main.go:dialSecureTCP":              "定义本身",
		"multipath_wire.go:dialMultipathLeg": "多路径的腿按配置一条条拨（开局和中途补拨都走它），不走出口择优",
	}

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || filepath.Ext(name) != ".go" || strings.HasSuffix(name, "_test.go") {
			continue
		}
		data, readErr := os.ReadFile(name)
		if readErr != nil {
			t.Fatal(readErr)
		}
		enclosing := ""
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "func ") {
				enclosing = functionNameFromDecl(line)
			}
			if !strings.Contains(line, "dialSecureTCP(") {
				continue
			}
			site := name + ":" + enclosing
			found[site] = true
			if _, ok := allowed[site]; !ok {
				t.Errorf("%s 绕过了出口择优直接拨号 —— 这条路拿不到健康标记、退避和后台探测，"+
					"死掉的出口会一直被派给用户连接。要么走 dialSelectedSecureTCP，"+
					"要么在本用例的名单里写清为什么不用走。", site)
			}
		}
	}

	// 名单只许缩不许涨：某处改名或删掉之后，名单里的死条目会让人以为还盯着。
	for site := range allowed {
		if !found[site] {
			t.Errorf("名单里的 %s 已经不存在了，把它删掉", site)
		}
	}
}

// functionNameFromDecl pulls the function name out of a top level declaration,
// including the method form "func (x *T) Name(".
func functionNameFromDecl(line string) string {
	rest := strings.TrimPrefix(line, "func ")
	if strings.HasPrefix(rest, "(") {
		if close := strings.Index(rest, ")"); close >= 0 {
			rest = strings.TrimSpace(rest[close+1:])
		}
	}
	if open := strings.IndexAny(rest, "([{"); open >= 0 {
		rest = rest[:open]
	}
	return strings.TrimSpace(rest)
}
