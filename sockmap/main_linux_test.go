//go:build linux

package sockmap

import (
	"log"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	// 模块默认关；测试里打开，没权限或内核不够的机器上各个用例自己跳过。
	_ = os.Setenv("NEX_SOCKMAP", "1")
	if os.Getenv("NEX_SOCKMAP_DEBUG") != "" {
		Logf = log.Printf
	}
	os.Exit(m.Run())
}
