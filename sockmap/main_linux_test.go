//go:build linux

package sockmap

import (
	"log"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	if os.Getenv("NEX_SOCKMAP_DEBUG") != "" {
		Logf = log.Printf
	}
	os.Exit(m.Run())
}
