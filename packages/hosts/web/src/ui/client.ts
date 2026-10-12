/** 浏览器端负责渲染 SSE 通知和发送本地消息，不保存模型密钥。 */
export const uiScript = `const body=document.body;
const messages=document.querySelector('#messages');
const emptyState=document.querySelector('#empty-state');
const input=document.querySelector('#input');
const form=document.querySelector('#composer');
const status=document.querySelector('#status span');
const cancel=document.querySelector('#cancel');
const sessionLabel=document.querySelector('#session');
let sessionId='';let source;let activeAssistant;let pending=0;let connection='connecting';

function updateStatus(){body.dataset.connection=connection;cancel.disabled=pending===0;status.textContent=connection==='offline'?'连接中断，正在重连':pending===0?'准备就绪':'正在处理 '+pending+' 条消息';}
function setSessionLabel(){sessionLabel.textContent=sessionId.slice(0,8);sessionLabel.title=sessionId;}
function newSession(){const previous=sessionId;source?.close();if(previous)void closeSession(previous);sessionId=crypto.randomUUID();setSessionLabel();messages.replaceChildren();emptyState.hidden=false;activeAssistant=undefined;pending=0;connection='connecting';connect();updateStatus();input.focus();}
function closeSession(id){return fetch('/sessions/'+encodeURIComponent(id)+'/close',{method:'POST'}).catch(()=>undefined);}
function add(kind,text){emptyState.hidden=true;const item=document.createElement('li');item.className='message '+kind;const avatar=document.createElement('span');avatar.className='message-avatar';avatar.textContent=kind==='user'?'你':kind==='assistant'?'A':'系统';const copy=document.createElement('div');copy.className='message-copy';if(kind!=='tool'){const label=document.createElement('span');label.className='message-label';label.textContent=kind==='user'?'你':'Agent';copy.append(label);}const message=document.createElement('div');message.className='message-body';message.textContent=text;copy.append(message);if(kind==='tool'){copy.replaceChildren(message);item.append(copy);}else{item.append(avatar,copy);}messages.append(item);item.scrollIntoView({block:'end',behavior:'smooth'});return message;}
function settled(){pending=Math.max(0,pending-1);updateStatus();}
function connect(){source=new EventSource('/sessions/'+encodeURIComponent(sessionId)+'/events');source.onopen=()=>{connection='online';updateStatus();};source.addEventListener('stream',event=>{const value=JSON.parse(event.data);if(value.type==='text.delta'){activeAssistant??=add('assistant','');activeAssistant.textContent+=value.text;}});source.addEventListener('session',event=>{const value=JSON.parse(event.data).envelope.event;if(value.type==='assistant.settled'&&value.settlement.status==='completed'){activeAssistant??=add('assistant','');activeAssistant.textContent=value.settlement.message.content;activeAssistant=undefined;}if(value.type==='tool.completed')add('tool','工具执行完成：'+value.result.status);});source.addEventListener('completed',settled);source.addEventListener('failed',event=>{add('tool',JSON.parse(event.data).message);activeAssistant=undefined;settled();});source.onerror=()=>{connection='offline';updateStatus();};}
async function submit(){const content=input.value.trim();if(!content)return;add('user',content);input.value='';pending+=1;updateStatus();try{const response=await fetch('/sessions/'+encodeURIComponent(sessionId)+'/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content})});if(!response.ok){add('tool',await response.text());settled();}}catch(error){add('tool',error instanceof Error?error.message:String(error));settled();}}

form.addEventListener('submit',event=>{event.preventDefault();void submit();});
input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();form.requestSubmit();}});
cancel.addEventListener('click',()=>fetch('/sessions/'+encodeURIComponent(sessionId)+'/cancel',{method:'POST'}));
window.addEventListener('pagehide',()=>{source?.close();if(sessionId)void fetch('/sessions/'+encodeURIComponent(sessionId)+'/close',{method:'POST',keepalive:true}).catch(()=>undefined);});
document.querySelector('#new-chat').addEventListener('click',newSession);
newSession();`
