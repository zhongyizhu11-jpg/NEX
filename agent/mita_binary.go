package main

// 装 mita：从哪拿、怎么校验、怎么换上去。
//
// 来源按顺序试：先面板转发的现成二进制（/api/agent/assets/…/forwardx-mita-linux-<架构>，落地机多半
// 连得上面板、未必连得上 GitHub），再上游发布包（加速地址在前）。不管从哪拿到，装之前都按面板指令里
// 钉死的 SHA-256 校验（面板那边钉在 shared/mitaAssets.ts）：二进制要以 root 跑，镜像、面板缓存
// 被人换了内容，这一步就过不去。
//
// 换上去用「临时文件 + 校验通过再改名」：下到一半断线、或者下了个坏文件，旧的那个原地不动。

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const mitaMaxDownloadBytes = 64 << 20

var mitaDownloadHTTPClient = &http.Client{
	Timeout:   3 * time.Minute,
	Transport: newAgentHTTPTransport(true),
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func hasELFMagic(data []byte) bool {
	return len(data) >= 4 && data[0] == 0x7f && data[1] == 'E' && data[2] == 'L' && data[3] == 'F'
}

func mitaDownload(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "forwardx-agent/"+Version)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, mitaMaxDownloadBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > mitaMaxDownloadBytes {
		return nil, fmt.Errorf("文件超过 %d MB", mitaMaxDownloadBytes>>20)
	}
	return data, nil
}

// extractMitaFromTarball 从上游发布包里取出名为 mita 的那个普通文件。
func extractMitaFromTarball(archive []byte) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("发布包里没有 mita")
		}
		if err != nil {
			return nil, err
		}
		if header.Typeflag != tar.TypeReg || filepath.Base(header.Name) != "mita" {
			continue
		}
		if header.Size <= 0 || header.Size > mitaMaxDownloadBytes {
			return nil, fmt.Errorf("发布包里的 mita 大小不对（%d）", header.Size)
		}
		return io.ReadAll(io.LimitReader(reader, mitaMaxDownloadBytes))
	}
}

// fetchVerifiedMitaBinary 按顺序试每个来源，返回第一份哈希对得上的二进制。
func fetchVerifiedMitaBinary(ctx context.Context, client *http.Client, panelURL string, source mitaBinarySource) ([]byte, error) {
	failures := []string{}
	accept := func(origin string, binary []byte) ([]byte, bool) {
		if got := sha256Hex(binary); got != source.SHA256 {
			failures = append(failures, fmt.Sprintf("%s：SHA-256 对不上（%s…）", origin, got[:12]))
			return nil, false
		}
		if !hasELFMagic(binary) {
			failures = append(failures, origin+"：不是 ELF 可执行文件")
			return nil, false
		}
		return binary, true
	}
	if base := strings.TrimRight(strings.TrimSpace(panelURL), "/"); base != "" && source.PanelAssetPath != "" {
		if data, err := mitaDownload(ctx, client, base+source.PanelAssetPath); err != nil {
			failures = append(failures, "面板："+err.Error())
		} else if binary, ok := accept("面板", data); ok {
			return binary, nil
		}
	}
	for _, url := range source.TarballURLs {
		if ctx.Err() != nil {
			break
		}
		origin := hostOfURL(url)
		archive, err := mitaDownload(ctx, client, url)
		if err != nil {
			failures = append(failures, origin+"："+err.Error())
			continue
		}
		if got := sha256Hex(archive); got != source.TarballSHA256 {
			failures = append(failures, fmt.Sprintf("%s：发布包 SHA-256 对不上（%s…）", origin, got[:12]))
			continue
		}
		binary, err := extractMitaFromTarball(archive)
		if err != nil {
			failures = append(failures, origin+"："+err.Error())
			continue
		}
		if verified, ok := accept(origin, binary); ok {
			return verified, nil
		}
	}
	if len(failures) == 0 {
		return nil, fmt.Errorf("没有可用的下载地址")
	}
	return nil, errors.New(strings.Join(failures, "；"))
}

func hostOfURL(raw string) string {
	rest := strings.TrimPrefix(strings.TrimPrefix(raw, "https://"), "http://")
	if index := strings.IndexAny(rest, "/?#"); index >= 0 {
		rest = rest[:index]
	}
	if rest == "" {
		return raw
	}
	return rest
}

// installMitaBinaryAt 把校验过的二进制原子地换到 dest。
func installMitaBinaryAt(dest string, binary []byte) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
		return err
	}
	return writeFileAtomicDurable(dest, binary, 0755)
}

func fileSHA256(path string) string {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return ""
	}
	return sha256Hex(data)
}
