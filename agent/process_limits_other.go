//go:build !unix

package main

func processOpenFileLimit() uint64 { return 0 }

func processRSSBytes() uint64 { return 0 }
