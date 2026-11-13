package main

type exitEndpoint struct {
	Host    string `json:"host"`
	Port    int    `json:"port"`
	UDPPort int    `json:"udpPort,omitempty"`
	Key     string `json:"key,omitempty"`
	// Weight 只在出口策略是 weighted 时用：新连接按它分。没写（旧面板）按 1 算。
	Weight int `json:"weight,omitempty"`
	// CapacityMbps 是出口主机的线路带宽，「按负载」「按访客固定」按它折算每台该分多少。没写按一样大。
	CapacityMbps int `json:"capacityMbps,omitempty"`
	// lossTolerant 不上线：拨这个端点用不用抗丢包传输（跟着规则 / 中转的 LossTolerant）。
	lossTolerant bool
	// transport 不上线：V3 的外层选项（v3TransportIdentity），V1 / V2 为空。选项不同的
	// 同一个出口是两份端点状态 —— 预热好的连接是按外层选项握的手，不能混用。
	transport string
}

// udpTarget is deliberately configured on the exit runtime. UDP direct packets
// never carry a destination, so a valid tunnel key cannot be used as an
// arbitrary UDP relay.
type udpTarget struct {
	RuleID     int    `json:"ruleId"`
	TargetIP   string `json:"targetIp"`
	TargetPort int    `json:"targetPort"`
}

// streamTarget 是出口允许按 hello 拨出去的一个目标（TCP，以及走 TCP 流的
// UDP）。hello 里的目标是入口写的，出口只认面板给它的这张表：握手只证明对端
// 知道隧道密钥，不能让它把出口当成随便拨哪儿的跳板。一条规则可以有几项
// （规则目标的域名和解析出的 IP、线路组的路径 A、出口本机的调度器）。
type streamTarget struct {
	RuleID     int    `json:"ruleId"`
	TargetIP   string `json:"targetIp"`
	TargetPort int    `json:"targetPort"`
}

// multipathLeg is one parallel path from the entry to the exit: either a direct
// dial to the exit, or a dial to a relay front that forwards on to it.
type multipathLeg struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	Key  string `json:"key,omitempty"`
	// Via labels the leg for logs, e.g. "direct" or a relay host name.
	Via string `json:"via,omitempty"`
	// CapacityMbps 是这一路（中转主机）的线路带宽：还没测出快慢之前，按它给各路分份额，
	// 起速更快；测出来以后以实测为准。没写就和以前一样，从 1 MiB 起步慢慢量。
	CapacityMbps int `json:"capacityMbps,omitempty"`
	// Standby（2.2.137 起）：热备腿。连上、握好手、一直挂着，但只要还有一条非热备的腿活着
	// 而且在往前走，它就不分片；主腿断了、或者压着数据几百毫秒没见回执，热备腿立刻接
	// 上 —— 连接不断，客户端最多感觉到一下顿。主腿回来了就又让回去。老 FXP 不认识这个
	// 字段，把它当普通的叠加腿用，照样能通。
	Standby bool `json:"standby,omitempty"`
}

