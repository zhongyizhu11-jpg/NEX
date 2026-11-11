package main

// Mieru 落地的服务端 mita：面板下发的指令长什么样、配置怎么校验、怎么写成 mita 读的 JSON。
// 面板那头见 server/mitaRuntime.ts（指令）与 shared/mieruInbound.ts（配置怎么合成）。
//
// 这台机器上只跑一个 mita，服务名 forwardx-mita，所有路径都是 NEX 自己的（二进制、配置、
// UDS 套接字），和系统里可能装着的 mita（/usr/bin/mita、mita.service、/etc/mita）互不相干：
// 那一个不是 NEX 装的，这里永远不碰。

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

const (
	mitaServiceName = "forwardx-mita"
	mitaBinaryPath  = "/usr/local/bin/forwardx-mita"
	mitaConfigDir   = "/etc/forwardx/mita"
	mitaConfigPath  = "/etc/forwardx/mita/server.json"
	mitaRunDir      = "/run/forwardx-mita"
	mitaSocketPath  = "/run/forwardx-mita/mita.sock"

	// 和面板 shared/mieruInbound.ts 的上限对齐，再留一点余量：超了说明指令不是面板合成的那种。
	mitaMaxPortBindings  = 256
	mitaMaxListenTargets = 2048
	mitaMaxRangePorts    = 100
	mitaMaxUsers         = 4096
	mitaMaxPasswordBytes = 256
	mitaMinMTU           = 1280
	mitaMaxMTU           = 1500
	mitaDefaultMTU       = 1400
)

type mitaPortBinding struct {
	Port      int    `json:"port,omitempty"`
	PortRange string `json:"portRange,omitempty"`
	Protocol  string `json:"protocol"`
}

type mitaUser struct {
	Name     string `json:"name"`
	Password string `json:"password"`
}

// mitaServerConfig 只有这四个字段：写给 mita 的 JSON 由它重新序列化，面板指令里多出来的任何字段
// （egress、quotas、advancedSettings……）都到不了 mita —— 只下发面板该管的东西。
type mitaServerConfig struct {
	PortBindings []mitaPortBinding `json:"portBindings"`
	Users        []mitaUser        `json:"users"`
	LoggingLevel string            `json:"loggingLevel"`
	MTU          int               `json:"mtu"`
}

type mitaBinarySource struct {
	SHA256         string   `json:"sha256"`
	PanelAssetPath string   `json:"panelAssetPath"`
	TarballURLs    []string `json:"tarballUrls"`
	TarballSHA256  string   `json:"tarballSha256"`
}

type mitaDirective struct {
	V        int                         `json:"v"`
	Enabled  bool                        `json:"enabled"`
	Revision string                      `json:"revision"`
	Version  string                      `json:"version"`
	Binaries map[string]mitaBinarySource `json:"binaries"`
	Config   *mitaServerConfig           `json:"config"`
}

// mitaListenTarget 是 mita 应该听着的一个端口（端口段展开后）。
type mitaListenTarget struct {
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
}

