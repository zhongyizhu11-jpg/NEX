# OIDC 登录（Pocket ID、Keycloak 等）

除了 [Google 登录](./google-login.md) 和 Discord 登录，面板还可以接入任意一个**标准 OpenID Connect 身份提供方（IdP）**，常见的自建方案都可以：[Pocket ID](https://pocket-id.org/)、Authentik、Keycloak、Authelia、Zitadel、Kanidm、Casdoor……

开启后，登录页会多一个「使用 <显示名称> 登录」按钮（例如「使用 Pocket ID 登录」）。和 Google 登录一样，默认只有**已经绑定过的面板账号**能用；要不要让 IdP 里的新用户直接注册面板账号，由管理员决定。

## 开始之前

- 面板要有一个固定的公开地址，在 `系统设置 -> 系统配置 -> 面板地址` 里填好并保存，例如 `https://panel.example.com`。回调地址是用它拼出来的。多数 IdP 只接受 **https** 回调地址，建议先给面板配好 HTTPS。
- 面板服务器要能访问 IdP（拉取 discovery、公钥、换取令牌都由面板服务器发起，不经过浏览器）。
- IdP 在局域网里（`192.168.x.x`、`10.x.x.x`、`auth.home.lan` 之类）时，要在设置里勾选 **IdP 在内网**，见下文「安全说明」。

面板的回调地址固定是：

```text
https://panel.example.com/api/auth/oidc/callback
```

（「面板公开地址」后面接 `/api/auth/oidc/callback`，设置页里有现成的一键复制。）

## 用 Pocket ID

1. 用管理员登录 Pocket ID，进入 **OIDC Clients -> Add OIDC Client**。
2. 名称随意（比如「NEX 面板」）；**Callback URLs** 填上面那个回调地址，要和面板设置页显示的完全一致。
3. 不要勾选「Public Client」（面板是能保管密钥的服务端应用）；PKCE 可以勾上，面板每次都会带。
4. 保存后得到 **Client ID** 和 **Client Secret**（密钥只显示一次，先复制好）。
5. 回到面板：`系统设置 -> 系统配置 -> OIDC 登录`
   - 显示名称：`Pocket ID`
   - Issuer 地址：Pocket ID 的访问地址，例如 `https://id.example.com`（**不带末尾斜杠**，Pocket ID 的 issuer 就是它的 `APP_URL`）
   - 客户端 ID / 客户端密钥：上一步拿到的两项
   - 点 **测试发现**，看到「发现成功」和端点列表后，勾选 **启用 OIDC 登录**，保存。

::: tip Pocket ID 的邮箱验证
Pocket ID 默认把用户邮箱标记为**未验证**（`email_verified: false`），而面板默认「只接受已验证邮箱」，这时登录会提示「邮箱还没有验证」。两种处理方式任选其一：

- 在 Pocket ID 里设置环境变量 `EMAILS_VERIFIED=true`（用户邮箱由管理员维护时适用；不同版本的设置名可能不同，以 Pocket ID 文档为准）；
- 或者在面板里取消勾选「只接受已验证邮箱」（明白风险的前提下，见下文）。
:::

## 用别的 IdP

步骤都一样：在 IdP 里建一个「机密客户端 / Confidential client」，授权方式选**授权码（Authorization Code）**，回调地址填面板显示的那一个，然后把 Issuer、客户端 ID、密钥填进面板。几家的 Issuer 长这样：

| IdP | Issuer 示例 | 备注 |
| --- | --- | --- |
| Keycloak | `https://sso.example.com/realms/<realm>` | 客户端开启「Client authentication」 |
| Authentik | `https://auth.example.com/application/o/<应用 slug>/` | **末尾有斜杠**，要原样照抄 |
| Authelia | `https://auth.example.com` | 4.39 起 ID Token 里不带邮箱，面板会自动用 userinfo 补 |
| Zitadel | `https://<实例>.zitadel.cloud` | 同上，邮箱可能只在 userinfo 里 |

不确定 Issuer 是什么时，打开 `https://<IdP 地址>/.well-known/openid-configuration`，里面的 `issuer` 字段就是，**一个字符都不能差**（包括末尾斜杠）。

## 设置项

| 选项 | 说明 |
| --- | --- |
| 启用 OIDC 登录 | 总开关，默认关。没填面板公开地址、Issuer 或客户端 ID 时开不了 |
| 显示名称 | 按钮上的名字，「使用 <显示名称> 登录」。默认 `OIDC` |
| Issuer 地址 | IdP 的 issuer。面板按它拼出 discovery 地址，并要求 discovery 返回的 `issuer` 和它完全相同 |
| 客户端 ID / 客户端密钥 | IdP 里建的客户端。密钥加密保存，读出时只显示打码值，输入框留空 = 不修改。IdP 那边是「公开客户端」时密钥可以不填（只靠 PKCE） |
| Scope | 默认 `openid email profile`。没写 `openid` 会自动补上 |
| 允许用它注册新账号 | 默认关：只有已经绑定过的账号能登录。打开后还要同时满足「开放注册」、邮件设置里的邮箱白名单和邀请注册规则 |
| 只接受已验证邮箱 | 默认开：IdP 给的 `email_verified` 必须是 `true`，没给这一项也不算 |
| 只允许这些邮箱域名 | 可选，逗号分隔。子域名也算。对登录、绑定、注册都生效 |
| IdP 在内网 | 默认关。勾选后允许连接局域网地址（以及 http 的 Issuer） |
| 接受 HS256 签名的 ID Token | 默认关。只认 RS256 / ES256；IdP 只能用客户端密钥签名时才勾，且必须填了密钥 |

## 用户怎么绑定

1. 先用用户名 + 密码登录面板（要在「面板公开地址」打开的面板里）。
2. 打开 `个人资料`，在「<显示名称> 账号」那块点 **绑定**，到 IdP 那边登录并同意授权。
3. 回到个人资料，显示「已绑定」和对应的邮箱。以后在登录页点「使用 <显示名称> 登录」即可。

解除绑定也在这里。解除前账号必须还有别的登录方式（登录密码、通行密钥，或者绑着并且开着的 Google / Discord 登录）；用 OIDC 注册的账号一开始没有密码，要先在同一块里 **设置登录密码**。

## 账号怎么对应

- 面板只认 IdP 给的 **issuer + sub**（IdP 里每个用户的永久编号），不认邮箱、也不认用户名。用户在 IdP 里改了邮箱，绑定不受影响。
- **不会按邮箱自动合并账号。** 自建 IdP 里的邮箱往往是用户自己填的，谁都可以填成别人的邮箱；所以一个没绑定过的 IdP 账号，哪怕邮箱和某个面板账号一模一样，也不会登录进那个账号，只会提示「请先用密码登录，在 个人资料 里绑定」。
- 允许注册时，新账号的用户名优先取 IdP 的 `preferred_username`，没有就取邮箱 `@` 前面的部分（被占用就加数字）。这个邮箱已经属于某个面板账号时不会再建新账号。新账号没有密码，权限和自助注册的新用户一样。
- 一个 IdP 账号只能绑定一个面板账号，一个面板账号也只能绑定一个 IdP 账号。
- 管理员换了 Issuer（换了一个 IdP）之后，旧 IdP 的绑定**不能再用来登录**，个人资料里显示「已失效」，用户重新绑定一次即可。
- 停用的账号、维护模式、单设备登录、邀请注册和返利，规则和密码登录 / Google 登录完全一样。
- 账户开了双重验证（2FA）时，用 OIDC 登录后**仍然要输入 2FA 验证码**。

## 安全说明

- 授权走 OAuth 2.0 授权码 + PKCE（S256），带 OpenID Connect 的 `nonce`。`state`、PKCE 校验码和 `nonce` 只保存在面板内存里，10 分钟有效、只能用一次；浏览器里另有一个 HttpOnly、SameSite=Lax 的绑定 cookie，回调时两者都对得上才继续。面板重启会让正在进行中的登录作废，重新点一次按钮即可。
- 面板自己校验 ID Token：签名（RS256 / ES256，公钥来自 IdP 的 JWKS，带缓存，遇到新的 `kid` 会自动刷新）、`iss`（必须等于 Issuer）、`aud` / `azp`（必须是你的客户端 ID）、有效期、`nonce`。`alg: none` 一律拒绝；HS256 默认拒绝。回调地址里带了 `iss` 参数（RFC 9207）时也要对得上，防 IdP 混淆攻击。
- ID Token 里没有邮箱时，面板用这次拿到的 access_token 调一次 userinfo，并要求 userinfo 的 `sub` 和 ID Token 一致。
- 面板访问 IdP 的所有请求（discovery、JWKS、换票、userinfo）都经过出站防护：不跟随跳转、响应最多 128KB、10 秒超时、连接只落在检查过的地址上（防 DNS 重绑定）。默认**只允许公网地址**；勾选「IdP 在内网」后放行局域网地址，回环地址（`127.0.0.1`、`localhost`）和云服务器元数据地址（`169.254.169.254`）始终不允许 —— IdP 和面板装在同一台机器上时，请用这台机器的局域网 IP 或域名。
- 发起登录之后管理员改了 Issuer / 客户端 / 密钥 / 回调地址，这次登录作废，不会拿旧配置下的授权码去换票。
- 授权码、令牌不会出现在网址、日志或数据库里；失败时网址里只有一个简短的错误码。
- 登录、绑定、解绑、OIDC 注册都会记到事件时间线（`account.*`）；开关 OIDC 登录、修改 Issuer / 内网 / HS256 这几项信任设置会记 `security.*`。
- API 令牌不能调用 `oidcAuth.*` 的任何接口，也不能发起绑定。

## 常见问题

| 现象 | 原因和处理 |
| --- | --- |
| 「测试发现」提示 issuer 不一致 | Issuer 和 IdP 的 discovery 里的 `issuer` 不完全一样。最常见的是**末尾斜杠**（Authentik 有、Pocket ID 没有），按提示改成一模一样 |
| 「测试发现」提示目标是内网或受限地址 | IdP 在局域网里：勾选「IdP 在内网」。如果 IdP 用的是 `127.0.0.1` / `localhost`，换成机器的局域网地址 |
| 提示 discovery 返回了跳转 | Issuer 填成了 http 而 IdP 会跳到 https，或者少了路径（比如 Keycloak 的 `/realms/<realm>`）。面板不跟随跳转，请填最终地址 |
| IdP 页面报 redirect_uri 不匹配 | IdP 里填的回调地址和面板设置页显示的不一致（协议、域名、端口、路径都要一样） |
| 登录页提示「邮箱还没有验证」 | IdP 给的 `email_verified` 不是 `true`。Pocket ID 见上文的 `EMAILS_VERIFIED`；Keycloak 在用户详情里把 Email verified 打开 |
| 登录页提示「身份提供方没有给出邮箱」 | Scope 里没有 `email`，或者用户在 IdP 里没填邮箱 |
| 提示「身份凭据没有通过校验」 | 多半是 IdP 用了面板不支持的签名算法（比如 RS512 / PS256）：在 IdP 的客户端设置里把 ID Token 签名算法改成 RS256。看面板日志里 `[OidcAuth]` 开头的那一行可以知道具体是哪一项 |
| 提示「向身份提供方换取登录凭据失败」 | 客户端密钥填错、IdP 要求的客户端认证方式面板没用对，或者面板访问不了 IdP。日志里 `token endpoint rejected: invalid_client` 就是密钥问题 |
| 提示「还没绑定面板账号」 | 先用密码登录，在个人资料里绑定；或者管理员打开「允许用它注册新账号」 |
| 提示「登录请求已过期或无效」 | 授权页停留超过 10 分钟、面板中途重启过、管理员中途改了设置，或者从别的浏览器打开了回调链接。重新点一次按钮 |
| App 里看不到这个按钮 | 目前通用 OIDC 只支持在浏览器里登录和绑定，App 里请用密码、Google 或 Telegram 登录 |
