import { uid as _uid } from '../lib/uid'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { CheckCircle2, Info, X, XCircle } from 'lucide-react'

type ToastType = 'success' | 'error' | 'info'
interface ToastItem {
  id: string
  message: string
  type: ToastType
}

const ToastContext = createContext<{ showToast: (message: string, type?: ToastType) => void } | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const showToast = useCallback((message: string, type: ToastType = 'success') => {
    const toast = { id: _uid(), message, type }
    setToasts((items) => [...items, toast])
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== toast.id)), 3200)
  }, [])
  const value = useMemo(() => ({ showToast }), [showToast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed right-6 top-5 z-[100] flex w-[360px] flex-col gap-2">
        {toasts.map((toast) => (
          <div key={toast.id} className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xl shadow-slate-900/10">
            {toast.type === 'success' ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-500" /> : toast.type === 'error' ? <XCircle className="mt-0.5 h-5 w-5 text-rose-500" /> : <Info className="mt-0.5 h-5 w-5 text-brand-500" />}
            <p className="flex-1 text-sm leading-5 text-slate-700">{toast.message}</p>
            <button aria-label="关闭提示" onClick={() => setToasts((items) => items.filter((item) => item.id !== toast.id))}><X className="h-4 w-4 text-slate-400" /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast must be used inside ToastProvider')
  return value
}

