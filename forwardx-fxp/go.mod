module github.com/zhongyizhu11-jpg/NEX/forwardx-fxp

go 1.24.0

require (
	github.com/klauspost/reedsolomon v1.12.4
	github.com/xtaci/kcp-go/v5 v5.6.72
	github.com/zhongyizhu11-jpg/NEX/lbcore v0.0.0
	golang.org/x/crypto v0.48.0
	golang.org/x/sys v0.41.0
	lukechampine.com/blake3 v1.4.1
)

require (
	github.com/klauspost/cpuid/v2 v2.2.8 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/tjfoc/gmsm v1.4.1 // indirect
	golang.org/x/net v0.49.0 // indirect
	golang.org/x/time v0.14.0 // indirect
)

// lbcore 是仓库里的另一个模块（线路组和出口组共用的挑选算法），不单独发版，直接用旁边的目录。
replace github.com/zhongyizhu11-jpg/NEX/lbcore => ../lbcore
