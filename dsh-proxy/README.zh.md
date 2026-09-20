# dsh-proxy

DSH 插件：把 DeepSeek Harness Web 界面（默认 `127.0.0.1:3080`）转发到**另一个带认证的端口**，让同一局域网内的其他设备也能安全访问。

- **HTTP + WebSocket 全协议转发**：任务状态、日志等实时推送不失效
- **原生 Basic Auth（默认关闭）**：使用**浏览器自带的认证弹窗**，没有自绘登录页、没有会话 Cookie——默认用户名与密码均为空，局域网**开放访问**（能连上就直接进）；在设置页**同时设置**用户名和密码后启用，外部访问时浏览器弹出原生 Basic Auth 登录框，成功后浏览器缓存凭据自动登录（含 WebSocket 握手）
- **未设密码的风险提示**：当代理真的对外监听、又没有密码时，插件的浏览器端会在**每次打开/刷新页面时弹出醒目浮层**（标题「⚠️ 局域网代理当前无密码对外开放」，写明暴露地址与后果），同时在启动日志打印 SECURITY WARNING，设置页把「密码登录」标记为红色「未启用（局域网开放访问）」并给出风险说明——行为不变，但不会再"悄悄地"开放。**浮层不做任何持久化记忆**："我知道了"只关闭当前这一次，下次刷新照样提醒——未认证的对外监听属于持续存在的安全风险，不应该被一次性关掉就永远静默
- **登录页 + 会话（HTTPS 场景）**：经反向代理走 HTTPS 时，未登录访客看到自带登录页；登录后签发会话 Cookie（`__Host-` + `Secure` + `HttpOnly` + `SameSite=Strict`），支持**登出、空闲/绝对过期、查看并踢出活动会话**
- **明文也能用登录页（默认统一）**：`http://局域网IP` 默认同样走登录页；明文下会话 Cookie 无法带 `Secure`/`__Host-`（浏览器不存），因此会下发较弱的一个变体，设置页与启动日志都会明确提示；想换回原来的 Basic 弹窗，把 `cleartextAuth` 设为 `basic` 即可，`requireTls: true` 则可彻底拒绝明文
- **登录限流与审计**：按来源 IP 计失败次数（默认 5 次锁 15 分钟），锁定期间即使密码正确也拒绝；登录/失败/锁定/登出/踢出等事件写入 `$DSH_HOME/dsh-proxy-audit.jsonl`（不含任何密码）
- **设置页面**：DSH 设置 → 「局域网代理」，显示监听端口/默认服务端口/**密码登录是否启用**，可修改代理监听端口、用户名、密码，可**启动/停止**代理，保存后自动重启转发服务（持久化到 `$DSH_HOME/dsh-proxy.json`）
- **开箱即通的兼容修复**：`Host`/`Origin` 改写（通过 DSH `/api` 同源信任篱笆，LAN 访问不 403）、`crypto.randomUUID` polyfill 注入（LAN 非安全上下文下前端 RPC 可用）
- **浏览器内的目录选择器**：DSH 默认会在「Web 只绑 loopback」时选用**宿主屏幕上的原生目录对话框**（`dsh-host-directory-picker-auto` 的判定），远程访问者看不到那个窗口。插件把该行固定为**应用内浏览选择器**（browse 后端 + 浏览器对话框），「添加工作区」在任何设备上都在页面里完成
- **随 `dsh web` 启停**：无需单独进程，配置改在 profile 的 `cordis.patch.yml`

> 为什么需要它：DSH Web 服务端**故意拒绝** `--host 0.0.0.0`（避免把 RCE 直接暴露到网络），本插件是官方认可的"出网"方式——独立监听端口 + 认证 + 反代回 loopback。
>

## 安装

**在线安装（推荐）**——直接从 GitHub 安装（无需下载仓库）：

```bash
dsh plugin --profile web add github:wenxingyu/dsh-proxy#master
```

**本地安装**（仓库已克隆/下载到本机）：

```bash
dsh plugin --profile web add file:C:/mydata/codes/dsh-proxy
```

安装后包名为 **`@wenxingyu/dsh-proxy`**（scoped，带用户名前缀），`dsh plugin ls` 中显示为 `@wenxingyu/dsh-proxy@0.1.4`。

安装后**重启 `dsh web`**（Ctrl+C 后重新运行）即生效。若 3081 被占用（例如另一个 dsh-proxy 实例还在运行），先停掉它，或在配置里换一个端口。

## 配置

所有配置项都有 schema 默认值；在 **profile 的 `cordis.patch.yml`** 里按行 id 覆盖（patch 会整体替换该行 config，因此要写全你要改的键）：

```yaml
# C:\Users\cc\.dsh\profiles\web\cordis.patch.yml
- id: dsh-proxy
  config:
    listenHost: '0.0.0.0'      # 监听网卡；0.0.0.0 = 局域网可访问
    listenPort: 3081            # 代理对外端口（默认 3081）
    upstreamHost: '127.0.0.1'   # 上游 DSH 地址
    upstreamPort: 0             # 0 = 跟随 web app 实际绑定的端口（默认）
    username: ''                # 登录用户名（默认空 = 密码登录关闭）
    password: ''                # 登录密码（默认空 = 密码登录关闭）
```

- 默认 `username` 与 `password` 均为空 = **密码登录关闭**，此时任何能连到代理端口的人都可以直接进入 DSH（局域网开放访问，谨慎）。**只有同时设置两者**才会启用密码登录（只设置其一仍保持关闭）。
- 监听行为**不会**因为没密码而改变：`listenHost: '0.0.0.0'` 依然照常对外监听，方便你先连上本机设置页再填账号密码；但插件会把这种"对外开放且无密码"的状态**显著标注出来**（浏览器端一次性弹层 + 启动日志 SECURITY WARNING + 设置页红色提示 + 状态接口的 `lanExposed` 字段）。
- 弹层使用框架预留的 `shell.overlay` 席位：**不是阻塞式弹窗**，不遮挡操作，只在卡片自身接受点击；每个页面加载最多查询一次状态。
- 提醒频率：**每次页面加载（打开/刷新）都提醒**，不写 `localStorage`、不做"已读"记忆；"我知道了"仅关闭本次。同一页面内组件重挂载不会重复请求状态（每次页面加载最多查一次接口）。
- 想验证"没被静音"：连点几次「我知道了」再刷新，浮层应照常出现。

## 设置页面（改端口 / 账号密码 / 启停）

重启 `dsh web` 后，打开 DSH 设置（左下角齿轮）→ 「局域网代理」：

- **运行状态**：两个红绿灯指示 —— **代理服务端口**（监听地址:端口，绿灯=代理实际在监听，红灯=端口被占用等绑定失败）与**默认服务端口**（DSH 服务端口，绿灯=可探测到默认服务，红灯=不可达）；另有当前用户名、**密码登录是否启用**；右上角有 **启动 / 停止** 按钮（运行中时「启动」置灰，未运行时「停止」置灰）。
- **修改设置**：可改 **代理服务端口（监听端口）**、**用户名**、**密码**（留空 = 设为空）。点「应用」后，配置写入 `$DSH_HOME/dsh-proxy.json` 并**立即重启转发服务**；改监听端口后局域网访问地址随之变化。

设置页的修改会**持久化**并优先于 profile 的 `cordis.patch.yml`；`listenHost` / `listenPort` 等仍只能通过 `cordis.patch.yml` 修改。插件通过 Connection 共享 `/api` 通道上的精确路由 `POST /api/dsh-proxy`（`status` / `update` / `start` / `stop` 四个端点）提供该能力；信任边界与浏览器会话校验由 Connection 统一负责（经代理改写 Host 后 LAN 端同样可访问）。

## 使用

1. 重启 `dsh web`，启动日志会打印访问地址：
   ```
   dsh-proxy: listening on 0.0.0.0:3081 -> http://127.0.0.1:3080
   dsh-proxy: 局域网访问 http://192.168.1.100:3081
   ```
2. 浏览器访问 `http://<本机局域网IP>:3081` → **浏览器弹出原生 Basic Auth 登录框** → 输入用户名密码 → 进入 DSH 界面。
3. 局域网内其他设备用同一地址访问；登录成功后浏览器会记住凭据，下次直接进入。

> DSH 自身的浏览器会话：Web 界面还要求一个随进程启动令牌签发的会话 cookie，而 `dsh web` 打印的 `?token=...` 地址是 loopback 的，局域网设备用不了。插件会用**你实际访问的地址**自动补上这一步（首次 `GET /` 未带会话时 302 到 `http://<你的地址>:<端口>/?token=...`，换成 cookie 后再跳回干净的 `/`），所以局域网首次访问**不需要手动复制令牌**；直接打开上面的地址即可。

> Windows 防火墙：若局域网设备连不上，为本机放行该端口（管理员 PowerShell）：
> `netsh advfirewall firewall add rule name="dsh-proxy" dir=in action=allow protocol=TCP localport=3081`

## 开发

```bash
pnpm install
pnpm run check   # typecheck + test + build
pnpm run smoke   # 对正在运行的 DSH（127.0.0.1:3080）做全流程冒烟测试
```

- `src/` — TypeScript 源码；`src/proxy.ts` 是纯 node 代理核心（无 cordis 依赖，可独立测试），`src/controller.ts` 是代理控制器（启动/停止/重启/状态/更新，负责配置持久化），`src/index.ts` 是 cordis 插件入口（含 `/api/dsh-proxy` 精确路由），`src/client/transport.ts` 是浏览器侧的调用封装，`src/client/` 是浏览器设置页。
- `lib/` — 提交构建产物（`lib/index.cjs` 为完全自包含单文件：schemastery、http-proxy、dsh-home-paths 均已内联；`lib/client.js` 为浏览器端单文件，仅 external react）。
- `tests/` — vitest：认证原语、polyfill 纯函数、代理集成测试（HTTP + WebSocket）、控制器（真实上游 + 临时配置文件）、设置页 jsdom 渲染。
- 宿主编排测试（跑在真实 DSH 进程里的插件生命周期）见 `scripts/smoke.mjs` 思路 + 手动重启验证。

## 认证细节

- **启用条件**：`username` 与 `password` **同时非空**才启用密码登录（默认均为空 = 开放访问）；只设置其一仍保持关闭。
- **暴露状态**：`status.lanExposed` 为 `true` 表示"代理正在监听对外地址、且密码登录未启用"，即局域网内任何人都能直接访问。设置页据此显示红色徽标与风险说明，浏览器端浮层与启动日志 SECURITY WARNING 也来自同一字段；该字段只描述风险，不影响监听行为。
- **认证方式**：HTTP Basic Auth，浏览器原生弹窗——未认证的**任何**请求（页面、`/api/*`、脚本）→ **401 + `WWW-Authenticate: Basic realm="dsh-proxy"`**；WebSocket 拒绝同样带挑战头。登录成功后浏览器按站点缓存凭据，后续请求（含 WS 握手）自动携带。**没有自绘登录页、没有会话 Cookie。**
- **公开静态文件**：`/manifest.webmanifest` 与 `/favicon.svg` 免认证——浏览器会在不带凭据的上下文（PWA 清单、图标）拉取它们，强制认证会 401。
- **登录页**：服务端渲染的单文件 HTML，**零 JavaScript**；响应带 `no-store`、`no-referrer`、严格 CSP（`default-src 'none'`）、`X-Frame-Options: DENY`；登录与登出都做同源校验。
- 凭据比较用常量时间（`timingSafeEqual`）。

## 安全提示

- 默认**开放访问**（用户名密码为空）——启用密码登录前，局域网内任何人都可访问。设置页会用红色「未启用（局域网开放访问）」和风险说明提醒你，请尽快**同时设置用户名和密码**。
- 判断依据是"**真的在对外监听**"：只绑 `127.0.0.1` 时不会报风险（本机访问没有暴露面），代理处于停止状态时也不会报。
- 该代理通过后，DSH 的 `/api` 信任篱笆看到的是改写后的 loopback `Host`，因此**设置/凭据等特权 RPC 也会对局域网开放**——密码登录（Basic Auth）是唯一闸门。
- 浏览器缓存的 Basic 凭据在**修改密码后不会自动失效**：旧凭据会 401 并重新弹窗，输入新密码即可；如需彻底清除，可在浏览器"已保存的密码"里删除该站点条目。
