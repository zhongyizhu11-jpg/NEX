# Third-Party Notices

ForwardX Agent includes the userspace WireGuard implementation from the
official `wireguard-go` project.

## WireGuard userspace implementation

- Go module: `golang.zx2c4.com/wireguard`
- Pinned revision: `v0.0.0-20250521234502-f333402bd9cb`
- Upstream source: <https://git.zx2c4.com/wireguard-go/>
- License: MIT
- Usage: compiled into the ForwardX Agent binary; `agent/wireguard_netstack.go`
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
