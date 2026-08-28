// Isolated UI fixture. No dotenv, database, upstream proxy, or successful writes.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import ts from 'typescript'
import tailwindConfig from '../tailwind.config.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const referenceRoot = resolve(root, '../赛智伯乐FDE')
const week = '2026-08-24'
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const user = { id: id(1), name: '沈嘉言', email: 'visual@example.invalid', role: '投资经理', department: '隔离视觉夹具' }
const projects = ['星澜科技', '三期基金首关'].map((name, i) => ({ id: id(10+i), name, projectType: i ? '基金设立' : '投资项目', workflowModel: 'fde-v1', lifecycle: 'active', status: '正常', ownerUserId: user.id }))
const tasks = ['完成核心客户访谈', '汇总尽调资料与验证结果', '确认首关材料与本周目标'].map((title, i) => ({ id: id(20+i), version: 1, progress: i === 1 ? 100 : 30, deliverable: '验证结果与记录', projectId: projects[i === 2 ? 1 : 0].id, title, owner: i === 1 ? '林若晨' : user.name, ownerUserId: i === 1 ? id(2) : user.id, dueDate: '2026-08-28', dueTime: '17:00', status: i === 1 ? '已完成' : '进行中', executionModel: 'fde-v1', directiveId: null, planActionId: null, timelineSource: { needLeader: i === 0, stage: '尽调' }, feedbacks: [], extensions: [], capabilities: { canFeedback: i !== 1, canAccept: false, canExtend: i !== 1, canCancel: false } }))
const calendar = [
  { key: 'personal:1', id: id(30), source: 'personal', ownerId: user.id, ownerName: user.name, title: '项目资料整理', detail: '仅视觉验证', startsAt: '2026-08-24T02:00:00Z', endsAt: '2026-08-24T03:00:00Z', allDay: false, version: 1, visibility: 'private', editable: true, target: null },
  { key: 'busy:2', id: null, source: 'busy', ownerId: id(2), ownerName: '林若晨', title: '已占用', detail: '', startsAt: '2026-08-25T06:00:00Z', endsAt: '2026-08-25T07:00:00Z', allDay: false, version: null, editable: false, target: null },
]
const meetings = projects.map((project, i) => ({ id: id(40+i), title: project.name+'周五例会', projectId: project.id, host: user.name, hostUserId: user.id, startedAt: '2026-08-28T08:00:00Z', endsAt: '2026-08-28T09:00:00Z', workflowStatus: 'scheduled', version: 1, plans: [], events: [], participants: [], weeklyReview: null }))
const leaderRows = [0,1].map(i => ({ id:id(60+i),projectId:projects[0].id,projectName:projects[0].name,leaderId:user.id,leaderName:user.name,title:i?'项目阶段成果评审':'核心客户访谈支持',reason:'需要领导参与',outcome:'确认后续推进意见',impact:'影响项目尽调节奏',priority:'P1',latestFinish:'2026-08-28T09:00:00Z',scheduleNote:null,preferredStart:'2026-08-25T02:00:00Z',alternativeStart:'2026-08-26T02:00:00Z',scheduledStart:i?'2026-08-26T06:00:00Z':null,durationMinutes:60,location:'会议室',status:i?'confirmed':'requested',version:1,supplementNote:null,conflicts:[],events:[],notices:[],timelineSource:null,capabilities:{edit:false,submit:false,coordinate:!i,confirm:false,reject:false,supplement:false,withdraw:false,'refresh-source':false} }))
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter,Routes,Route,useParams} from 'react-router-dom';import {ToastProvider} from './src/components/Toast';import {CollaborationPage} from './src/pages/CollaborationPage';import {FdeTaskPanel} from './src/components/FdeTaskPanel';import {useAuthStore} from './src/store/useAuthStore';import {useAppStore} from './src/store/useAppStore';const projects=${JSON.stringify(projects)};useAuthStore.getState().setAuth({user:${JSON.stringify(user)}});useAppStore.setState({currentUser:${JSON.stringify(user)},projects});function TaskFixture(){const {id}=useParams();return <FdeTaskPanel project={projects.find(p=>p.id===id)} files={[]} onChanged={async()=>{}}/>}createRoot(document.getElementById('root')).render(<BrowserRouter><ToastProvider><div className="fde-app"><main className="fde-page-content"><Routes><Route path="/projects/:id" element={<TaskFixture/>}/><Route path="*" element={<CollaborationPage/>}/></Routes></main></div></ToastProvider></BrowserRouter>);`
const bundled = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root }, bundle: true, write: false, outdir: '/visual-fixture', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' })
const js = bundled.outputFiles.find(file => file.path.endsWith('.js')).text
const baseCss = (await postcss([tailwindcss({ ...tailwindConfig, content: [resolve(root,'src/**/*.{ts,tsx}')] }), autoprefixer]).process(await readFile(resolve(root,'src/styles.css'),'utf8'),{ from: resolve(root,'src/styles.css') })).css
const css = baseCss+'\n'+await readFile(resolve(root,'src/layout/fde-shell.css'),'utf8')+'\n'+bundled.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n')
const source = await readFile(resolve(referenceRoot,'site.js'),'utf8'), referenceCss = await readFile(resolve(referenceRoot,'site.css'),'utf8')
const ast = ts.createSourceFile('site.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const wanted = new Set(['badge','pageHeading','weeklyBattleView','executionPage','meetingReviewView','unifiedCalendarView','personalCalendarView','companyCalendarView'])
const renderSource = ast.statements.flatMap(node => {
  if (ts.isFunctionDeclaration(node) && wanted.has(node.name?.text)) return [node.getText(ast)]
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.filter(d => wanted.has(d.name.getText(ast))).map(d => `const ${d.getText(ast)};`)
  return []
}).join('\n')
const escape = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c])
function renderReference(view) {
  const company = view === 'company'
  const referenceProjects = projects.map(p=>({...p,type:p.projectType}))
  const sandbox = { roles:[{key:'member',name:user.name}],state:{roleIndex:0,executionView:view==='review'?'周报与例会':view==='calendar'||company?'日历':'本周工作',executionGroup:'按项目',calendarScope:company?'公司总表':'我的日历',calendarLayer:'我的安排'},escapeHtml:escape,escapeAttr:escape,
    PRODUCT_WEEK_START:week,LEADERSHIP_DAY_START:420,LEADERSHIP_DAY_END:1200,LEADERSHIP_HOUR_PX:52,LEADERSHIP_SLOT_MINUTES:15,
    visibleExecutionActions:()=>tasks.map(t=>({...t,needLeader:t.timelineSource.needLeader,source:'final-timeline',due:t.dueDate,blocked:''})),actionRecordClosed:a=>a.status==='已完成',projectForId:projectId=>referenceProjects.find(p=>p.id===projectId),leadershipRequests:[],extensionForAction:()=>null,
    can:(role,action,item)=>Boolean(item?.capabilities?.canFeedback&&['action:feedback','extension:request','action:claim-complete'].includes(action)),projectLogo:p=>'<span class="project-logo">'+escape(p.name[0])+'</span>',actionSourceLabel:()=> '尽调流程行动',effectiveActionDueLabel:a=>a.dueDate+' '+a.dueTime,statusTone:s=>s==='已完成'?'success':'info',leadershipSummary:()=>({pending:0}),
    weeklyMeetings:meetings.map(m=>({...m,status:'待召开',time:'周五 16:00',completion:'0/2',nextPlan:'下周工作待确认'})),weeklyReports:[],canAccessProject:()=>true,
    organizationPeople:[{id:user.id,name:user.name,role:user.role,status:'正常'},{id:id(2),name:'林若晨',role:'项目成员',status:'正常'}],
    leadershipWeekDays:()=>Array.from({length:7},(_,i)=>[['周一','周二','周三','周四','周五','周六','周日'][i],'2026-08-'+(24+i),String(24+i)]),
    calendarWeekControls:()=>'<div class="calendar-week-controls"><button class="icon-btn">‹</button><button class="button">本周</button><button class="icon-btn">›</button></div>',
    calendarEntriesForPerson:name=>calendar.filter(c=>c.ownerName===name).map(c=>({...c,start:new Date(Date.parse(c.startsAt)+8*3600000).toISOString().slice(0,16),duration:60,displayTitle:c.title,kind:c.source==='personal'?'个人安排':'已占用',source:c.source==='personal'?'个人安排':'占用',redacted:c.source==='busy',capacity:'busy'})),
    leadershipOverlapPlacements:()=>new Map(),leadershipCalendarGeometry:item=>({top:(Number(item.scheduledStart.slice(11,13))*60+Number(item.scheduledStart.slice(14,16))-420)*52/60,height:52}),leadershipPlacementStyle:()=> 'left:4px;right:4px;',personalScheduleConflictCount:()=>0,
  }
  return vm.runInNewContext(renderSource+'\nexecutionPage()',sandbox,{timeout:1000})
}
function api(path, params, scenario) {
  if(scenario==='error')throw new Error('视觉夹具：接口加载失败')
  if(path==='/api/workbench')return {actorId:user.id,view:scenario==='admin'?'admin':scenario==='coordinator'?'coordinator':'member'}
  if(path==='/api/projects')return {list:projects}
  if(path.endsWith('/fde-tasks'))return {members:[],reviewers:[{id:id(2),name:'林若晨'}],canAssign:false,canSyncPlan:false,canSyncTimeline:false,timelinePending:{count:0,items:[]},tasks:scenario==='empty'?[]:tasks.filter(t=>path.includes(t.projectId)).map(t=>scenario==='denied'?{...t,capabilities:{canFeedback:false,canExtend:false,canAccept:false,canCancel:false}}:t)}
  if(path.endsWith('/weekly-plans'))return {canDraft:scenario!=='denied',canPublish:false,plans:[],members:[],notices:[],leaderTimePendingCount:0,leaderTimePending:[]}
  if(path==='/api/weekly-reports')return {reports:[]}
  if(path.endsWith('/friday-meetings'))return {list:scenario==='empty'?[]:meetings.filter(m=>path.includes(m.projectId)),canManage:scenario!=='denied',canDerive:false,members:[],notices:[]}
  if(path==='/api/calendar')return {items:scenario==='empty'?[]:calendar.filter(c=>params.get('view')==='company'||c.ownerId===user.id),notice:'隔离视觉样本；无权日程只显示已占用。'}
  if(path==='/api/leader-time')return {list:scenario==='empty'?[]:leaderRows,projects:scenario==='denied'?[]:projects,leaders:scenario==='denied'?[]:[{id:user.id,name:user.name}]}
  throw new Error('视觉夹具：未定义的只读接口 '+path)
}
let rejectedWrites=0
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'),path=url.pathname
  const send=(status,type,body)=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"});res.end(body)}
  if(!['GET','HEAD'].includes(req.method)){rejectedWrites++;return send(503,'application/json',JSON.stringify({message:'隔离视觉夹具禁止所有写操作'}))}
  if(path.startsWith('/api/')){try{return send(200,'application/json',JSON.stringify(api(path,url.searchParams,new URL(req.headers.referer??'/',url).searchParams.get('fixture'))))}catch(error){return send(503,'application/json',JSON.stringify({message:error.message}))}}
  if(path==='/app.js')return send(200,'text/javascript',js)
  if(path==='/app.css')return send(200,'text/css',css)
  if(path==='/reference.css')return send(200,'text/css',referenceCss)
  const reference=path==='/reference'
  try { return send(200,'text/html','<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>协同中心 · '+(reference?'原版':'迁移版')+'隔离视觉夹具</title><link rel="stylesheet" href="'+(reference?'/reference.css':'/app.css')+'"><style>html,body{min-width:0;margin:0}.fixture-frame{margin-left:244px;padding-top:64px}.fixture-label{position:fixed;bottom:8px;right:10px;background:#fff9df;padding:4px 8px;font:11px system-ui;z-index:9999}@media(max-width:900px){.fixture-frame{margin-left:0}}</style><body><div class="fixture-frame">'+(reference?'<main id="pageContent">'+renderReference(url.searchParams.get('view'))+'</main>':'<div id="root"></div>')+'</div><div class="fixture-label">'+(reference?'原版':'迁移版')+' · 隔离视觉夹具 · 非业务数据</div>'+(reference?'':'<script type="module" src="/app.js"></script>')+'</body></html>') } catch(error){send(500,'text/plain',error.stack)}
})
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port,pid:process.pid,database:'none',writes:'always rejected'})))
const stop=()=>server.close(()=>{console.log(JSON.stringify({stopped:true,rejectedWrites}));process.exit(0)})
process.on('SIGTERM',stop)
process.on('SIGINT',stop)
