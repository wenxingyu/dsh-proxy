/**
 * The proxy's own login page.
 *
 * Deliberately a server-rendered, self-contained HTML document with no
 * dependency on DSH's asset pipeline: the visitor is unauthenticated, so the app
 * bundle is exactly what must NOT be reachable yet. One document, one inline
 * stylesheet, one form, no JavaScript — a script-free login form cannot be
 * broken by XSS in the page and needs no CSP allowance beyond the default.
 *
 * Security properties, all enforced elsewhere but relied on here:
 * - the form posts to the proxy's own path with `autocomplete` off for the
 *   username and `current-password` for the password, so a password manager can
 *   fill it without the page ever reading the value;
 * - the response is marked `no-store` and `no-referrer` by the caller, so a
 *   credential-bearing POST is not cached or leaked through a Referer;
 * - the page states the transport it is on: served over cleartext HTTP (no TLS
 *   in front) the caller refuses to accept the submission at all, because a
 *   password posted in the clear is not worth collecting.
 */

/** Everything the page needs to render; no state is read from the request. */
export interface LoginPageOptions {
  /** Overrides the `<title>`/heading when the deployment names its proxy. */
  title?: string
  /** Human-readable error shown above the form (already localized by the caller). */
  error?: string
  /** Path the form posts to (the login endpoint). */
  action: string
  /** Whether the visitor arrived over TLS (a trusted proxy reported https). */
  secure: boolean
}

/** HTML-escape a value interpolated into the document. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render the login document.
 * @param options - title, error and the form target.
 * @returns a complete HTML document as a string.
 */
export function renderLoginPage(options: LoginPageOptions): string {
  const title = escapeHtml(options.title ?? 'DSH 局域网代理')
  const action = escapeHtml(options.action)
  const error = options.error === undefined || options.error === ''
    ? ''
    : `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
  const insecure = options.secure
    ? ''
    : '<p class="warn" role="alert">当前连接未加密（HTTP）：密码会以明文经过网络，请让反向代理启用 HTTPS 后再登录。</p>'

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: #0f1115; color: #e6edf3;
  font: 14px/22px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
main { width: min(360px, calc(100vw - 32px)); padding: 24px; border: 1px solid #30363d; border-radius: 12px; background: #161b22; }
h1 { margin: 0 0 4px; font-size: 18px; line-height: 26px; }
p.sub { margin: 0 0 16px; color: #8b949e; font-size: 12px; line-height: 18px; }
label { display: block; margin: 0 0 4px; color: #c9d1d9; font-size: 13px; }
input {
  width: 100%; margin: 0 0 12px; padding: 8px 10px;
  border: 1px solid #30363d; border-radius: 8px; background: #0d1117; color: #e6edf3;
  font: inherit;
}
input:focus-visible { outline: 2px solid #2f81f7; outline-offset: 1px; }
button {
  width: 100%; padding: 8px 14px; border: 1px solid #2f81f7; border-radius: 8px;
  background: #2f81f7; color: #fff; font: inherit; font-weight: 500; cursor: pointer;
}
button:hover { background: #388bfd; border-color: #388bfd; }
p.error { margin: 0 0 12px; padding: 8px 10px; border-left: 3px solid #f85149; border-radius: 4px; background: rgb(248 81 73 / 12%); color: #ff7b72; font-size: 13px; }
p.warn { margin: 12px 0 0; padding: 8px 10px; border-left: 3px solid #d29922; border-radius: 4px; background: rgb(210 153 34 / 12%); color: #d29922; font-size: 12px; line-height: 18px; }
@media (prefers-color-scheme: light) {
  body { background: #f6f7f9; color: #0f1115; }
  main { background: #fff; border-color: #d7dbe0; }
  p.sub { color: #61666b; }
  label { color: #3c4149; }
  input { background: #fff; border-color: #d7dbe0; color: #0f1115; }
  p.error { color: #b3261e; }
}
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p class="sub">请输入用户名和密码以访问 DSH。</p>
  ${error}
  ${insecure}
  <form method="post" action="${action}" autocomplete="on">
    <label for="username">用户名</label>
    <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">登录</button>
  </form>
</main>
</body>
</html>
`
}

/** Localized failure copy for the login page, keyed by the auth core's reason. */
export function loginFailureMessage(
  reason: 'invalid' | 'locked' | 'disabled',
  retryAfterMs: number,
): string {
  if (reason === 'locked') {
    const minutes = Math.max(1, Math.ceil(retryAfterMs / 60000))
    return `失败次数过多，请在约 ${minutes} 分钟后重试。`
  }
  if (reason === 'disabled') return '管理员尚未设置密码，无法登录。'
  // One message for a wrong username and a wrong password: nothing to enumerate.
  return '用户名或密码不正确。'
}
