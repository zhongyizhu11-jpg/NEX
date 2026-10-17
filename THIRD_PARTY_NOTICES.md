# Third-Party Notices

NEX Agent includes the userspace WireGuard implementation from the
official `wireguard-go` project.

## WireGuard userspace implementation

- Go module: `golang.zx2c4.com/wireguard`
- Pinned revision: `v0.0.0-20250521234502-f333402bd9cb`
- Upstream source: <https://git.zx2c4.com/wireguard-go/>
- License: MIT
- Usage: compiled into the NEX Agent binary; `agent/wireguard_netstack.go`
  is a modified copy of its `tun/netstack/tun.go` (batched packet reads on top
  of the gVisor stack)

Copyright (C) 2017-2025 WireGuard LLC. All Rights Reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Reed-Solomon erasure coding (FXP UDP anti-loss)

- Go module: `github.com/klauspost/reedsolomon`
- Version: `v1.12.4`
- Upstream source: <https://github.com/klauspost/reedsolomon>
- License: MIT
- Usage: compiled into the `forwardx-fxp` binary; `forwardx-fxp/udp_fec.go`
  uses it to compute and recover the parity packets of the tunnel's optional
  UDP anti-loss mode

The MIT License (MIT)

Copyright (c) 2015 Klaus Post
Copyright (c) 2015 Backblaze

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Earth textures and country outlines (panel network map and globes)

The panel serves a few static map assets from `client/public/globe/`:

- `earth-night.jpg` — NASA Black Marble (Earth at night), 2048 × 1024
  equirectangular. Used as the base layer of the dashboard network map.
- `earth-dark.jpg`, `earth-topology.png`, `night-sky.png` — textures for the
  3D globes on the hosts / rules / tunnels pages.

The textures above are NASA imagery (public domain, courtesy NASA Earth
Observatory / Visible Earth) as redistributed in the example assets of the
`three-globe` npm package (<https://github.com/vasturiano/three-globe>,
MIT License, Copyright (c) 2019 Vasco Asturiano). The night texture was taken
unchanged from `three-globe@2.31.0` (`example/img/earth-night.jpg`); the network
map warps it to Web Mercator in the browser, tile by tile.

- `ne_110m_admin_0_countries.geojson` — Natural Earth 1:110m admin-0 country
  boundaries (public domain, <https://www.naturalearthdata.com/>).

## Inter（界面主题「液态玻璃」的字体）

- 文件：`client/public/fonts/inter-latin-variable.woff2`（仅 latin 子集的变量字体，随面板自带）
- 来源：<https://github.com/rsms/inter>，经 freetodo/monitor-theme-liquid-glass 转发
- 许可：SIL Open Font License 1.1，全文见 `client/public/fonts/inter-LICENSE.txt`

## scaffold-master / Pearl Glass UI（界面主题「珍珠」）

- Upstream: <https://github.com/wbr664393425-lgtm/scaffold-master>
- Via: poouo/Forwardx 的 Pearl Glass 界面（`client/src/styles/pearl.css`、`PearlSidebarContent.tsx`）
- License: MIT
- Usage: the "珍珠" (`pearl`) UI theme adapts its design tokens, surface styling,
  and navigation/motion concepts: `client/src/styles/theme-pearl.css` and
  `client/src/components/PearlNavMarker.tsx`. The upstream Vue runtime and GSAP
  implementation are not included. Full notice also served as `/pearl-ui-license.txt`
  (`client/public/pearl-ui-license.txt`).

Copyright (c) 2026 wbr664393425-lgtm

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ip2region（在线 IP 的离线归属地库）

- 文件：`server/assets/ip2region/ip2region_v4.xdb.gz`、`ip2region_v6.xdb.gz`（构建时拷到 `dist/geo/`）
- 来源：<https://github.com/lionsoul2014/ip2region>，固定提交 `1bf6cabfb63c1a14af0971749c2120a3e5c77d72`
- 许可：Apache-2.0 或 MIT，按 MIT 再分发；全文见 `server/assets/ip2region/LICENSE.txt`
- 用途：只用来显示终端用户 IP 的大致归属地，查询全在本地完成，不发网络请求；读取代码是 NEX 自己按 xdb 格式实现的
  （`server/ipRegionOffline.ts`），加载时校验 sha256，见 `server/assets/ip2region/NOTICE.txt`

Copyright (c) 2015 Lionsoul<chenxin619315@gmail.com>
