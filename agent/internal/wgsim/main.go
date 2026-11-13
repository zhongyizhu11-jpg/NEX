// Command wgsim 只给 forwardx-fxp/internal/linksim 的基准用（linksim rmem -wg），不进发布包。
//
// 在 linksim 的 nexsim-a / nexsim-b 命名空间里各起一块 wireguard-go 驱动的内核 TUN（nexsim-wa 10.232.0.1 /
// nexsim-wb 10.232.0.2），走 linksim 那条线（10.231.0.1 / .2 的 UDP 51820）。用来模拟 NEX V2 的内核数据面：
// FXP 跑在 WireGuard 地址上，隧道里的 TCP 是内核 TCP（BBR、tcp_rmem 都生效），只是加解密在用户态
// （开发机内核没有 wireguard 模块）。两端密钥由名字派生，固定不变。
//
//	cd agent && go build -o /tmp/wgsim ./internal/wgsim
//	ip netns exec nexsim-a /tmp/wgsim -side a    # linksim rmem 会自己这样起
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"

	"golang.org/x/crypto/curve25519"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
)

func key(side string) (priv, pub []byte) {
	sum := sha256.Sum256([]byte("nexsim-wg-" + side))
	priv = sum[:]
	priv[0] &= 248
	priv[31] = (priv[31] & 127) | 64
	pub, _ = curve25519.X25519(priv, curve25519.Basepoint)
	return
}

func run(args ...string) {
	if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "%v: %v %s\n", args, err, out)
		os.Exit(1)
	}
}

func main() {
	side := flag.String("side", "a", "a / b")
	mtu := flag.Int("mtu", 1420, "")
	flag.Parse()
	peer, dev, local, remote, endpoint := "b", "nexsim-wa", "10.232.0.1", "10.232.0.2", "10.231.0.2:51820"
	if *side == "b" {
		peer, dev, local, remote, endpoint = "a", "nexsim-wb", "10.232.0.2", "10.232.0.1", "10.231.0.1:51820"
	}
	priv, _ := key(*side)
	_, peerPub := key(peer)
	tdev, err := tun.CreateTUN(dev, *mtu)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	d := device.NewDevice(tdev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "wgsim: "))
	cfg := fmt.Sprintf("private_key=%s\nlisten_port=51820\npublic_key=%s\nendpoint=%s\nallowed_ip=%s/32\npersistent_keepalive_interval=25\n",
		hex.EncodeToString(priv), hex.EncodeToString(peerPub), endpoint, remote)
	if err := d.IpcSet(cfg); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := d.Up(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	run("ip", "addr", "add", local, "peer", remote, "dev", dev)
	run("ip", "link", "set", dev, "up")
	fmt.Println("wgsim up", dev, local, "->", remote)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	d.Close()
}
