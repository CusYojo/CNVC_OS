import { BookOpen, FileSpreadsheet, FolderOpen, Grid2X2, List, UploadCloud } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useMemo, useState } from 'react'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, DataTable, FileUpload, Modal, PageHeader, SearchInput, StatusBadge, TableCell } from '../components/ui'
import { useAuthStore } from '../store/useAuthStore'

const fileCategories = ['全部分类', '项目资料', '尽调资料', '会议资料', '上会材料', '公开情报', '公司知识库']

export function KnowledgePage() {
  const files = useAppStore((state) => state.files)
  const meetings = useAppStore((state) => state.meetings)
  const projects = useAppStore((state) => state.projects)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用' })
  const addFile = useAppStore((state) => state.addFile)
  const deleteFile = useAppStore((state) => state.deleteFile)
  const finishFileParsing = useAppStore((state) => state.finishFileParsing)
  const { showToast } = useToast()
  const initialProjectId = projects.find((project) => currentUser.role === '系统管理员' || project.owner === currentUser.name || project.collaborators.includes(currentUser.name))?.id ?? 'org'
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId)
  const [uploadProjectId, setUploadProjectId] = useState(initialProjectId)
  const [category, setCategory] = useState('全部分类')
  const [query, setQuery] = useState('')
  const [visibility, setVisibility] = useState('')
  const [showUpload, setShowUpload] = useState(false)
  const [kbTab, setKbTab] = useState<'files' | 'input' | 'meetings'>('files')
  const [view, setView] = useState<'list' | 'grid'>('list')

  const accessibleProjects = projects.filter((project) => currentUser.role === '系统管理员' || project.owner === currentUser.name || project.collaborators.includes(currentUser.name))
  const selectedProject = accessibleProjects.find((project) => project.id === selectedProjectId)
  const filtered = useMemo(() => files.filter((file) => {
    const projectMatched = selectedProjectId === 'all' || (selectedProjectId === 'org' ? !file.projectId : file.projectId === selectedProjectId)
    const categoryMatched = category === '全部分类' || file.category === category || file.category.includes(category.replace('资料', ''))
    return projectMatched && categoryMatched && (!query || `${file.name}${file.category}`.toLowerCase().includes(query.toLowerCase())) && (!visibility || file.visibility === visibility)
  }), [files, selectedProjectId, category, query, visibility])

  const handleDeleteFile = async (file: { id: string; name: string }) => {
    if (!window.confirm(`确认删除资料「${file.name}」？\n将同时从知识库(RAG)移除其内容，此操作不可恢复。`)) return
    try { await deleteFile(file.id); showToast(`已删除「${file.name}」`) }
    catch (e) { showToast(`删除失败：${(e as Error).message}`, 'error') }
  }

  const upload = (file: File) => {
    const projectId = uploadProjectId === 'org' ? undefined : uploadProjectId
    const project = projects.find((item) => item.id === projectId)
    addFile({
      projectId,
      name: file.name,
      type: file.name.split('.').pop()?.toUpperCase() ?? 'FILE',
      category: project ? '项目资料' : '公司知识库',
      size: `${(file.size / 1024 / 1024).toFixed(1)} MB`,
      uploader: currentUser.name,
      parseStatus: '解析中',
      visibility: project ? '项目成员' : '全公司',
    })
    const item = useAppStore.getState().files[0]
    setSelectedProjectId(projectId ?? 'org')
    setShowUpload(false)
    showToast(`资料已归档至“${project?.name ?? '机构公共知识库'}”，正在解析`)
    window.setTimeout(() => { finishFileParsing(item.id); showToast('资料解析完成，已可被 AI 检索') }, 1200)
  }

  return (
    <div>
      <PageHeader title="项目知识库" description="以项目为一级目录管理 BP、尽调、会议与上会材料；机构公共资料单独归档。" actions={<Button onClick={() => { setUploadProjectId(selectedProjectId === 'all' ? projects[0]?.id ?? 'org' : selectedProjectId); setShowUpload(true) }}><UploadCloud className="h-4 w-4" />上传资料</Button>} />
      <div className="grid grid-cols-[270px_1fr] gap-5">
        <Card className="self-start overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-4"><p className="text-xs font-semibold text-slate-700">项目目录</p><p className="mt-1 text-[10px] text-slate-400">资料必须归属项目或机构公共库</p></div>
          <div className="p-2">
            <button onClick={() => setSelectedProjectId('all')} className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${selectedProjectId === 'all' ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}><BookOpen className="h-4 w-4" /><span className="flex-1 text-left">全部项目资料</span><span className="text-[10px] text-slate-400">{files.length}</span></button>
            <button onClick={() => setSelectedProjectId('org')} className={`mb-3 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${selectedProjectId === 'org' ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}><FileSpreadsheet className="h-4 w-4" /><span className="flex-1 text-left">机构公共知识</span><span className="text-[10px] text-slate-400">{files.filter((file) => !file.projectId).length}</span></button>
            <p className="border-t border-slate-100 px-3 pb-2 pt-3 text-[10px] font-medium text-slate-400">我的专属项目</p>
            {accessibleProjects.filter((project) => project.owner === currentUser.name).map((project) => <button key={project.id} onClick={() => setSelectedProjectId(project.id)} className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${selectedProjectId === project.id ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}><FolderOpen className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-left">{project.name}</span><span className="text-[10px] text-slate-400">{files.filter((file) => file.projectId === project.id).length}</span></button>)}
            <p className="border-t border-slate-100 px-3 pb-2 pt-3 text-[10px] font-medium text-slate-400">协作项目</p>
            {accessibleProjects.filter((project) => project.owner !== currentUser.name).map((project) => <button key={project.id} onClick={() => setSelectedProjectId(project.id)} className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${selectedProjectId === project.id ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}><FolderOpen className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-left">{project.name}</span><span className="text-[10px] text-slate-400">{files.filter((file) => file.projectId === project.id).length}</span></button>)}
          </div>
        </Card>

        <div>
          <div className="mb-4 flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1 text-sm">
            {([['files','资料库'],['input','知识库输入'],['meetings','会议纪要']] as const).map(([k,label]) => (
              <button key={k} onClick={() => setKbTab(k)} className={`flex-1 rounded-md px-3 py-1.5 ${kbTab === k ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>{label}</button>
            ))}
          </div>
          {kbTab === 'files' && <><Card className="mb-4 p-4"><div className="flex items-center gap-3"><SearchInput className="w-[300px]" placeholder="搜索当前项目资料…" value={query} onChange={(event) => setQuery(event.target.value)} /><select className="input w-36" value={category} onChange={(event) => setCategory(event.target.value)}>{fileCategories.map((item) => <option key={item}>{item}</option>)}</select><select className="input w-36" value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="">全部权限</option><option>项目成员</option><option>管理层</option><option>全公司</option></select><div className="ml-auto flex rounded-lg border border-slate-200 p-0.5"><button aria-label="列表视图" onClick={() => setView('list')} className={`grid h-8 w-8 place-items-center rounded-md ${view === 'list' ? 'bg-slate-100 text-slate-700' : 'text-slate-400'}`}><List className="h-4 w-4" /></button><button aria-label="网格视图" onClick={() => setView('grid')} className={`grid h-8 w-8 place-items-center rounded-md ${view === 'grid' ? 'bg-slate-100 text-slate-700' : 'text-slate-400'}`}><Grid2X2 className="h-4 w-4" /></button></div></div></Card>
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h2 className="font-semibold text-slate-800">{selectedProjectId === 'all' ? '全部项目资料' : selectedProjectId === 'org' ? '机构公共知识' : selectedProject?.name}</h2><p className="mt-1 text-xs text-slate-400">当前目录 {filtered.length} 份资料 · AI 引用保留项目、文件和片段定位</p></div><Badge tone="green">向量检索正常</Badge></div>
            {view === 'list' ? <DataTable headers={['资料名称', '所属项目', '分类', '上传人', '权限范围', '解析状态', '更新时间', '操作']}>{filtered.map((file) => <tr key={file.id} className="hover:bg-slate-50"><TableCell><span className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-blue-50 text-[9px] font-semibold text-blue-600">{file.type}</span><span><span className="block font-medium text-slate-700">{file.name}</span><span className="mt-1 block text-xs text-slate-400">{file.size} · V{file.version}</span></span></span></TableCell><TableCell>{projects.find((project) => project.id === file.projectId)?.name ?? '机构公共知识'}</TableCell><TableCell><Badge>{file.category}</Badge></TableCell><TableCell>{file.uploader}</TableCell><TableCell>{file.visibility}</TableCell><TableCell><StatusBadge status={file.parseStatus} /></TableCell><TableCell>{file.uploadedAt.slice(5)}</TableCell><TableCell><button onClick={() => handleDeleteFile(file)} className="rounded-md px-2 py-1 text-xs text-rose-600 hover:bg-rose-50">删除</button></TableCell></tr>)}</DataTable> : <div className="grid grid-cols-3 gap-4 p-5">{filtered.map((file) => <div key={file.id} className="rounded-xl border border-slate-200 p-4 hover:border-brand-200"><span className="grid h-10 w-10 place-items-center rounded-lg bg-blue-50 text-[10px] font-semibold text-blue-600">{file.type}</span><p className="mt-4 truncate text-sm font-medium text-slate-700">{file.name}</p><p className="mt-1 text-xs text-slate-400">{projects.find((project) => project.id === file.projectId)?.name ?? '机构公共知识'} · {file.category}</p><div className="mt-3 flex items-center justify-between"><StatusBadge status={file.parseStatus} /><button onClick={() => handleDeleteFile(file)} className="text-[10px] text-rose-600 hover:underline">删除</button></div></div>)}</div>}
            {!filtered.length && <div className="p-12 text-center text-sm text-slate-400">当前项目目录暂无符合条件的资料</div>}
          </Card></>}
          {kbTab === 'input' && <Card className="p-6">
            <h2 className="font-semibold text-slate-800">知识库输入</h2>
            <p className="mt-1 mb-4 text-xs text-slate-400">上传资料汇入所选项目知识库(RAG)，供 AI 助手检索。</p>
            <label className="mb-4 block"><span className="label">归属项目</span><select className="input" value={uploadProjectId} onChange={(event) => setUploadProjectId(event.target.value)}><option value="org">机构公共知识库</option>{accessibleProjects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.owner}</option>)}</select></label>
            <FileUpload onFile={upload} />
            <p className="mt-4 text-xs leading-5 text-slate-400">支持 PDF / Word / PPT / Excel / TXT / 音频 / 视频；上传后自动提取正文(音视频转录)、切片并汇入该项目知识库(RAG)。</p>
          </Card>}
          {kbTab === 'meetings' && <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h2 className="font-semibold text-slate-800">会议纪要</h2><p className="mt-1 text-xs text-slate-400">项目相关会议纪要，纪要内容自动汇入项目知识库</p></div><a href="/meetings" className="text-xs text-brand-600 hover:underline">前往会议纪要工作台 →</a></div>
            <DataTable headers={['会议标题', '类型', '所属项目', '状态', '时间']}>{meetings.filter((m) => selectedProjectId === 'all' || selectedProjectId === 'org' ? true : m.projectId === selectedProjectId).map((m) => <tr key={m.id} className="hover:bg-slate-50"><TableCell><span className="font-medium text-slate-700">{m.title}</span></TableCell><TableCell><Badge>{m.type}</Badge></TableCell><TableCell>{projects.find((p) => p.id === m.projectId)?.name ?? '—'}</TableCell><TableCell><StatusBadge status={m.status} /></TableCell><TableCell>{(m.meetingTime ?? '').slice(5, 16)}</TableCell></tr>)}</DataTable>
            {!meetings.length && <div className="p-12 text-center text-sm text-slate-400">暂无会议纪要</div>}
          </Card>}
        </div>
      </div>

      <Modal open={showUpload} title="上传知识资料" onClose={() => setShowUpload(false)}>
        <label className="mb-4 block"><span className="label">归属项目</span><select className="input" value={uploadProjectId} onChange={(event) => setUploadProjectId(event.target.value)}><option value="org">机构公共知识库</option>{accessibleProjects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.owner}</option>)}</select></label>
        <FileUpload onFile={upload} />
        <p className="mt-4 text-xs leading-5 text-slate-400">支持 PDF / Word / PPT / Excel / TXT / 音频 / 视频；上传后自动提取正文(音视频转录)、切片并汇入该项目知识库(RAG)，供 AI 助手检索。项目资料默认仅项目成员可见。</p>
      </Modal>
    </div>
  )
}