var (
	mitaUsernamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
	mitaSHA256Pattern   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	mitaVersionPattern  = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	mitaRevisionPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

func parseMitaPortRange(value string) (int, int, error) {
	start, end, ok := strings.Cut(strings.TrimSpace(value), "-")
	if !ok {
		return 0, 0, fmt.Errorf("端口段 %q 不是「起-止」的形式", value)
	}
	from, err1 := strconv.Atoi(strings.TrimSpace(start))
	to, err2 := strconv.Atoi(strings.TrimSpace(end))
	if err1 != nil || err2 != nil || from < 1 || to > 65535 || from >= to {
		return 0, 0, fmt.Errorf("端口段 %q 不合法", value)
	}
	if to-from+1 > mitaMaxRangePorts {
		return 0, 0, fmt.Errorf("端口段 %q 超过 %d 个端口", value, mitaMaxRangePorts)
	}
	return from, to, nil
}

// mitaListenTargets 把端口绑定展开成一个个端口，顺序稳定。调用前应该先过 validateMitaServerConfig。
func mitaListenTargets(cfg *mitaServerConfig) []mitaListenTarget {
	if cfg == nil {
		return nil
	}
	targets := []mitaListenTarget{}
	for _, binding := range cfg.PortBindings {
		protocol := strings.ToUpper(strings.TrimSpace(binding.Protocol))
		if binding.PortRange != "" {
			from, to, err := parseMitaPortRange(binding.PortRange)
			if err != nil {
				continue
			}
			for port := from; port <= to; port++ {
				targets = append(targets, mitaListenTarget{Port: port, Protocol: protocol})
			}
			continue
		}
		targets = append(targets, mitaListenTarget{Port: binding.Port, Protocol: protocol})
	}
	return targets
}

// validateMitaServerConfig 在写盘之前把 mita 会拒绝的、或者面板本不该发的东西挡住。
//
// mita 对配置是整份拒绝的：一个端口撞车、一个重名用户，整个进程起不来 —— 这台机器上所有 Mieru
// 入站一起断。所以宁可不应用这一版（旧的 mita 接着跑），也不把它写下去。
func validateMitaServerConfig(cfg *mitaServerConfig) error {
	if cfg == nil {
		return fmt.Errorf("缺少 mita 配置")
	}
	if len(cfg.PortBindings) == 0 {
		return fmt.Errorf("没有端口")
	}
	if len(cfg.PortBindings) > mitaMaxPortBindings {
		return fmt.Errorf("端口绑定太多（%d）", len(cfg.PortBindings))
	}
	seen := map[string]bool{}
	total := 0
	for _, binding := range cfg.PortBindings {
		protocol := strings.TrimSpace(binding.Protocol)
		if protocol != "TCP" && protocol != "UDP" {
			return fmt.Errorf("不支持的承载 %q，只能是 TCP 或 UDP", binding.Protocol)
		}
		var from, to int
		switch {
		case binding.Port != 0 && binding.PortRange != "":
			return fmt.Errorf("端口 %d 和端口段 %q 不能同时写", binding.Port, binding.PortRange)
		case binding.PortRange != "":
			var err error
			if from, to, err = parseMitaPortRange(binding.PortRange); err != nil {
				return err
			}
		default:
			if binding.Port < 1 || binding.Port > 65535 {
				return fmt.Errorf("端口 %d 不合法", binding.Port)
			}
			from, to = binding.Port, binding.Port
		}
		for port := from; port <= to; port++ {
			key := protocol + "/" + strconv.Itoa(port)
			if seen[key] {
				return fmt.Errorf("%s 端口 %d 重复了", protocol, port)
			}
			seen[key] = true
			total++
		}
	}
	if total > mitaMaxListenTargets {
		return fmt.Errorf("要听的端口太多（%d）", total)
	}
	if len(cfg.Users) == 0 {
		return fmt.Errorf("没有用户")
	}
	if len(cfg.Users) > mitaMaxUsers {
		return fmt.Errorf("用户太多（%d）", len(cfg.Users))
	}
	names := map[string]bool{}
	for _, user := range cfg.Users {
		if !mitaUsernamePattern.MatchString(user.Name) {
			return fmt.Errorf("用户名 %q 不合法", user.Name)
		}
		if names[user.Name] {
			return fmt.Errorf("用户名 %q 重复了", user.Name)
		}
		names[user.Name] = true
		if user.Password == "" || len(user.Password) > mitaMaxPasswordBytes {
			return fmt.Errorf("用户 %q 的密码为空或太长", user.Name)
		}
		for _, r := range user.Password {
			if unicode.IsControl(r) {
				return fmt.Errorf("用户 %q 的密码里有控制字符", user.Name)
			}
		}
	}
	if cfg.MTU != 0 && (cfg.MTU < mitaMinMTU || cfg.MTU > mitaMaxMTU) {
		return fmt.Errorf("MTU %d 不在 %d-%d 之间", cfg.MTU, mitaMinMTU, mitaMaxMTU)
	}
	return nil
}

// renderMitaServerConfig 把校验过的配置写成 mita 读的 JSON。日志级别固定 INFO（DEBUG 会把每条连接
// 都写进日志），MTU 缺省按官方默认 1400。同样的输入逐字节一样：配置文件没变就不重启 mita。
func renderMitaServerConfig(cfg *mitaServerConfig) ([]byte, error) {
	if err := validateMitaServerConfig(cfg); err != nil {
		return nil, err
	}
	out := mitaServerConfig{
		PortBindings: make([]mitaPortBinding, 0, len(cfg.PortBindings)),
		Users:        make([]mitaUser, 0, len(cfg.Users)),
		LoggingLevel: "INFO",
		MTU:          cfg.MTU,
	}
	if out.MTU == 0 {
		out.MTU = mitaDefaultMTU
	}
	for _, binding := range cfg.PortBindings {
		item := mitaPortBinding{Protocol: strings.TrimSpace(binding.Protocol)}
		if binding.PortRange != "" {
			from, to, _ := parseMitaPortRange(binding.PortRange)
			item.PortRange = strconv.Itoa(from) + "-" + strconv.Itoa(to)
		} else {
			item.Port = binding.Port
		}
		out.PortBindings = append(out.PortBindings, item)
	}
	for _, user := range cfg.Users {
		out.Users = append(out.Users, mitaUser{Name: user.Name, Password: user.Password})
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(out); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// validateMitaDirective 看指令本身（不含配置）：版本、哈希、下载地址都要像面板发的。
// 下载地址只收面板自己的 /api/agent/assets/ 和 https：二进制会以 root 跑，来源不能随便写。
func validateMitaDirective(d *mitaDirective, arch string) (mitaBinarySource, error) {
	if d == nil {
		return mitaBinarySource{}, fmt.Errorf("缺少指令")
	}
	if !mitaRevisionPattern.MatchString(d.Revision) {
		return mitaBinarySource{}, fmt.Errorf("指令版本号不合法")
	}
	if !d.Enabled {
		return mitaBinarySource{}, nil
	}
	if !mitaVersionPattern.MatchString(d.Version) {
		return mitaBinarySource{}, fmt.Errorf("mita 版本 %q 不合法", d.Version)
	}
	source, ok := d.Binaries[arch]
	if !ok {
		return mitaBinarySource{}, fmt.Errorf("面板没有给这个架构（%s）的 mita", arch)
	}
	source.SHA256 = strings.ToLower(strings.TrimSpace(source.SHA256))
	source.TarballSHA256 = strings.ToLower(strings.TrimSpace(source.TarballSHA256))
	if !mitaSHA256Pattern.MatchString(source.SHA256) {
		return mitaBinarySource{}, fmt.Errorf("mita 的 SHA-256 不合法")
	}
	if source.PanelAssetPath != "" && !strings.HasPrefix(source.PanelAssetPath, "/api/agent/assets/") {
		return mitaBinarySource{}, fmt.Errorf("面板下载路径不合法")
	}
	urls := make([]string, 0, len(source.TarballURLs))
	for _, raw := range source.TarballURLs {
		raw = strings.TrimSpace(raw)
		if strings.HasPrefix(raw, "https://") && !strings.ContainsAny(raw, " \t\r\n") {
			urls = append(urls, raw)
		}
	}
	source.TarballURLs = urls
	if len(urls) > 0 && !mitaSHA256Pattern.MatchString(source.TarballSHA256) {
		return mitaBinarySource{}, fmt.Errorf("mita 发布包的 SHA-256 不合法")
	}
	if source.PanelAssetPath == "" && len(urls) == 0 {
		return mitaBinarySource{}, fmt.Errorf("没有可用的 mita 下载地址")
	}
	return source, nil
}

// mitaSignature 是「这一版 mita 跑的是什么」：配置内容 + 二进制哈希。服务签名对得上、
// 服务又在跑，就不重启（writeUnitAndRestart 按它判断）。
func mitaSignature(rendered []byte, binarySHA256 string) string {
	sum := sha256.New()
	sum.Write([]byte(binarySHA256))
	sum.Write([]byte{0})
	sum.Write(rendered)
	return hex.EncodeToString(sum.Sum(nil))[:32]
}

// mitaServiceUnit：mita 的 run 子命令前台跑、按 MITA_CONFIG_JSON_FILE 读 JSON 配置（mita help 里的写法），
// 不用 mita apply config —— 那会写进 /etc/mita 下 mita 自己的配置库，和系统里另装的 mita 撞在一起。
// UDS 放在 NEX 自己的目录：get metrics 走它读按用户的计数。/run 开机会清空，所以每次启动前 mkdir。
func mitaServiceUnit() string {
	execStart := `/bin/sh -c "mkdir -p ` + mitaRunDir + ` && exec env MITA_CONFIG_JSON_FILE=` + mitaConfigPath +
		` MITA_UDS_PATH=` + mitaSocketPath + ` MITA_INSECURE_UDS=1 MITA_LOG_NO_TIMESTAMP=1 ` + mitaBinaryPath + ` run"`
	return strings.Join([]string{
		"[Unit]",
		"Description=NEX managed Mieru server (mita)",
		"After=network-online.target",
		"Wants=network-online.target",
		"StartLimitIntervalSec=60",
		"StartLimitBurst=5",
		"",
		"[Service]",
		"Type=simple",
		"ExecStart=" + execStart,
		"Restart=always",
		"RestartSec=5",
		"LimitNOFILE=65535",
		"",
		"[Install]",
		"WantedBy=multi-user.target",
		"",
	}, "\n")
}
