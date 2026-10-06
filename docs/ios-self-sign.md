# iOS 自签安装

NEX iOS 是连接已有服务器的管理客户端，不在手机运行面板服务、Agent 或系统 VPN。
最低 iOS 15。首次打开后填写面板地址并登录；推荐使用有效证书的 HTTPS 地址。

## 下载与安装

1. 打开 GitHub Actions → **iOS IPA**，选择成功的构建。
2. 下载 `forwardx-ios-unsigned-*` 构建产物并解压，取得 `forwardx-ios-v版本-unsigned.ipa`。
3. 在自己的签名工具中导入 IPA，用自己的有效证书和描述文件签名，再安装。

这是 **未签名的真机包**，不能直接安装，不是模拟器包，也没有 App Store DRM。
签名工具必须同时处理应用及其嵌入的框架；安装、有效期和设备限制由你的签名方式决定。
不要把证书、私钥或 Apple ID 密码提交到仓库。默认 Bundle ID 为 `com.forwardx.app`。

## 构建与发布

macOS、Xcode 26+、Node 22、pnpm 10.28.1：

```sh
pnpm install --frozen-lockfile
pnpm mobile:ipa
```

IPA 和 SHA-256 文件位于 `ios/build/`。版本与 `package.json` 一致，构建号取
`IOS_BUILD_NUMBER`（本地默认 1，CI 使用 run number）。`pnpm mobile:open:ios` 打开 Xcode。
不需要 Apple 开发者证书即可构建未签名包；安装仍需要你自行签名。

PR 会自动构建但不会发布 Release。推送版本标签会构建并附加到面板创建的同版本 Release。
如果版本标签由其他工作流的 `GITHUB_TOKEN` 创建，不会自动触发此工作流：合并后手动运行
**iOS IPA** 并选择对应 **tag** 即可。选择分支运行只上传 Actions 产物，不创建正式版本。

## 网络、安全与限制

- 现有移动端 Bearer token 登录和 `capacitor://localhost` CORS 白名单复用，未放宽服务器的来源策略。
- 自托管 HTTP 面板通过 WebView 的 ATS 例外兼容；HTTP 不加密，不建议公网使用。
  不忽略 HTTPS 证书错误。连接内网时按系统提示允许本地网络访问。
- 沿用现有移动端凭据存储，不宣称它是 Keychain；建议使用权限最小的专用管理账号。
- iOS 后台不会持续运行网页轮询，本地通知不等于 APNs 远程推送。
- Android APK 在线更新不适用于 iOS；新版 IPA 需重新自签安装。
- 原有浏览器 Blob 下载/文件导出在 WKWebView 中仍需真机验证，不能据构建通过就宣称全部支持。

## 真机验收（签名后）

- [ ] HTTPS 面板连接、首次登录、退出和重启后会话
- [ ] HTTP/IP/局域网地址与拒绝网络权限时的提示
- [ ] 主机、线路、规则查询与编辑
- [ ] 刘海/灵动岛安全区、底部导航、键盘弹出和返回手势
- [ ] 深浅色模式、横竖屏、文件导出与外部链接
- [ ] 通知权限允许/拒绝、前后台切换、重新签名升级

CI 仅验证构建和自动化测试，不能替代以上真机验收。