type config struct {
	Role                     string         `json:"role"`
	Entries                  []config       `json:"entries,omitempty"`
	TunnelID                 int            `json:"tunnelId"`
	RuleID                   int            `json:"ruleId"`
	ListenPort               int            `json:"listenPort"`
	UDPListenPort            int            `json:"udpListenPort,omitempty"`
	ListenHost               string         `json:"listenHost,omitempty"`
	Protocol                 string         `json:"protocol"`
	ExitHost                 string         `json:"exitHost"`
	ExitPort                 int            `json:"exitPort"`
	UDPExitPort              int            `json:"udpExitPort,omitempty"`
	Exits                    []exitEndpoint `json:"exits,omitempty"`
	ExitStrategy             string         `json:"exitStrategy,omitempty"`
	TargetIP                 string         `json:"targetIp"`
	TargetPort               int            `json:"targetPort"`
	UDPTargets               []udpTarget    `json:"udpTargets,omitempty"`
	StreamTargets            []streamTarget `json:"streamTargets,omitempty"`
	Key                      string         `json:"key"`
	LimitIn                  int64          `json:"limitIn"`
	LimitOut                 int64          `json:"limitOut"`
	MaxConnections           int            `json:"maxConnections"`
	MaxIPs                   int            `json:"maxIPs"`
	AccessScope              string         `json:"accessScope"`
	BlockHTTP                bool           `json:"blockHttp"`
	BlockSocks               bool           `json:"blockSocks"`
	BlockTLS                 bool           `json:"blockTls"`
	ProxyProtocolReceive     bool           `json:"proxyProtocolReceive"`
	ProxyProtocolSend        bool           `json:"proxyProtocolSend"`
	ProxyProtocolExitReceive bool           `json:"proxyProtocolExitReceive"`
	ProxyProtocolExitSend    bool           `json:"proxyProtocolExitSend"`
	ProxyProtocolVersion     int            `json:"proxyProtocolVersion"`
	TCPFastOpen              bool           `json:"tcpFastOpen"`
	// TCPCongestion 是给 FXP 自己收发的每条 TCP 连接设的拥塞控制算法：空 / auto
	// 表示系统默认是 cubic、reno 时换成 bbr；off 表示保持系统默认；也可以直接写
	// 算法名。见 tcp_congestion.go。
	TCPCongestion string `json:"tcpCongestion,omitempty"`
	// AEAD 是帧加密算法：空 / auto 按本机实测（没有 AES 硬件时偏好 ChaCha20），
	// 也可以写 aes-gcm 或 chacha20-poly1305。两端握手时协商，见 aead.go。
	AEAD string `json:"aead,omitempty"`
	// 链路整形（见 link_shaper.go）。LinkShaping 是档位：auto 自动识别限速点、
	// manual 按下面的上限整形、off 关；没写（旧面板）时填了上限就是 manual。
	// LinkUpMbps / LinkDownMbps 是手动模式的上限（Mbit/s）：入口→出口（上行）和
	// 出口→入口（下行）。LinkUpHintMbps / LinkDownHintMbps 是自动模式的提示值：
	// 面板记住的上次学到的限速点，本机没有记录时从它起步。
	LinkShaping      string `json:"linkShaping,omitempty"`
	LinkUpMbps       int    `json:"linkUpMbps,omitempty"`
	LinkDownMbps     int    `json:"linkDownMbps,omitempty"`
	LinkUpHintMbps   int    `json:"linkUpHintMbps,omitempty"`
	LinkDownHintMbps int    `json:"linkDownHintMbps,omitempty"`
	// 主机公网出口整形（也在 link_shaper.go）：这台机器往客户端、往目标发的所有明文
	// 流量合起来整形到公网带宽上限之下，机房的限速器不再丢包。档位同上，EgressMbps
	// 是手动上限，EgressHintMbps 是自动模式的提示值。整台机器一个，入口组里写在任一
	// 条目上都行。
	EgressShaping    string `json:"egressShaping,omitempty"`
	EgressMbps       int    `json:"egressMbps,omitempty"`
	EgressHintMbps   int    `json:"egressHintMbps,omitempty"`
	PanelURL         string `json:"panelUrl"`
	Token            string `json:"token"`
	RelayExitHost    string `json:"relayExitHost,omitempty"`
	RelayExitPort    int    `json:"relayExitPort,omitempty"`
	UDPRelayExitPort int    `json:"udpRelayExitPort,omitempty"`
	RelayKey         string `json:"relayKey,omitempty"`
	DNSGeneration    int    `json:"dnsGeneration,omitempty"`
	// Single-connection multipath aggregation. When enabled the entry stripes
	// one client connection over every leg and the exit reassembles it.
	MultipathEnabled    bool           `json:"multipathEnabled,omitempty"`
	MultipathLegs       []multipathLeg `json:"multipathLegs,omitempty"`
	MultipathMaxPending int            `json:"multipathMaxPending,omitempty"`
	// MultipathReplicate：复制模式（见 helloFrame.MultipathReplicate），用带宽换可靠。
	MultipathReplicate bool `json:"multipathReplicate,omitempty"`
	// TransportVersion 是 Agent 写进来的隧道传输版本（v1 / v2 / v3）。v2 决定 UDP 单包上限；
	// v3 让下一跳的 TCP 承载换成 V3 传输（见 v3_transport.go）。
	TransportVersion string `json:"transportVersion,omitempty"`
	// V3 传输的外层选项（只在 transportVersion 是 v3 时有意义，其它版本写了就拒）：
	// V3Transport 是外层 http / ws / tls；V3Host 填了就在 HTTP 请求里带 Host 头；
	// V3Path 是请求路径（两端必须一致，出口按它核对）；V3UserAgent 是 User-Agent；
	// V3ServerName 是 TLS 的 SNI（留空不发）；V3Multiplex 是多条业务连接共用一条
	// 物理连接，没写按开（和上游一致），NEX 面板总是显式写。
	V3Transport  string `json:"v3Transport,omitempty"`
	V3Host       string `json:"v3Host,omitempty"`
	V3Path       string `json:"v3Path,omitempty"`
	V3UserAgent  string `json:"v3UserAgent,omitempty"`
	V3ServerName string `json:"v3ServerName,omitempty"`
	V3Multiplex  *bool  `json:"v3Multiplex,omitempty"`
	// UDPWirePacketSize 显式覆盖 UDP 单包上限（字节），0 表示按传输版本取默认值。
	UDPWirePacketSize int `json:"udpWirePacketSize,omitempty"`
	// UDPFEC 是隧道的「抗丢包」开关：UDP 直连额外发 Reed-Solomon 冗余包，接收端
	// 丢了几个包能当场补回来（见 udp_fec.go）。默认关；两端都打开才有效果，
	// 对端是旧版本时照常互通。
	UDPFEC bool `json:"udpFec,omitempty"`
	// LossTolerant 是隧道的「抗丢包传输」：入口 / 中转到下一跳的承载从 TCP 换成 UDP 上的
	// KCP + 前向纠错（见 loss_carrier.go），出口 / 中转在和 TCP 监听同号的 UDP 端口上接。
	// 默认关；开了就只走它，连不上报错，不退回 TCP。只用于 V1。
	LossTolerant bool `json:"lossTolerant,omitempty"`
	// ReloadNonce 由 Agent 在热更新时写入，进程应用后原样写回 <config>.applied。
	ReloadNonce string `json:"reloadNonce,omitempty"`
}
