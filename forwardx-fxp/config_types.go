package main

type exitEndpoint struct {
	Host    string `json:"host"`
	Port    int    `json:"port"`
	UDPPort int    `json:"udpPort,omitempty"`
	Key     string `json:"key,omitempty"`
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
	// LinkUpMbps / LinkDownMbps 是这条隧道两端之间链路的带宽上限（Mbit/s）：
	// 入口→出口（上行）和出口→入口（下行）。>0 时本进程往那个方向发的所有隧道帧
	// 合起来整形到略低于上限，并按重传自动微调，让中间的限速器（云联网、公网带宽
	// 上限）不丢包。0 = 不整形。见 link_shaper.go。
	LinkUpMbps       int    `json:"linkUpMbps,omitempty"`
	LinkDownMbps     int    `json:"linkDownMbps,omitempty"`
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
	// TransportVersion 是 Agent 写进来的隧道传输版本（v1 / v2），决定 UDP 单包上限。
	TransportVersion string `json:"transportVersion,omitempty"`
	// UDPWirePacketSize 显式覆盖 UDP 单包上限（字节），0 表示按传输版本取默认值。
	UDPWirePacketSize int `json:"udpWirePacketSize,omitempty"`
	// ReloadNonce 由 Agent 在热更新时写入，进程应用后原样写回 <config>.applied。
	ReloadNonce string `json:"reloadNonce,omitempty"`
}
