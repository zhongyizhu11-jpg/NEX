package main

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// 2.2.253 起的四项：Prime Video、Spotify 注册、Steam 商店币种、Bilibili 港澳台。页面都是假的（fakeSites）。

func TestUnlockPrimeVideo(t *testing.T) {
	ctx := context.Background()
	t.Run("available with territory", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{
			"www.primevideo.com/": page(200, `<script>{"currentTerritory":"JP","marketplaceId":"x"}</script>`),
		})
		expect(t, unlockCheckPrimeVideo(ctx, p), unlockStatusOK, "JP")
	})
	t.Run("service restricted", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{
			"www.primevideo.com/": page(200, `{"isServiceRestricted":true,"currentTerritory":"CN"}`),
		})
		expect(t, unlockCheckPrimeVideo(ctx, p), unlockStatusBlocked, "CN")
	})
	t.Run("no territory is unknown", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{"www.primevideo.com/": page(200, "<html></html>")})
		expect(t, unlockCheckPrimeVideo(ctx, p), unlockStatusUnknown, "")
	})
}

func TestUnlockSpotify(t *testing.T) {
	ctx := context.Background()
	t.Run("redirect to market", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{
			"www.spotify.com/signup":       redirect("/hk-en/signup"),
			"www.spotify.com/hk-en/signup": page(200, "<html>Sign up for free</html>"),
		})
		expect(t, unlockCheckSpotify(ctx, p), unlockStatusOK, "HK")
	})
	t.Run("select your country", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{
			"www.spotify.com/signup":                      redirect("/select-your-country-region/"),
			"www.spotify.com/select-your-country-region/": page(200, "<html>pick</html>"),
		})
		expect(t, unlockCheckSpotify(ctx, p), unlockStatusBlocked, "")
	})
	t.Run("no market path", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{"www.spotify.com/signup": page(200, "<html>?</html>")})
		expect(t, unlockCheckSpotify(ctx, p), unlockStatusUnknown, "")
	})
}

func TestUnlockSteam(t *testing.T) {
	ctx := context.Background()
	t.Run("currency from meta", func(t *testing.T) {
		var cookie string
		p := fakeSites(t, map[string]http.HandlerFunc{
			"store.steampowered.com/app/761830": func(w http.ResponseWriter, r *http.Request) {
				cookie = r.Header.Get("Cookie")
				page(200, `<meta itemprop="priceCurrency" content="HKD">`)(w, r)
			},
		})
		got := unlockCheckSteam(ctx, p)
		expect(t, got, unlockStatusOK, "HKD")
		if !strings.Contains(got.Detail, "HKD") || !strings.Contains(cookie, "birthtime") {
			t.Fatalf("detail=%q cookie=%q", got.Detail, cookie)
		}
	})
	t.Run("no price", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{"store.steampowered.com/app/761830": page(200, "<html>agecheck</html>")})
		expect(t, unlockCheckSteam(ctx, p), unlockStatusUnknown, "")
	})
}

func TestUnlockBilibiliHMT(t *testing.T) {
	ctx := context.Background()
	route := "api.bilibili.com/pgc/player/web/playurl"
	t.Run("ok", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{route: page(200, `{"code":0,"message":"success","result":{}}`)})
		expect(t, unlockCheckBilibiliHMT(ctx, p), unlockStatusOK, "")
	})
	t.Run("region locked", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{route: page(200, `{"code":-10403,"message":"抱歉您所在地区不可观看！"}`)})
		expect(t, unlockCheckBilibiliHMT(ctx, p), unlockStatusBlocked, "")
	})
	t.Run("risk control", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{route: page(412, "<html>blocked</html>")})
		expect(t, unlockCheckBilibiliHMT(ctx, p), unlockStatusUnknown, "")
	})
	t.Run("other code", func(t *testing.T) {
		p := fakeSites(t, map[string]http.HandlerFunc{route: page(200, `{"code":-404}`)})
		got := unlockCheckBilibiliHMT(ctx, p)
		expect(t, got, unlockStatusUnknown, "")
		if !strings.Contains(got.Detail, "-404") {
			t.Fatalf("detail should carry the code: %q", got.Detail)
		}
	})
}
