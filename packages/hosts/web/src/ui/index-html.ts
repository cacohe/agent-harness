/** 本地聊天页面的静态结构。 */
export const uiHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="theme-color" content="#101826">
    <title>Agent Harness</title>
    <link rel="stylesheet" href="/assets/app.css">
  </head>
  <body data-connection="connecting">
    <div class="app-shell">
      <aside class="sidebar" aria-label="会话导航">
        <div class="brand"><span class="brand-mark" aria-hidden="true">A</span><span>Agent Harness</span></div>
        <button class="new-chat" id="new-chat" type="button"><span aria-hidden="true">+</span> 新建对话</button>
        <nav class="session-nav" aria-label="当前会话">
          <p class="nav-label">当前会话</p>
          <div class="session-card"><span class="session-dot" aria-hidden="true"></span><div><strong>未命名会话</strong><small id="session" title="">准备中</small></div></div>
        </nav>
        <div class="sidebar-footer"><span class="local-indicator"><i aria-hidden="true"></i> 仅本机运行</span><p>会话内容保存在此设备。</p></div>
      </aside>
      <main class="conversation">
        <header class="topbar">
          <div><p class="eyebrow">本地工作台</p><h1>Agent 对话</h1></div>
          <div class="connection-status" id="status" aria-live="polite"><i aria-hidden="true"></i><span>正在连接</span></div>
        </header>
        <section class="chat-surface" aria-label="对话内容">
          <div class="empty-state" id="empty-state"><div class="empty-mark" aria-hidden="true">✦</div><h2>开始一段本地对话</h2><p>告诉 Agent 你的目标。运行期间也可以继续发送消息，系统会按顺序处理。</p><div class="prompt-hints" aria-label="使用提示"><span>描述目标</span><span>补充上下文</span><span>继续追问</span></div></div>
          <ol id="messages" aria-live="polite" aria-label="消息"></ol>
        </section>
        <form id="composer" class="composer">
          <label class="sr-only" for="input">发送给 Agent 的消息</label>
          <textarea id="input" rows="1" placeholder="给 Agent 发送消息…" required></textarea>
          <div class="composer-footer"><span>Enter 发送 · Shift + Enter 换行</span><div class="composer-actions"><button class="cancel" id="cancel" type="button" disabled>取消执行</button><button class="send" type="submit">发送 <span aria-hidden="true">↑</span></button></div></div>
        </form>
      </main>
    </div>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>`
