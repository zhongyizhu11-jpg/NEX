//go:build !unix

package main

import "time"

func dpProcessCPUTime() time.Duration { return 0 }
