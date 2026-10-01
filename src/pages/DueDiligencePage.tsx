import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Bot, ClipboardList, UsersRound } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useAuthStore } from '../store/useAuthStore'
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '../lib/api'
import { useToast } from '../components/Toast'
import { Badge, Button, Card, Modal, PageHeader } from '../components/ui'
import { QuestionsWorkspace } from '../components/dueDiligence/QuestionsWorkspace'
import { InterviewsWorkspace } from '../components/dueDiligence/InterviewsWorkspace'
import { ExperienceAssetsWorkspace } from '../components/dueDiligence/ExperienceAssetsWorkspace'
import type { Project, ProjectFile } from '../types'
import type { CapabilityStatus, Interview, InterviewArtifact, InterviewPrompt, InterviewTranscript, LearningCandidate, Member, PublicTwin, Question, QuestionPack, TranscriptionJob, Twin, TwinAsset, TwinSkill, TwinSkillImport } from '../components/dueDiligence/types'

type InterviewForm = { title: string; mode: '现场' | '远程'; scheduledAt: string; agenda: string; counterparty: string; location: string; participantNames: string[] }
type ImportableSource = { id: string; name: string; text: string; sourceType: string }
type PlatformSkill = { id: string; name: string; description?: string; markdown?: string }
type TwinDraft = { id: string; name: string; role: string; rules: string; cases: string; avatarPreset?: string | null; avatarDataUrl?: string | null }
const emptyInterview: InterviewForm = { title: '', mode: '现场', scheduledAt: '', agenda: '', counterparty: '', location: '', participantNames: [] }
const demoProject: Project = { id: 'd0d00000-0000-4000-8000-000000000001', name: '星河智能制造', companyName: '星河智能制造（杭州）有限公司', industry: '智能制造', round: 'B轮', stage: '尽调', owner: '姜波', collaborators: ['陈晨'], source: '演示数据', financing: 'B轮融资', valuation: '8亿元', riskLevel: '中', summary: '用于尽调工作台前端预览的虚拟项目。', score: 78, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), tags: ['智能制造'], businessModel: '', market: '', team: '', progress: 55, version: 1 }
const demoFile: ProjectFile = { id: 'd0d00000-0000-4000-8000-000000000201', projectId: demoProject.id, name: '2026年上半年财务报表.pdf', type: 'PDF', category: '财务材料', size: '2.4 MB', uploader: '陈晨', uploadedAt: new Date().toISOString(), parseStatus: '成功', version: 1, visibility: '项目成员' }

