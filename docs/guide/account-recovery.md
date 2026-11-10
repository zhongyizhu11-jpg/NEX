# 管理员账号恢复

## 普通用户忘了密码

登录页「忘记密码？」可以自助找回：面板把一次性链接发到账号已验证的邮箱、已绑定的 Telegram 或 Discord。管理员要先在系统设置里填好面板公开访问地址，并配好至少一个发送渠道。详见[用户、套餐和权限](./users-billing.md#用户忘记密码)。

没有任何找回渠道的用户，由管理员在「用户管理」里直接给他设新密码。

## 管理员忘了密码

管理员账号同样可以用登录页的「忘记密码？」。收不到链接（没配邮件和机器人、面板公开地址没填）时，在服务器上用命令重置：

```bash
# 一键脚本装的面板（推荐）
fwxm reset-admin                # 同机装了 Agent 时用 fwxm panel reset-admin

# Docker 部署（默认容器名 forwardx-panel）
docker exec -it forwardx-panel node dist/reset-admin-password.js

# 本地部署
sudo bash /opt/forwardx-panel/scripts/install-panel-local.sh reset-admin
```

- 有多个管理员时按提示输入用户名或邮箱；只有一个时直接回车。
- 新密码在终端里隐藏输入，不会出现在命令行参数和进程列表里。
- 重置会撤销这个管理员已有的登录会话；双重验证（2FA）和通行密钥保持不变。
- 被禁用的管理员默认仍然是禁用状态，确需启用时在命令后面加 `--enable-account`。
- 执行前建议先备份数据库。

## 2FA 设备丢了

重置密码不会关掉 2FA。还有另一个管理员的话，请他在「用户管理」里摘掉你的 2FA（会顺带作废你的 API 令牌）。设过通行密钥的话，也可以在登录页用通行密钥登录。

只有一个管理员、又没有通行密钥时，只能直接改数据库：先备份，再把 `users` 表里这个账号的 `twoFactorEnabled` 改成 0（PostgreSQL 是 false）、`twoFactorSecret` 清空。改完用密码登录，再到「个人资料」里重新开 2FA。

## 重装面板不会重置管理员

重新运行安装脚本时，只要沿用原来的数据卷或数据库，原来的管理员账号和密码都还在。真要从头来，先确认已经备份，再按[卸载 NEX](./uninstall.md)删掉数据卷或换一个空数据库。
