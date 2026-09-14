# dsh-proxy

[English](README.en.md) | 中文

DSH（DeepSeek Harness）插件：把 Web 界面（默认 `127.0.0.1:3080`）转发到**另一个带认证的端口**，让同一局域网内的其他设备也能安全访问。

DSH 服务端**故意拒绝** `--host 0.0.0.0`（避免把 RCE 直接暴露到网络），本插件是官方认可的“出网”方式：独立监听端口 + 认证 + 反代回 loopback。

## 功能

- **HTTP + WebSocket 全协议转发**：任务状态、日志等实时推送不失效
- **反代 HTTPS 场景自带登录页**：经 HTTPS 访问时提供插件自带的登录页，登录后签发会话 Cookie（可登出、可过期、可在设置页踢出活动会话），并带登录限流与审计日志；**http 访问局域网 IP 仍走原来的浏览器 Basic 认证**，两种方式并存
- **原生 Basic Auth（默认关闭）**：使用**浏览器自带的认证弹窗**（明文局域网访问仍然如此）；默认用户名与密码均为空 = 局域网**开放访问**（能连上就直接进），在设置页**同时设置**用户名和密码后启用（含 WebSocket 握手）
- **开放状态显著提示**：未设密码却已对外监听时，浏览器端**每次打开/刷新页面都会弹出**醒目提示浮层（写明暴露地址与后果，不打扰操作），启动日志打印 SECURITY WARNING，设置页以红色标注「未启用（局域网开放访问）」并说明风险；浮层不做持久化记忆，关不掉这个风险
- **设置页面**：DSH 设置 → 「局域网代理」，状态红绿灯、启动/停止代理、修改监听端口与账号密码（持久化到 `$DSH_HOME/dsh-proxy.json`）
- **局域网自动登录**：DSH 的浏览器会话需要一个随进程启动令牌签发的 cookie，而 `dsh web` 打印的令牌地址是 loopback 的；插件用**你实际访问的地址**自动完成这次交换，首次打开局域网地址即可进入
- **浏览器内目录选择器**：「添加工作区」在页面里弹出目录浏览对话框，不会在宿主屏幕上弹原生窗口
- **开箱即通的兼容修复**：`Host`/`Origin` 改写（通过 DSH `/api` 同源校验，LAN 访问不 403）、`crypto.randomUUID` polyfill 注入（LAN 非安全上下文下前端 RPC 可用）
- **随 `dsh web` 启停**：无需单独进程，也无需下载任何可执行文件

<p align="center">
  <img src="doc/image-zh.png" alt="dsh-proxy 设置页面（中文界面）" width="720" />
</p>

## 安装

**在线安装（推荐）**——直接从 GitHub 安装（无需下载仓库）：

```bash
dsh plugin --profile web add github:wenxingyu/dsh-proxy#master
```

**本地安装**（仓库已克隆/下载到本机）：

```bash
dsh plugin --profile web add file:C:/mydata/codes/dsh-proxy
```

安装后**重启 `dsh web`**（Ctrl+C 后重新运行）即生效：启动日志会打印监听地址与局域网访问地址。

## 使用

浏览器访问 `http://<本机局域网IP>:3081` → 已设账号密码时弹出原生 Basic Auth 登录框（未设时直接进入，设置页与日志会提示风险）→ 进入 DSH 界面。凭据与会话由浏览器记住，下次直接进入。

更多说明（配置项、设置页、目录选择、开发与测试）见 [`dsh-proxy/README.zh.md`](dsh-proxy/README.zh.md)。

> Windows 防火墙：若局域网设备连不上，为本机放行该端口（管理员 PowerShell）：
> `netsh advfirewall firewall add rule name="dsh-proxy" dir=in action=allow protocol=TCP localport=3081`