function Tab({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return <button onClick={onClick} className={`inline-flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium ${active ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>{icon}{children}</button>
}
const fileToDataUrl = (file: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '')); reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsDataURL(file) })

export function DueDiligencePage({ preview = false }: { preview?: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const storeProjects = useAppStore(state => state.projects)
  const storeFiles = useAppStore(state => state.files)
  const user = useAuthStore(state => state.user)
  const { showToast } = useToast()
  const projects = preview ? [demoProject] : storeProjects
  const files = preview ? [demoFile] : storeFiles
  const [active, setActive] = useState<'questions' | 'interviews' | 'assets'>('questions')
  const projectId = searchParams.get('project') || projects[0]?.id || ''
  const projectFiles = useMemo(() => files.filter(item => item.projectId === projectId), [files, projectId])
  const [questions, setQuestions] = useState<Question[]>([])
  const [interviews, setInterviews] = useState<Interview[]>([])
  const [prompts, setPrompts] = useState<Record<string, InterviewPrompt[]>>({})
  const [artifacts, setArtifacts] = useState<Record<string, InterviewArtifact[]>>({})
  const [transcripts, setTranscripts] = useState<Record<string, InterviewTranscript>>({})
  const [jobs, setJobs] = useState<Record<string, TranscriptionJob[]>>({})
  const [members, setMembers] = useState<Member[]>([])
  const [selectedInterviewId, setSelectedInterviewId] = useState('')
  const [loadingProject, setLoadingProject] = useState(false)
  const [recordingActive, setRecordingActive] = useState(false)
  const [showInterview, setShowInterview] = useState(false)
  const [interviewForm, setInterviewForm] = useState(emptyInterview)
  const [twins, setTwins] = useState<Twin[]>([])
  const [publicTwins, setPublicTwins] = useState<PublicTwin[]>([])
  const [selectedTwinId, setSelectedTwinId] = useState('')
  const [twinDraft, setTwinDraft] = useState<TwinDraft>({ id: '', name: user?.name ? `${user.name}的尽调分身` : '', role: user?.role || '投资经理', rules: '', cases: '' })
  const [savedTwinDraft, setSavedTwinDraft] = useState<TwinDraft | null>(null)
  const [newTwinRequestId, setNewTwinRequestId] = useState('')
  const [savingTwin, setSavingTwin] = useState(false)
  const [twinAssets, setTwinAssets] = useState<TwinAsset[]>([])
  const [learningCandidates, setLearningCandidates] = useState<LearningCandidate[]>([])
  const [twinSkills, setTwinSkills] = useState<TwinSkill[]>([])
  const [skillImports, setSkillImports] = useState<TwinSkillImport[]>([])
  const [sources, setSources] = useState<ImportableSource[]>([])
  const [platformSkills, setPlatformSkills] = useState<PlatformSkill[]>([])
  const [capabilities, setCapabilities] = useState<CapabilityStatus | null>(null)
  const [capabilityError, setCapabilityError] = useState('')
  const selectedInterview = interviews.find(item => item.id === selectedInterviewId) ?? interviews[0]
  const selectedTwin = twins.find(item => item.id === selectedTwinId)
  const twinDirty = savedTwinDraft ? JSON.stringify(twinDraft) !== JSON.stringify(savedTwinDraft) : Boolean(twinDraft.name || twinDraft.rules || twinDraft.cases)
  const isNewTwin = Boolean(newTwinRequestId) && !selectedTwin

  const loadWorkspace = useCallback(async (quiet = false) => {
    if (!projectId || preview) return
    if (!quiet) setLoadingProject(true)
    try {
      const [questionData, interviewData, memberData] = await Promise.all([
        apiGet<{ list: Question[] }>(`/due-diligence/projects/${projectId}/questions`),
        apiGet<{ list: Interview[]; prompts: Array<{ interviewId: string; list: InterviewPrompt[] }>; artifacts: Array<{ interviewId: string; list: InterviewArtifact[] }>; transcripts: InterviewTranscript[] }>(`/due-diligence/projects/${projectId}/interviews`),
        apiGet<{ list: Member[] }>(`/due-diligence/projects/${projectId}/members`),
      ])
      setQuestions(questionData.list); setInterviews(interviewData.list); setMembers(memberData.list)
      setPrompts(Object.fromEntries(interviewData.prompts.map(item => [item.interviewId, item.list])))
      setArtifacts(Object.fromEntries(interviewData.artifacts.map(item => [item.interviewId, item.list])))
      setTranscripts(Object.fromEntries(interviewData.transcripts.map(item => [item.interviewId, item])))
      setSelectedInterviewId(current => interviewData.list.some(item => item.id === current) ? current : (interviewData.list[0]?.id || ''))
    } catch (error) { if (!quiet) showToast(`加载尽调项目失败：${(error as Error).message}`, 'error') }
    finally { if (!quiet) setLoadingProject(false) }
  }, [preview, projectId, showToast])

  const loadTwins = useCallback(async (preferredId?: string) => {
    if (preview) return
    try {
      const list = (await apiGet<{ list: Twin[] }>('/due-diligence/twins')).list; setTwins(list)
      const id = preferredId || selectedTwinId || list[0]?.id || ''
      if (id && !newTwinRequestId) {
        const twin = list.find(item => item.id === id) || list[0]; if (twin) { const draft = { id: twin.id, name: twin.name, role: twin.role, rules: twin.rules, cases: twin.cases, avatarPreset: twin.avatarPreset, avatarDataUrl: null }; setSelectedTwinId(twin.id); setTwinDraft(draft); setSavedTwinDraft(draft) }
      }
    } catch (error) { showToast(`加载数字分身失败：${(error as Error).message}`, 'error') }
  }, [preview, selectedTwinId, newTwinRequestId, showToast])
  const loadPublicTwins = useCallback(async () => { if (preview) return; try { setPublicTwins((await apiGet<{ list: PublicTwin[] }>('/due-diligence/twin-directory')).list) } catch (error) { showToast(`加载公司分身失败：${(error as Error).message}`, 'error') } }, [preview, showToast])
  const loadTwinDetails = useCallback(async (twinId: string) => {
    if (!twinId || preview) { setTwinAssets([]); setLearningCandidates([]); setTwinSkills([]); setSkillImports([]); return }
    try { const [assetsData, candidateData, skillData, importData] = await Promise.all([apiGet<{ list: TwinAsset[] }>(`/due-diligence/twins/${twinId}/assets`), apiGet<{ list: LearningCandidate[] }>(`/due-diligence/twins/${twinId}/learning-candidates`), apiGet<{ list: TwinSkill[] }>(`/due-diligence/twins/${twinId}/skills`), apiGet<{ list: TwinSkillImport[] }>(`/due-diligence/twins/${twinId}/skill-imports`)]); setTwinAssets(assetsData.list); setLearningCandidates(candidateData.list); setTwinSkills(skillData.list); setSkillImports(importData.list) } catch (error) { showToast(`加载分身经验失败：${(error as Error).message}`, 'error') }
  }, [preview, showToast])

  useEffect(() => { if (preview) { setQuestions([{ id: crypto.randomUUID(), projectId, title: '核实前五大客户收入确认与回款依据', category: '财务', priority: '高', status: '待核查', evidenceRequirement: '核对合同、验收、发票和回款。', assigneeName: '陈晨', fileId: demoFile.id, fileIds: [demoFile.id], source: '标准模板', version: 1, createdAt: new Date().toISOString() }]); return } void loadWorkspace() }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (preview) return; void loadTwins(); void loadPublicTwins(); void apiGet<{ list: ImportableSource[] }>('/due-diligence/twins/importable-sources').then(data => setSources(data.list)).catch(error => showToast(`读取知识库来源失败：${(error as Error).message}`, 'error')); void apiGet<{ list: PlatformSkill[] }>('/ai/prompt-library?kind=skill').then(data => setPlatformSkills(data.list)).catch(() => setPlatformSkills([])); void apiGet<CapabilityStatus>('/due-diligence/capabilities').then(setCapabilities).catch(error => setCapabilityError((error as Error).message)) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (selectedTwinId) void loadTwinDetails(selectedTwinId) }, [selectedTwinId]) // eslint-disable-line react-hooks/exhaustive-deps

  const switchProject = (id: string) => {
    if (recordingActive) { showToast('录音尚未结束，请先点击“结束”再切换项目', 'error'); return }
    setQuestions([]); setInterviews([]); setPrompts({}); setArtifacts({}); setTranscripts({}); setJobs({}); setSelectedInterviewId(''); setSearchParams(id ? { project: id } : {})
  }
  const uploadProjectFile = async (file: Blob, name: string, type: string, category: string) => {
    if (preview) return null
    const result = await apiPost<{ file: ProjectFile }>('/projects/files/upload', { projectId, name, type, category, uploader: user?.name || '尽调工作台', visibility: '项目成员', dataBase64: await fileToDataUrl(file) })
    useAppStore.setState(state => ({ files: [result.file, ...state.files.filter(item => item.id !== result.file.id)] })); return result.file
  }

  const createQuestion = async (value: { title: string; category: string; priority: '高' | '中' | '低'; evidenceRequirement: string; assigneeUserId: string; assigneeName: string; fileIds: string[] }) => {
    if (preview) { setQuestions(items => [{ id: crypto.randomUUID(), projectId, ...value, status: '待核查', fileId: value.fileIds[0] || null, source: '演示创建', version: 1, createdAt: new Date().toISOString() }, ...items]); return }
    await apiPost(`/due-diligence/projects/${projectId}/questions`, value); await loadWorkspace(true); showToast('核查问题已创建')
  }
  const updateQuestionStatus = async (question: Question, status: Question['status']) => { if (preview) { setQuestions(items => items.map(item => item.id === question.id ? { ...item, status } : item)); return } await apiPatch(`/due-diligence/projects/${projectId}/questions/${question.id}`, { status, expectedVersion: question.version }); await loadWorkspace(true) }
  const deleteQuestion = async (question: Question) => { if (!window.confirm(`确认删除“${question.title}”？`)) return; if (preview) { setQuestions(items => items.filter(item => item.id !== question.id)); return } await apiDelete(`/due-diligence/projects/${projectId}/questions/${question.id}`); await loadWorkspace(true) }
  const reorderQuestions = async (ids: string[]) => { if (preview) { setQuestions(ids.map(id => questions.find(item => item.id === id)!).filter(Boolean)); return } await apiPost(`/due-diligence/projects/${projectId}/questions/reorder`, { ids }); await loadWorkspace(true) }
  const generateQuestions = async (value: { fileIds: string[]; publicationIds: string[]; mode: 'auto' | 'baseline' | 'ai' }) => { const result = await apiPost<QuestionPack & { created: number }>(`/due-diligence/projects/${projectId}/question-packs/generate`, value); await loadWorkspace(true); showToast(result.warning || `已加入 ${result.created} 条待核查问题`); return result }
  const uploadQuestionMaterial = async (file: File) => { try { const uploaded = await uploadProjectFile(file, file.name, file.name.split('.').pop()?.toUpperCase() || 'FILE', '尽调补充材料'); if (uploaded) showToast(`“${file.name}”已上传`); return uploaded } catch (error) { showToast(`上传失败：${(error as Error).message}`, 'error'); return null } }

  const createInterview = async () => {
    if (!projectId || !interviewForm.title.trim()) return showToast('请填写访谈名称', 'error')
    if (preview) { const row: Interview = { id: crypto.randomUUID(), projectId, ...interviewForm, scheduledAt: interviewForm.scheduledAt || null, status: '筹备中', notes: '', summary: '', version: 1 }; setInterviews(items => [row, ...items]); setSelectedInterviewId(row.id); setShowInterview(false); return }
    const row = await apiPost<Interview>(`/due-diligence/projects/${projectId}/interviews`, { ...interviewForm, scheduledAt: interviewForm.scheduledAt || null }); setInterviewForm(emptyInterview); setShowInterview(false); await loadWorkspace(true); setSelectedInterviewId(row.id); showToast('访谈已创建')
  }
  const saveInterview = async (interview: Interview, patch: Partial<Interview>) => {
    const allowed = { title: patch.title, mode: patch.mode, status: patch.status, scheduledAt: patch.scheduledAt, agenda: patch.agenda, notes: patch.notes, summary: patch.summary, summaryTranscriptVersion: patch.summaryTranscriptVersion, counterparty: patch.counterparty, location: patch.location, participantNames: patch.participantNames }
    const body = Object.fromEntries(Object.entries(allowed).filter(([, value]) => value !== undefined))
    if (preview) { const next = { ...interview, ...body, version: interview.version + 1 } as Interview; setInterviews(items => items.map(item => item.id === interview.id ? next : item)); return next }
    try { const row = await apiPatch<Interview>(`/due-diligence/projects/${projectId}/interviews/${interview.id}`, { ...body, expectedVersion: interview.version }); await loadWorkspace(true); showToast('访谈安排已保存'); return row } catch (error) { showToast(`保存访谈失败：${(error as Error).message}`, 'error'); return null }
  }
  const deleteInterview = async (interview: Interview) => { if (!window.confirm(`确认删除访谈“${interview.title}”？`)) return; if (!preview) await apiDelete(`/due-diligence/projects/${projectId}/interviews/${interview.id}`); setSelectedInterviewId(''); await loadWorkspace(true) }
  const reorderInterviews = async (ids: string[]) => { if (preview) { setInterviews(ids.map(id => interviews.find(item => item.id === id)!).filter(Boolean)); return } await apiPost(`/due-diligence/projects/${projectId}/interviews/reorder`, { ids }); await loadWorkspace(true) }
  const saveTranscript = async (interview: Interview, content: string, status: '草稿' | '已确认', expectedVersion?: number | null) => { if (preview) { const row: InterviewTranscript = { id: crypto.randomUUID(), interviewId: interview.id, content, source: 'browser', status, version: (transcripts[interview.id]?.version || 0) + 1, updatedAt: new Date().toISOString() }; setTranscripts(value => ({ ...value, [interview.id]: row })); return row } try { const row = await apiPut<InterviewTranscript>(`/due-diligence/projects/${projectId}/interviews/${interview.id}/transcript`, { content, source: 'browser', status, expectedVersion: expectedVersion ?? null }); setTranscripts(value => ({ ...value, [interview.id]: row })); return row } catch (error) { showToast(`保存转写失败：${(error as Error).message}`, 'error'); return null } }
  const uploadRecording = async (interview: Interview, blob: Blob, seconds: number) => { try { const ext = blob.type.includes('mp4') ? 'm4a' : 'webm'; const file = await uploadProjectFile(blob, `${interview.title}-${Date.now()}.${ext}`, ext.toUpperCase(), '访谈录音'); if (!file) return null; await apiPost(`/due-diligence/projects/${projectId}/interviews/${interview.id}/artifacts`, { fileId: file.id, kind: '录音', source: 'browser', durationSeconds: seconds }); await loadWorkspace(true); return file.id } catch (error) { showToast(`录音归档失败：${(error as Error).message}`, 'error'); return null } }
  const loadLive = useCallback(async (interviewId = selectedInterview?.id) => { if (!projectId || !interviewId || preview) return; const [promptData, jobData] = await Promise.all([apiGet<{ list: InterviewPrompt[] }>(`/due-diligence/projects/${projectId}/interviews/${interviewId}/prompts`), apiGet<{ list: TranscriptionJob[] }>(`/due-diligence/projects/${projectId}/interviews/${interviewId}/transcriptions`)]); setPrompts(value => ({ ...value, [interviewId]: promptData.list })); setJobs(value => ({ ...value, [interviewId]: jobData.list })) }, [projectId, selectedInterview?.id, preview])
  const startAsr = async (interview: Interview, recordingFileId: string, browserText: string, transcriptVersion?: number | null) => { try { await apiPost(`/due-diligence/projects/${projectId}/interviews/${interview.id}/transcriptions`, { recordingFileId, browserText, sourceTranscriptVersion: transcriptVersion ?? null }); await loadLive(interview.id); showToast(capabilities?.asr.configured ? '后台转写已开始' : '录音已保存；当前未配置后台转写') } catch (error) { showToast(`后台转写任务创建失败：${(error as Error).message}`, 'error') } }
  const retryAsr = async (interview: Interview, job: TranscriptionJob) => { try { await apiPost(`/due-diligence/projects/${projectId}/interviews/${interview.id}/transcriptions/${job.id}/retry`); await loadLive(interview.id) } catch (error) { showToast(`重试失败：${(error as Error).message}`, 'error') } }
  const generateSummary = async (interview: Interview, transcriptVersion: number) => { try { return await apiPost<{ summary: string; transcriptVersion: number }>(`/due-diligence/projects/${projectId}/interviews/${interview.id}/summary/generate`, { transcriptVersion }) } catch (error) { showToast(`生成纪要失败：${(error as Error).message}`, 'error'); return null } }
  const archiveText = async (interview: Interview, kind: '转写稿' | '访谈纪要', content: string) => { try { const file = await uploadProjectFile(new Blob([content], { type: 'text/plain;charset=utf-8' }), `${interview.title}-${kind}.txt`, 'TXT', kind); if (!file) return; await apiPost(`/due-diligence/projects/${projectId}/interviews/${interview.id}/artifacts`, { fileId: file.id, kind: kind === '转写稿' ? '转写' : '纪要', source: 'manual' }); await loadWorkspace(true); showToast(`${kind}已保存到项目材料`) } catch (error) { showToast(`归档失败：${(error as Error).message}`, 'error') } }
  const uploadSummary = async (interview: Interview, source: File) => { try { const file = await uploadProjectFile(source, source.name, source.name.split('.').pop()?.toUpperCase() || 'FILE', '访谈纪要'); if (!file) return; await apiPost(`/due-diligence/projects/${projectId}/interviews/${interview.id}/artifacts`, { fileId: file.id, kind: '纪要', source: 'manual' }); await loadWorkspace(true) } catch (error) { showToast(`上传纪要失败：${(error as Error).message}`, 'error') } }
  const removeMaterial = async (artifact: InterviewArtifact) => { if (!selectedInterview || !window.confirm(`仅从当前访谈移除“${artifact.name}”？`)) return; await apiDelete(`/due-diligence/projects/${projectId}/interviews/${selectedInterview.id}/artifacts/${artifact.id}`); await loadWorkspace(true) }
  const sendPrompt = async (interview: Interview, content: string) => { await apiPost(`/due-diligence/projects/${projectId}/interviews/${interview.id}/prompts`, { content }); await loadLive(interview.id) }
  const confirmPrompt = async (interview: Interview, prompt: InterviewPrompt, status: InterviewPrompt['status']) => { const response = status === '已确认' ? (window.prompt('请简要记录现场答复（可留空）') || '') : ''; await apiPatch(`/due-diligence/projects/${projectId}/interviews/${interview.id}/prompts/${prompt.id}`, { status, response }); await loadLive(interview.id) }

  const startNewTwin = () => {
    if (twinDirty && !window.confirm('当前分身有未保存修改，确定放弃并新增吗？')) return
    setSelectedTwinId(''); setNewTwinRequestId(crypto.randomUUID()); const draft = { id: '', name: user?.name ? `${user.name}的尽调分身` : '', role: user?.role || '投资经理', rules: '', cases: '', avatarPreset: 'fox' }; setTwinDraft(draft); setSavedTwinDraft({ ...draft }); setTwinAssets([]); setLearningCandidates([]); setTwinSkills([]); setSkillImports([])
  }
  const selectTwin = (twin: Twin) => { if (twinDirty && !window.confirm('当前分身有未保存修改，确定切换吗？')) return; const draft = { id: twin.id, name: twin.name, role: twin.role, rules: twin.rules, cases: twin.cases, avatarPreset: twin.avatarPreset, avatarDataUrl: null }; setNewTwinRequestId(''); setSelectedTwinId(twin.id); setTwinDraft(draft); setSavedTwinDraft(draft); if (!preview && !twin.learningTargetAt) void apiPost(`/due-diligence/twins/${twin.id}/select-learning-target`).then(() => loadTwins(twin.id)).catch(error => showToast(`设置学习分身失败：${(error as Error).message}`, 'error')) }
  const saveTwin = async () => {
    if (!twinDraft.name.trim() || savingTwin) return
    if (preview) {
      const existing = twins.find(item => item.id === twinDraft.id)
      const row: Twin = { ...twinDraft, id: existing?.id || crypto.randomUUID(), activeVersion: (existing?.activeVersion || 0) + 1, updatedAt: new Date().toISOString() }
      setTwins(items => [row, ...items.filter(item => item.id !== row.id)]); setSelectedTwinId(row.id); setNewTwinRequestId('')
      const draft = { id: row.id, name: row.name, role: row.role, rules: row.rules, cases: row.cases }; setTwinDraft(draft); setSavedTwinDraft(draft); showToast('演示数字分身已创建，刷新后还原'); return
    }
    setSavingTwin(true)
    try { const creating = isNewTwin; const row = creating ? await apiPost<Twin>('/due-diligence/twins', { ...twinDraft, clientRequestId: newTwinRequestId, source: 'manual' }) : await apiPatch<Twin>(`/due-diligence/twins/${twinDraft.id}`, { ...twinDraft, source: 'manual' }); setNewTwinRequestId(''); setSelectedTwinId(row.id); const draft = { id: row.id, name: row.name, role: row.role, rules: row.rules, cases: row.cases, avatarPreset: row.avatarPreset, avatarDataUrl: null }; setTwinDraft(draft); setSavedTwinDraft(draft); await loadTwins(row.id); await loadTwinDetails(row.id); showToast(creating ? '数字分身已创建' : '数字分身新版本已保存') } catch (error) { showToast(`保存数字分身失败：${(error as Error).message}`, 'error') } finally { setSavingTwin(false) }
  }
  const deleteTwin = async (twin: Twin) => { if (!window.confirm(`确认删除“${twin.name}”？`)) return; await apiDelete(`/due-diligence/twins/${twin.id}`); setSelectedTwinId(''); setSavedTwinDraft(null); setTwinDraft({ id: '', name: '', role: user?.role || '投资经理', rules: '', cases: '' }); await loadTwins(); await loadPublicTwins() }
  const publishTwin = async (twin: Twin) => { await apiPost(`/due-diligence/twins/${twin.id}/publish`, { introduction: twin.name, publicRules: twin.rules || '暂无公开判断偏好', publicCases: twin.cases || '', industryTags: [], capabilityTags: [] }); await loadPublicTwins(); showToast('已公开到公司分身库') }
  const withdrawTwin = async (twin: Twin) => { await apiPost(`/due-diligence/twins/${twin.id}/withdraw-publication`); await loadPublicTwins(); showToast('已取消公开') }
  const importLocalAsset = async (file: File) => { if (!selectedTwin) return; const text = /\.(txt|md)$/i.test(file.name) ? await file.text() : undefined; await apiPost(`/due-diligence/twins/${selectedTwin.id}/assets`, { sourceType: '本地素材', sourceName: file.name, mimeType: file.type || 'application/octet-stream', contentText: text, dataBase64: text === undefined ? await fileToDataUrl(file) : undefined }); await loadTwinDetails(selectedTwin.id) }
  const importSource = async (source: ImportableSource) => { if (!selectedTwin) return; await apiPost(`/due-diligence/twins/${selectedTwin.id}/assets`, { sourceType: source.sourceType, sourceName: source.name, sourceId: source.id, mimeType: 'text/plain' }); await loadTwinDetails(selectedTwin.id) }
  const parseAsset = async (asset: TwinAsset) => { if (!selectedTwin) return null; try { const result = await apiPost<{ traits: string }>(`/due-diligence/twins/${selectedTwin.id}/assets/${asset.id}/parse`); await loadTwinDetails(selectedTwin.id); showToast('已生成可编辑的判断偏好建议'); return result.traits } catch (error) { showToast(`解析失败：${(error as Error).message}`, 'error'); await loadTwinDetails(selectedTwin.id); return null } }
  const decideCandidates = async (ids: string[], decision: '确认' | '拒绝') => { if (!selectedTwin) return; for (const id of ids) await apiPost(`/due-diligence/twins/${selectedTwin.id}/learning-candidates/${id}/decision`, { decision }); await loadTwins(selectedTwin.id); await loadTwinDetails(selectedTwin.id); showToast(`已${decision === '确认' ? '采纳' : '排除'} ${ids.length} 条经验`) }
  const importSkillFiles = async (files: FileList | File[], sourceType: '本机文件夹' | '平台Skill库' = '本机文件夹') => { if (!selectedTwin) return; for (const file of Array.from(files)) { if (!/\.(md|txt|json|ya?ml)$/i.test(file.name)) { showToast(`已跳过不支持的文件：${file.name}`, 'error'); continue }; await apiPost(`/due-diligence/twins/${selectedTwin.id}/skill-imports`, { sourceType, sourceName: file.name, relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || undefined, content: await file.text() }) }; await loadTwinDetails(selectedTwin.id) }
  const importGithubSkill = async (url: string) => { if (!selectedTwin) return; await apiPost(`/due-diligence/twins/${selectedTwin.id}/skill-imports/github`, { url }); await loadTwinDetails(selectedTwin.id) }
  const learnSkill = async (id: string) => { if (!selectedTwin) return; await apiPost(`/due-diligence/twins/${selectedTwin.id}/skill-imports/${id}/learn`); await loadTwinDetails(selectedTwin.id); showToast('该 Skill 已加入当前分身的私有能力') }
  const importPlatformSkill = async (item: PlatformSkill) => { if (!selectedTwin) return; const detail = item.markdown ? item : await apiGet<PlatformSkill>(`/ai/prompt-library/${item.id}`); await apiPost(`/due-diligence/twins/${selectedTwin.id}/skill-imports`, { sourceType: '平台Skill库', sourceName: detail.name, sourceUrl: `platform:${item.id}`, content: detail.markdown || '' }); await loadTwinDetails(selectedTwin.id) }
  const toggleSkill = async (skill: TwinSkill) => { if (!selectedTwin) return; await apiPatch(`/due-diligence/twins/${selectedTwin.id}/skills/${skill.id}`, { enabled: skill.status !== '已生效' }); await loadTwinDetails(selectedTwin.id) }
  const invokeTwin = async (twin: PublicTwin, question: string) => { try { return await apiPost<{ advice: string }>(`/due-diligence/twin-directory/${twin.id}/invoke`, { question, projectId: null }) } catch (error) { showToast(`公司分身调用失败：${(error as Error).message}`, 'error'); return null } }
  const conversationFeedback = async (input: { userQuestion: string; assistantAnswer: string; feedback: '采纳' | '修改' | '拒绝'; feedbackNote: string }) => { if (!selectedTwin) return; try { await apiPost(`/due-diligence/twins/${selectedTwin.id}/conversation-candidates`, { ...input, projectId: null }); await loadTwinDetails(selectedTwin.id); showToast(input.feedback === '拒绝' ? '已记录拒绝反馈' : '已提炼为待确认经验') } catch (error) { showToast(`经验提炼失败：${(error as Error).message}`, 'error') } }

  return <div className="space-y-5">
    {preview && <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">当前为前端演示模式，操作不会写入数据库。</div>}
    <PageHeader title="尽调工作台" description="围绕尽调清单、现场协同与经验资产，减少重复录入并沉淀可复用判断。" actions={active === 'assets' || !projects.length ? undefined : <select className="input w-64" value={projectId} onChange={event => switchProject(event.target.value)}>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>} />
    {!preview && <div className="flex flex-wrap gap-2 text-xs">{capabilities ? <><Badge tone={capabilities.database.ready ? 'green' : 'red'}>数据库{capabilities.database.ready ? '就绪' : '待迁移'}</Badge><Badge tone={capabilities.models.document.ready ? 'green' : 'amber'}>文档模型{capabilities.models.document.ready ? '就绪' : '未配置'}</Badge><Badge tone={capabilities.models.interactive.ready ? 'green' : 'amber'}>分身模型{capabilities.models.interactive.ready ? '就绪' : '未配置'}</Badge><Badge tone={capabilities.asr.configured ? 'green' : 'amber'}>后台转写{capabilities.asr.configured ? '就绪' : '未配置'}</Badge></> : capabilityError && <span className="text-rose-600">能力状态读取失败：{capabilityError}</span>}</div>}
    <div className="flex flex-wrap gap-2 border-b border-slate-200"><Tab active={active === 'questions'} onClick={() => setActive('questions')} icon={<ClipboardList className="h-4 w-4" />}>尽调清单</Tab><Tab active={active === 'interviews'} onClick={() => setActive('interviews')} icon={<UsersRound className="h-4 w-4" />}>现场协同</Tab><Tab active={active === 'assets'} onClick={() => setActive('assets')} icon={<Bot className="h-4 w-4" />}>经验资产</Tab></div>
    {active !== 'assets' && !projects.length && <Card className="p-8 text-sm text-slate-500">当前没有可访问项目；经验资产仍可正常使用。</Card>}
    {active === 'questions' && projectId && <QuestionsWorkspace projectId={projectId} files={projectFiles} members={members} publicTwins={publicTwins} questions={questions} loading={loadingProject} defaultAssigneeId={user?.id || ''} defaultAssigneeName={user?.name || ''} onCreate={createQuestion} onStatus={updateQuestionStatus} onDelete={deleteQuestion} onReorder={reorderQuestions} onGenerate={generateQuestions} onUpload={uploadQuestionMaterial} />}
    {active === 'interviews' && projectId && <InterviewsWorkspace projectId={projectId} interviews={interviews} selected={selectedInterview} prompts={selectedInterview ? prompts[selectedInterview.id] || [] : []} artifacts={selectedInterview ? artifacts[selectedInterview.id] || [] : []} transcript={selectedInterview ? transcripts[selectedInterview.id] : undefined} transcriptionJobs={selectedInterview ? jobs[selectedInterview.id] || [] : []} onSelect={setSelectedInterviewId} onCreate={() => { setInterviewForm(emptyInterview); setShowInterview(true) }} onSave={saveInterview} onDelete={deleteInterview} onReorder={reorderInterviews} onRemoveMaterial={removeMaterial} onUploadSummary={uploadSummary} onSaveTranscript={saveTranscript} onUploadRecording={uploadRecording} onStartAsr={startAsr} onRetryAsr={retryAsr} onGenerateSummary={generateSummary} onArchiveText={archiveText} onSendPrompt={sendPrompt} onConfirmPrompt={confirmPrompt} onRefreshLive={loadLive} onRecordingState={setRecordingActive} />}
    {active === 'assets' && <ExperienceAssetsWorkspace currentUserId={user?.id || ''} twins={twins} publicTwins={publicTwins} selectedTwin={selectedTwin} draft={twinDraft} isNew={isNewTwin} dirty={twinDirty} saving={savingTwin} assets={twinAssets} candidates={learningCandidates} skills={twinSkills} skillImports={skillImports} sources={sources} platformSkills={platformSkills} onNew={startNewTwin} onSelect={selectTwin} onDraft={setTwinDraft} onSave={saveTwin} onDelete={deleteTwin} onPublish={publishTwin} onWithdraw={withdrawTwin} onImportLocal={importLocalAsset} onImportSource={importSource} onParseAsset={parseAsset} onDecideCandidates={decideCandidates} onImportSkillFiles={importSkillFiles} onImportGithubSkill={importGithubSkill} onImportPlatformSkill={importPlatformSkill} onLearnSkill={learnSkill} onToggleSkill={toggleSkill} onInvoke={invokeTwin} onConversationFeedback={conversationFeedback} />}
    <Modal open={showInterview} title="新建现场访谈" onClose={() => setShowInterview(false)} footer={<><Button variant="secondary" onClick={() => setShowInterview(false)}>取消</Button><Button disabled={!interviewForm.title.trim()} onClick={() => void createInterview()}>创建访谈</Button></>}><div className="grid grid-cols-2 gap-4"><label className="col-span-2"><span className="label">访谈名称 *</span><input className="input" value={interviewForm.title} onChange={event => setInterviewForm({ ...interviewForm, title: event.target.value })} /></label><label><span className="label">形式</span><select className="input" value={interviewForm.mode} onChange={event => setInterviewForm({ ...interviewForm, mode: event.target.value as InterviewForm['mode'] })}><option>现场</option><option>远程</option></select></label><label><span className="label">计划时间</span><input className="input" type="datetime-local" value={interviewForm.scheduledAt} onChange={event => setInterviewForm({ ...interviewForm, scheduledAt: event.target.value })} /></label><label><span className="label">访谈对象/单位</span><input className="input" value={interviewForm.counterparty} onChange={event => setInterviewForm({ ...interviewForm, counterparty: event.target.value })} /></label><label><span className="label">地点</span><input className="input" value={interviewForm.location} onChange={event => setInterviewForm({ ...interviewForm, location: event.target.value })} /></label><label className="col-span-2"><span className="label">参与人（逗号分隔）</span><input className="input" value={interviewForm.participantNames.join('，')} onChange={event => setInterviewForm({ ...interviewForm, participantNames: event.target.value.split(/[，,]/).map(item => item.trim()).filter(Boolean) })} /></label><label className="col-span-2"><span className="label">访谈议程</span><textarea className="textarea min-h-28" value={interviewForm.agenda} onChange={event => setInterviewForm({ ...interviewForm, agenda: event.target.value })} /></label></div></Modal>
  </div>
}
