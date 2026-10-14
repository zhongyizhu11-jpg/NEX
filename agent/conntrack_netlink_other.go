//go:build !linux

package main

import "errors"

type unsupportedConntrackSource struct{}

func newSystemConntrackSource() conntrackSource { return unsupportedConntrackSource{} }

func (unsupportedConntrackSource) dump() ([]conntrackFlow, error) {
	return nil, errors.New("conntrack accounting needs linux")
}

func (unsupportedConntrackSource) subscribe(func(conntrackFlow), func()) (func(), error) {
	return nil, errors.New("conntrack accounting needs linux")
}
