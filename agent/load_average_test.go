package main

import (
	"errors"
	"testing"
)

func TestParseLoadAverage(t *testing.T) {
	got := parseLoadAverage("0.12 0.25 0.38 1/234 5678\n")
	if len(got) != 3 || got[0] != 0.12 || got[1] != 0.25 || got[2] != 0.38 {
		t.Fatalf("unexpected %v", got)
	}
	for _, bad := range []string{"", "0.1 0.2", "a b c", "-1 0 0", "NaN 0 0", "Inf 0 0"} {
		if parseLoadAverage(bad) != nil {
			t.Fatalf("%q should not parse", bad)
		}
	}
}

func TestAddLoadAverageReportOmitsWhenUnavailable(t *testing.T) {
	original := readLoadAverageFile
	t.Cleanup(func() { readLoadAverageFile = original })

	readLoadAverageFile = func() ([]byte, error) { return nil, errors.New("no /proc/loadavg") }
	payload := map[string]any{}
	addLoadAverageReport(payload)
	if _, ok := payload["loadAverage"]; ok {
		t.Fatalf("unavailable load average must be omitted, not zero: %#v", payload)
	}

	readLoadAverageFile = func() ([]byte, error) { return []byte("1.50 0.75 0.20 2/100 42"), nil }
	addLoadAverageReport(payload)
	values, ok := payload["loadAverage"].([]float64)
	if !ok || len(values) != 3 || values[0] != 1.5 || values[2] != 0.2 {
		t.Fatalf("unexpected payload %#v", payload)
	}
}
