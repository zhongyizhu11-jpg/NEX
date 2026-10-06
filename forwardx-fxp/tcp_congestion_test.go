package main

import "testing"

func TestResolveTCPCongestionPolicy(t *testing.T) {
	cases := []struct {
		configured, system, want string
	}{
		{"", "cubic", "bbr"},
		{"auto", "reno", "bbr"},
		{"", "bbr", ""},      // 已经是 bbr，不必每条连接再设
		{"", "bbr2", ""},     // 用户自选的算法不碰
		{"", "", ""},         // 读不到系统默认就不猜
		{"off", "cubic", ""}, // 明确关掉
		{"system", "cubic", ""},
		{"bbr", "cubic", "bbr"},
		{"BBR ", "cubic", "bbr"},
		{"bbr", "bbr", ""}, // 配置和系统默认一致
		{"cubic", "bbr", "cubic"},
	}
	for _, tc := range cases {
		if got := resolveTCPCongestion(tc.configured, tc.system); got != tc.want {
			t.Errorf("resolveTCPCongestion(%q, %q) = %q, want %q", tc.configured, tc.system, got, tc.want)
		}
	}
}
