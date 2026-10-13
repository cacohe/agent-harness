import { renderMarkdown } from './markdown.js';

/** 浏览器端负责渲染 SSE 通知和发送本地消息，不保存模型密钥。 */
export const uiScript = `${renderMarkdown.toString()}
const body=document.body;
const messages=document.querySelector('#messages');
const emptyState=document.querySelector('#empty-state');
const input=document.querySelector('#input');
const form=document.querySelector('#composer');
const status=document.querySelector('#status span');
const cancel=document.querySelector('#cancel');
const workspaceLabel=document.querySelector('#workspace');
const dialog=document.querySelector('#workspace-dialog');
const workspaceForm=document.querySelector('#workspace-form');
const workspaceBrowse=document.querySelector('#workspace-browse');
const workspacePath=document.querySelector('#workspace-path');
const workspaceError=document.querySelector('#workspace-error');
const WORKSPACE_KEY='agent-harness.workspace';
const SESSION_KEY='agent-harness.session';
let sessionId='';let source;let activeAssistant;let activeMarkdown='';let pending=0;let connection='connecting';

function renderAssistant(el,text){el.innerHTML=renderMarkdown(text);}
function updateStatus(){body.dataset.connection=connection;cancel.disabled=pending===0||sessionId==='';status.textContent=connection==='offline'?'连接中断，正在重连':sessionId===''?'等待选择工作目录':pending===0?'准备就绪':'正在处理 '+pending+' 条消息';}
function setSessionMeta(workspace){workspaceLabel.textContent=workspace||'未选择';workspaceLabel.title=workspace||'';}
function showWorkspacePicker(){dialog.hidden=false;workspaceError.hidden=true;workspaceBrowse.disabled=false;workspaceBrowse.textContent='选择文件夹';const last=localStorage.getItem(WORKSPACE_KEY)||'';workspacePath.hidden=!last;workspacePath.textContent=last?('上次：'+last):'';connection='connecting';updateStatus();}
function hideWorkspacePicker(){dialog.hidden=true;}
function saveSession(id,workspace){localStorage.setItem(SESSION_KEY,JSON.stringify({sessionId:id}));localStorage.setItem(WORKSPACE_KEY,workspace);}
function clearSavedSession(){localStorage.removeItem(SESSION_KEY);}
function readSavedSession(){try{const value=JSON.parse(localStorage.getItem(SESSION_KEY)||'');if(value&&typeof value.sessionId==='string')return value;}catch{}return undefined;}
function renderHistory(items){activeAssistant=undefined;activeMarkdown='';messages.replaceChildren();if(!items.length){emptyState.hidden=false;return;}for(const item of items)add(item.kind,item.content);}
function attachSession(opened){sessionId=opened.sessionId;saveSession(opened.sessionId,opened.workspace);setSessionMeta(opened.workspace);hideWorkspacePicker();connect();updateStatus();input.focus();}
async function closeSession(id){return fetch('/sessions/'+encodeURIComponent(id)+'/close',{method:'POST'}).catch(()=>undefined);}
function disconnect(){source?.close();source=undefined;if(sessionId)void closeSession(sessionId);sessionId='';activeAssistant=undefined;activeMarkdown='';pending=0;}
function newSession(){disconnect();clearSavedSession();messages.replaceChildren();emptyState.hidden=false;setSessionMeta('');showWorkspacePicker();}
function connect(){source=new EventSource('/sessions/'+encodeURIComponent(sessionId)+'/events');source.onopen=()=>{connection='online';updateStatus();};source.addEventListener('snapshot',event=>{renderHistory(JSON.parse(event.data).messages||[]);});source.addEventListener('stream',event=>{const value=JSON.parse(event.data);if(value.type==='text.delta'){activeAssistant??=add('assistant','');activeMarkdown+=value.text;renderAssistant(activeAssistant,activeMarkdown);activeAssistant.scrollIntoView({block:'end',behavior:'smooth'});}});source.addEventListener('session',event=>{const execution=JSON.parse(event.data);if(execution.type!=='session.event')return;const value=execution.envelope.event;if(value.type==='assistant.settled'&&value.settlement.status==='completed'){activeAssistant??=add('assistant','');renderAssistant(activeAssistant,value.settlement.message.content);activeAssistant=undefined;activeMarkdown='';}if(value.type==='tool.completed')add('tool','工具执行完成：'+value.result.status);});source.addEventListener('completed',settled);source.addEventListener('failed',event=>{add('tool',JSON.parse(event.data).message);activeAssistant=undefined;activeMarkdown='';settled();});source.onerror=()=>{connection='offline';updateStatus();};}
function add(kind,text){emptyState.hidden=true;const item=document.createElement('li');item.className='message '+kind;const avatar=document.createElement('span');avatar.className='message-avatar';avatar.textContent=kind==='user'?'你':kind==='assistant'?'A':'系统';const copy=document.createElement('div');copy.className='message-copy';if(kind!=='tool'){const label=document.createElement('span');label.className='message-label';label.textContent=kind==='user'?'你':'Agent';copy.append(label);}const message=document.createElement('div');message.className='message-body';if(kind==='assistant')renderAssistant(message,text);else message.textContent=text;copy.append(message);if(kind==='tool'){copy.replaceChildren(message);item.append(copy);}else{item.append(avatar,copy);}messages.append(item);item.scrollIntoView({block:'end',behavior:'smooth'});return message;}
function settled(){pending=Math.max(0,pending-1);updateStatus();}
async function submit(){const content=input.value.trim();if(!content||!sessionId)return;const messageId=crypto.randomUUID();add('user',content);input.value='';pending+=1;updateStatus();try{const response=await fetch('/sessions/'+encodeURIComponent(sessionId)+'/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content,messageId})});if(!response.ok){add('tool',await response.text());settled();}}catch(error){add('tool',error instanceof Error?error.message:String(error));settled();}}
async function startWorkspace(event){event.preventDefault();workspaceError.hidden=true;workspaceBrowse.disabled=true;workspaceBrowse.textContent='请在系统对话框中选择…';try{const browse=await fetch('/workspace/browse',{method:'POST'});if(browse.status===409){workspaceBrowse.disabled=false;workspaceBrowse.textContent='选择文件夹';return;}if(!browse.ok){workspaceError.textContent=await browse.text();workspaceError.hidden=false;workspaceBrowse.disabled=false;workspaceBrowse.textContent='选择文件夹';return;}const picked=await browse.json();const response=await fetch('/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspace:picked.workspace})});if(!response.ok){workspaceError.textContent=await response.text();workspaceError.hidden=false;workspaceBrowse.disabled=false;workspaceBrowse.textContent='选择文件夹';return;}attachSession(await response.json());}catch(error){workspaceError.textContent=error instanceof Error?error.message:String(error);workspaceError.hidden=false;workspaceBrowse.disabled=false;workspaceBrowse.textContent='选择文件夹';}}
async function restoreSession(){const saved=readSavedSession();if(!saved){showWorkspacePicker();updateStatus();return;}try{const response=await fetch('/sessions/'+encodeURIComponent(saved.sessionId)+'/open',{method:'POST'});if(!response.ok){clearSavedSession();showWorkspacePicker();return;}attachSession(await response.json());}catch{showWorkspacePicker();}}

form.addEventListener('submit',event=>{event.preventDefault();void submit();});
input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();form.requestSubmit();}});
cancel.addEventListener('click',()=>{if(sessionId)fetch('/sessions/'+encodeURIComponent(sessionId)+'/cancel',{method:'POST'});});
workspaceForm.addEventListener('submit',event=>void startWorkspace(event));
window.addEventListener('pagehide',()=>{source?.close();});
document.querySelector('#new-chat').addEventListener('click',newSession);
setSessionMeta('');
updateStatus();
void restoreSession();`;
