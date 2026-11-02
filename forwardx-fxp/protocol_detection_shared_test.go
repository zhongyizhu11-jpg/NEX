package main

// 这个文件在 agent/ 和 forwardx-fxp/ 里各有一份，内容一样（改一边就照抄到另一边）：
// 两边的协议识别和 PROXY 协议解析是各自一份代码，靠同一组样本（仓库根目录
// testdata/protocol_detection.json）保证对同一个连接给出同样的判断。

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"testing"
)

type sharedProtocolSample struct {
	Name          string  `json:"name"`
	Text          *string `json:"text"`
	Hex           *string `json:"hex"`
	HTTP          bool    `json:"http"`
	TLS           bool    `json:"tls"`
	Socks         bool    `json:"socks"`
	OK            bool    `json:"ok"`
	Error         bool    `json:"error"`
	SourceIP      string  `json:"sourceIp"`
	SourcePort    int     `json:"sourcePort"`
	DestIP        string  `json:"destIp"`
	DestPort      int     `json:"destPort"`
	RemainingText *string `json:"remainingText"`
}

type sharedProtocolSamples struct {
	Detection     []sharedProtocolSample `json:"detection"`
	ProxyProtocol []sharedProtocolSample `json:"proxyProtocol"`
}

func loadSharedProtocolSamples(t *testing.T) sharedProtocolSamples {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "testdata", "protocol_detection.json"))
	if err != nil {
		t.Fatalf("read shared protocol samples: %v", err)
	}
	var samples sharedProtocolSamples
	if err := json.Unmarshal(raw, &samples); err != nil {
		t.Fatalf("parse shared protocol samples: %v", err)
	}
	if len(samples.Detection) == 0 || len(samples.ProxyProtocol) == 0 {
		t.Fatal("shared protocol samples are empty")
	}
	return samples
}

func (s sharedProtocolSample) bytes(t *testing.T) []byte {
	t.Helper()
	switch {
	case s.Text != nil && s.Hex == nil:
		return []byte(*s.Text)
	case s.Hex != nil && s.Text == nil:
		data, err := hex.DecodeString(*s.Hex)
		if err != nil {
			t.Fatalf("%s: bad hex: %v", s.Name, err)
		}
		return data
	default:
		t.Fatalf("%s: sample needs exactly one of text / hex", s.Name)
		return nil
	}
}

func TestSharedProtocolDetectionSamples(t *testing.T) {
	for _, sample := range loadSharedProtocolSamples(t).Detection {
		data := sample.bytes(t)
		if got := detectHTTPProtocol(data); got != sample.HTTP {
			t.Errorf("%s: detectHTTPProtocol = %v, want %v", sample.Name, got, sample.HTTP)
		}
		if got := detectTLSProtocol(data); got != sample.TLS {
			t.Errorf("%s: detectTLSProtocol = %v, want %v", sample.Name, got, sample.TLS)
		}
		if got := detectSocksProtocol(data); got != sample.Socks {
			t.Errorf("%s: detectSocksProtocol = %v, want %v", sample.Name, got, sample.Socks)
		}
	}
}

func TestSharedProxyProtocolSamples(t *testing.T) {
	for _, sample := range loadSharedProtocolSamples(t).ProxyProtocol {
		info, remaining, ok, err := consumeProxyProtocol(sample.bytes(t))
		if (err != nil) != sample.Error {
			t.Errorf("%s: err = %v, want error=%v", sample.Name, err, sample.Error)
			continue
		}
		if sample.Error {
			continue
		}
		if ok != sample.OK {
			t.Errorf("%s: ok = %v, want %v", sample.Name, ok, sample.OK)
		}
		if info.SourceIP != sample.SourceIP || info.SourcePort != sample.SourcePort || info.DestIP != sample.DestIP || info.DestPort != sample.DestPort {
			t.Errorf("%s: info = %+v, want %s:%d -> %s:%d", sample.Name, info, sample.SourceIP, sample.SourcePort, sample.DestIP, sample.DestPort)
		}
		if sample.RemainingText != nil && string(remaining) != *sample.RemainingText {
			t.Errorf("%s: remaining = %q, want %q", sample.Name, remaining, *sample.RemainingText)
		}
	}
}

// 两边逐字一样的那几个函数（不算注释），改了一边忘了另一边就在这里红。
// detectSocksProtocol 两边写法不同（agent 还要等服务端确认），只靠上面的样本对齐。
var sharedProtocolFunctions = []string{
	"trimLeadingHTTPBlankLines",
	"detectHTTPProtocol",
	"validHTTPRequestTarget",
	"detectTLSProtocol",
	"detectSocks4Request",
	"consumeProxyProtocol",
	"consumeProxyProtocolV1",
	"consumeProxyProtocolV2",
	"normalizeProxyProtocolVersion",
}

func sharedFunctionSources(t *testing.T, file string) map[string]string {
	t.Helper()
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, file, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}
	wanted := map[string]bool{}
	for _, name := range sharedProtocolFunctions {
		wanted[name] = true
	}
	sources := map[string]string{}
	for _, decl := range parsed.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Recv != nil || !wanted[fn.Name.Name] {
			continue
		}
		fn.Doc = nil
		var out bytes.Buffer
		if err := printer.Fprint(&out, token.NewFileSet(), fn); err != nil {
			t.Fatalf("print %s: %v", fn.Name.Name, err)
		}
		sources[fn.Name.Name] = out.String()
	}
	return sources
}

func TestSharedProtocolFunctionsStayIdentical(t *testing.T) {
	agent := sharedFunctionSources(t, filepath.Join("..", "agent", "main.go"))
	fxp := sharedFunctionSources(t, filepath.Join("..", "forwardx-fxp", "main.go"))
	for _, name := range sharedProtocolFunctions {
		a, okA := agent[name]
		f, okF := fxp[name]
		if !okA || !okF {
			t.Errorf("%s: missing (agent=%v fxp=%v)", name, okA, okF)
			continue
		}
		if a != f {
			t.Errorf("%s differs between agent/main.go and forwardx-fxp/main.go:\n--- agent\n%s\n--- fxp\n%s", name, a, f)
		}
	}
	self, err := os.ReadFile("protocol_detection_shared_test.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"agent", "forwardx-fxp"} {
		other, err := os.ReadFile(filepath.Join("..", dir, "protocol_detection_shared_test.go"))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(self, other) {
			t.Errorf("%s/protocol_detection_shared_test.go must be an exact copy of this file", dir)
		}
	}
}
