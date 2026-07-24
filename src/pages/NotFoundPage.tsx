import { FileQuestion } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button, Card } from '../components/ui'

export function NotFoundPage() {
  const navigate = useNavigate()
  return <Card className="mx-auto mt-24 max-w-lg p-12 text-center"><FileQuestion className="mx-auto h-10 w-10 text-slate-300" /><h1 className="mt-4 text-lg font-semibold text-slate-800">页面不存在</h1><p className="mt-2 text-sm text-slate-500">这个页面可能已移动，或当前账号没有访问权限。</p><Button className="mt-5" onClick={() => navigate('/')}>返回工作台</Button></Card>
}

