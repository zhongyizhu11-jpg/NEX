package lbcore_test

import (
	"testing"

	"github.com/zhongyizhu11-jpg/NEX/lbcore/lbtest"
)

// 一致性用例先在 lbcore 自己身上成立；agent/ 和 forwardx-fxp/ 各有一个同名的测试拿真实的挑选入口跑同一批。
func TestConformance(t *testing.T) {
	lbtest.Run(t, lbtest.NewReference())
}

// 用例文件本身的底线：每个文件都读得出来，路线图点名的几种场景都在。
func TestConformanceCasesCoverTheRoadmap(t *testing.T) {
	cases, err := lbtest.Load()
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, c := range cases {
		names[c.Name] = true
	}
	for _, want := range []string{
		"weighted-60-30-10",
		"ip-hash-stable-when-a-member-leaves-and-returns",
		"least-load-burst-500-300-200",
		"fallback-dead-primary-unstable-backup",
		"all-down-last-resort",
		"admin-excluded-is-never-picked",
		"weighted-slow-start-ramp",
	} {
		if !names[want] {
			t.Errorf("少了用例 %s", want)
		}
	}
}
