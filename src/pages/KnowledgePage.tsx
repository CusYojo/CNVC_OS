import { BookOpen, FolderOpen, Grid2X2, List, UploadCloud } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useMemo, useState } from 'react'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, DataTable, FileUpload, Modal, PageHeader, SearchInput, StatusBadge, TableCell } from '../components/ui'
import { useAuthStore } from '../store/useAuthStore'
import { apiPost } from '../lib/api'
import { getFileTypeLabel } from '../lib/fileType'
import type { ProjectFile } from '../types'

const fileCategories = ['全部分类', '项目资料', '尽调资料', '会议资料', '上会材料', '公开情报', '公司知识库']

export function KnowledgePage({ initialTab = 'files', initialUpload = false, allowedTools, uploadProjectIds }: { initialTab?: 'files' | 'input' | 'meetings'; initialUpload?: boolean; allowedTools?: { upload: boolean; input: boolean; meetings: boolean }; uploadProjectIds?: string[] } = {}) {
  const files = useAppStore((state) => state.files)
  const meetings = useAppStore((state) => state.meetings)
  const projects = useAppStore((state) => state.projects)
  const currentUser = useAuthStore((state) => state.user ?? { id: '', email: '', name: '', role: '', department: '', status: '启用' })
  const deleteFile = useAppStore((state) => state.deleteFile)
  const { showToast } = useToast()
  const canUpload = allowedTools?.upload ?? true
  const uploadProjects = uploadProjectIds ? projects.filter(project => uploadProjectIds.includes(project.id)) : projects
  const initialProjectId = projects[0]?.id ?? 'all'
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId)
  const [uploadProjectId, setUploadProjectId] = useState(uploadProjects[0]?.id ?? '')
  const [category, setCategory] = useState('全部分类')
  const [query, setQuery] = useState('')
  const [visibility, setVisibility] = useState('')
  const [showUpload, setShowUpload] = useState(initialUpload)
  const [uploading, setUploading] = useState(false)
  const [kbTab, setKbTab] = useState<'files' | 'input' | 'meetings'>(initialTab)
  const [view, setView] = useState<'list' | 'grid'>('list')

  // 项目列表已经由服务端稳定用户 ID 权限过滤，前端不得再次按姓名推断权限。
  const accessibleProjects = projects
  const selectedProject = accessibleProjects.find((project) => project.id === selectedProjectId)
  const filtered = useMemo(() => files.filter((file) => {
    const projectMatched = selectedProjectId === 'all' || file.projectId === selectedProjectId
    const categoryMatched = category === '全部分类' || file.category === category || file.category.includes(category.replace('资料', ''))
    return projectMatched && categoryMatched && (!query || `${file.name}${file.category}`.toLowerCase().includes(query.toLowerCase())) && (!visibility || file.visibility === visibility)
  }), [files, selectedProjectId, category, query, visibility])

  const handleDeleteFile = async (file: { id: string; name: string }) => {
    if (!window.confirm(`确认删除资料「${file.name}」？\n相关索引也会一并删除，此操作不可恢复。`)) return
    try { await deleteFile(file.id); showToast(`已删除「${file.name}」`) }
    catch (e) { showToast(`删除失败：${(e as Error).message}`, 'error') }
  }

  const upload = async (file: File) => {
    if (!canUpload) return showToast('当前职责无权上传资料', 'error')
    const project = uploadProjects.find((item) => item.id === uploadProjectId)
    if (!project) return showToast('请先选择有权限的项目', 'error')
    if (file.size > 100 * 1024 * 1024) return showToast('文件不能超过 100MB', 'error')
    setUploading(true)
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('文件读取失败'))
        reader.onabort = () => reject(new Error('文件读取被中断'))
        reader.readAsDataURL(file)
      })
      const response = await apiPost<{ file: ProjectFile; ingest: { async: boolean; status: string } }>(
        '/projects/files/upload',
        {
          projectId: project.id,
          name: file.name,
          type: file.name.split('.').pop()?.toUpperCase() ?? 'FILE',
          category: '项目资料',
          uploader: currentUser.name,
          visibility: '项目成员',
          dataBase64,
        },
        { signal: AbortSignal.timeout(5 * 60_000) },
      )
      useAppStore.setState((state) => ({
        files: [response.file, ...state.files.filter((item) => item.id !== response.file.id)],
      }))
      setSelectedProjectId(project.id)
      setShowUpload(false)
      showToast(`原文件已安全归档至“${project.name}”，后台解析状态为“${response.file.parseStatus}”`)
    } catch (error) {
      showToast(`上传失败：${(error as Error).message}`, 'error')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div>
      <PageHeader title="项目知识库" actions={canUpload ? <Button disabled={!uploadProjects.length} onClick={() => { setUploadProjectId(uploadProjects.some(project => project.id === selectedProjectId) ? selectedProjectId : uploadProjects[0]?.id ?? ''); setShowUpload(true) }}><UploadCloud className="h-4 w-4" />上传资料</Button> : undefined} />
      <div className="grid grid-cols-[270px_minmax(0,1fr)] gap-5">
        <Card className="self-start overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-4"><p className="text-xs font-semibold text-slate-700">项目目录</p><p className="mt-1 text-[10px] text-slate-400">资料必须归属项目或机构公共库</p></div>
          <div className="p-2">
            <button onClick={() => setSelectedProjectId('all')} className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${selectedProjectId === 'all' ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}><BookOpen className="h-4 w-4" /><span className="flex-1 text-left">全部项目资料</span><span className="text-[10px] text-slate-400">{files.length}</span></button>
            <p className="border-t border-slate-100 px-3 pb-2 pt-3 text-[10px] font-medium text-slate-400">我的专属项目</p>
            {accessibleProjects.filter((project) => project.owner === currentUser.name).map((project) => <button key={project.id} onClick={() => setSelectedProjectId(project.id)} className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${selectedProjectId === project.id ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}><FolderOpen className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-left">{project.name}</span><span className="text-[10px] text-slate-400">{files.filter((file) => file.projectId === project.id).length}</span></button>)}
            <p className="border-t border-slate-100 px-3 pb-2 pt-3 text-[10px] font-medium text-slate-400">协作项目</p>
            {accessibleProjects.filter((project) => project.owner !== currentUser.name).map((project) => <button key={project.id} onClick={() => setSelectedProjectId(project.id)} className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${selectedProjectId === project.id ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}><FolderOpen className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-left">{project.name}</span><span className="text-[10px] text-slate-400">{files.filter((file) => file.projectId === project.id).length}</span></button>)}
          </div>
        </Card>

        <div>
          <div className="mb-4 flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1 text-sm">
            {([['files','资料库'],['input','知识库输入'],['meetings','会议纪要']] as const).filter(([key]) => key === 'files' || !allowedTools || allowedTools[key]).map(([k,label]) => (
              <button key={k} onClick={() => setKbTab(k)} className={`flex-1 rounded-md px-3 py-1.5 ${kbTab === k ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>{label}</button>
            ))}
          </div>
          {kbTab === 'files' && <><Card className="mb-4 p-4"><div className="flex items-center gap-3"><SearchInput className="w-[300px]" placeholder="搜索当前项目资料…" value={query} onChange={(event) => setQuery(event.target.value)} /><select className="input w-36" value={category} onChange={(event) => setCategory(event.target.value)}>{fileCategories.map((item) => <option key={item}>{item}</option>)}</select><select className="input w-36" value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="">全部权限</option><option>项目成员</option><option>管理层</option><option>全公司</option></select><div className="ml-auto flex rounded-lg border border-slate-200 p-0.5"><button aria-label="列表视图" onClick={() => setView('list')} className={`grid h-8 w-8 place-items-center rounded-md ${view === 'list' ? 'bg-slate-100 text-slate-700' : 'text-slate-400'}`}><List className="h-4 w-4" /></button><button aria-label="网格视图" onClick={() => setView('grid')} className={`grid h-8 w-8 place-items-center rounded-md ${view === 'grid' ? 'bg-slate-100 text-slate-700' : 'text-slate-400'}`}><Grid2X2 className="h-4 w-4" /></button></div></div></Card>
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h2 className="font-semibold text-slate-800">{selectedProjectId === 'all' ? '全部项目资料' : selectedProject?.name}</h2><p className="mt-1 text-xs text-slate-400">{filtered.length} 份资料</p></div><Badge>文件索引</Badge></div>
            {view === 'list' ? <DataTable headers={['资料名称', '所属项目', '分类', '上传人', '权限范围', '解析状态', '更新时间', '操作']}>{filtered.map((file) => <tr key={file.id} className="hover:bg-slate-50"><TableCell><span className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-blue-50 text-[9px] font-semibold text-blue-600">{getFileTypeLabel(file)}</span><span><span className="block font-medium text-slate-700">{file.name}</span><span className="mt-1 block text-xs text-slate-400">{file.size} · V{file.version}</span></span></span></TableCell><TableCell>{projects.find((project) => project.id === file.projectId)?.name ?? '机构公共知识'}</TableCell><TableCell><Badge>{file.category}</Badge></TableCell><TableCell>{file.uploader}</TableCell><TableCell>{file.visibility}</TableCell><TableCell><StatusBadge status={file.parseStatus} /></TableCell><TableCell>{file.uploadedAt.slice(5)}</TableCell><TableCell><button onClick={() => handleDeleteFile(file)} className="rounded-md px-2 py-1 text-xs text-rose-600 hover:bg-rose-50">删除</button></TableCell></tr>)}</DataTable> : <div className="grid grid-cols-3 gap-4 p-5">{filtered.map((file) => <div key={file.id} className="rounded-xl border border-slate-200 p-4 hover:border-brand-200"><span className="grid h-10 w-10 place-items-center rounded-lg bg-blue-50 text-[10px] font-semibold text-blue-600">{getFileTypeLabel(file)}</span><p className="mt-4 truncate text-sm font-medium text-slate-700">{file.name}</p><p className="mt-1 text-xs text-slate-400">{projects.find((project) => project.id === file.projectId)?.name ?? '机构公共知识'} · {file.category}</p><div className="mt-3 flex items-center justify-between"><StatusBadge status={file.parseStatus} /><button onClick={() => handleDeleteFile(file)} className="text-[10px] text-rose-600 hover:underline">删除</button></div></div>)}</div>}
            {!filtered.length && <div className="p-12 text-center text-sm text-slate-400">当前项目目录暂无符合条件的资料</div>}
          </Card></>}
          {kbTab === 'input' && (allowedTools?.input ?? true) && <Card className="p-6">
            <h2 className="font-semibold text-slate-800">知识库输入</h2>
            <label className="mb-4 block"><span className="label">归属项目</span><select className="input" value={uploadProjectId} onChange={(event) => setUploadProjectId(event.target.value)}>{uploadProjects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.owner}</option>)}</select></label>
            <FileUpload onFile={(file) => { void upload(file) }} />
            {uploading && <p className="mt-4 text-xs text-slate-400">正在上传…</p>}
          </Card>}
          {kbTab === 'meetings' && (allowedTools?.meetings ?? true) && <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><h2 className="font-semibold text-slate-800">会议纪要</h2><a href="/meetings" className="text-xs text-brand-600 hover:underline">前往会议纪要工作台 →</a></div>
            <DataTable headers={['会议标题', '类型', '所属项目', '状态', '时间']}>{meetings.filter((m) => selectedProjectId === 'all' || m.projectId === selectedProjectId).map((m) => <tr key={m.id} className="hover:bg-slate-50"><TableCell><span className="font-medium text-slate-700">{m.title}</span></TableCell><TableCell><Badge>{m.type}</Badge></TableCell><TableCell>{projects.find((p) => p.id === m.projectId)?.name ?? '—'}</TableCell><TableCell><StatusBadge status={m.status} /></TableCell><TableCell>{(m.meetingTime ?? '').slice(5, 16)}</TableCell></tr>)}</DataTable>
            {!meetings.length && <div className="p-12 text-center text-sm text-slate-400">暂无会议纪要</div>}
          </Card>}
        </div>
      </div>

      <Modal open={showUpload && canUpload} title="上传知识资料" onClose={() => { if (!uploading) setShowUpload(false) }}>
        <label className="mb-4 block"><span className="label">归属项目</span><select className="input" value={uploadProjectId} onChange={(event) => setUploadProjectId(event.target.value)}>{uploadProjects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.owner}</option>)}</select></label>
        <FileUpload onFile={(file) => { void upload(file) }} />
        {uploading && <p className="mt-4 text-xs text-slate-400">正在上传…</p>}
      </Modal>
    </div>
  )
}
