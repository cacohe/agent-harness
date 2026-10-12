/** 本地聊天页面的静态结构。 */
export const uiHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Harness</title><link rel="stylesheet" href="/assets/app.css"></head>
<body><main><aside><h1>Agent Harness</h1><p>本地 Agent 会话</p><button id="new-chat">新建会话</button><small id="session"></small></aside>
<section><header><span class="status" id="status">连接中</span><button id="cancel" disabled>取消当前执行</button></header>
<ol id="messages" aria-live="polite"></ol><form id="composer"><textarea id="input" rows="3" placeholder="输入消息；Agent 运行时也可以继续发送" required></textarea><button>发送</button></form></section></main><script type="module" src="/assets/app.js"></script></body></html>`
