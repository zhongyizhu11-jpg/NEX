//go:build !unix

package main

import "time"

func processCPUTime() time.Duration { return 0 }
