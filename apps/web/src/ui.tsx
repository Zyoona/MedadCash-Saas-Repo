import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { money } from './api.js';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn secondary" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.id} className={t.id === active ? 'tab active' : 'tab'} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Money({ agora, className }: { agora: number | null | undefined; className?: string }) {
  return <span className={className}>{agora === null || agora === undefined ? '—' : money(agora)}</span>;
}

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'bad'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function useToast(): [ReactNode, (msg: string, tone?: 'ok' | 'bad') => void] {
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = (text: string, tone: 'ok' | 'bad' = 'ok') => {
    setMsg({ text, tone });
    window.clearTimeout(timer.current);
    // رسائل الخطأ تبقى ظاهرة مدة أطول ليسهل قراءتها
    timer.current = window.setTimeout(() => setMsg(null), tone === 'bad' ? 7000 : 3500);
  };
  const node = msg ? (
    <div
      className={`toast ${msg.tone}`}
      role={msg.tone === 'bad' ? 'alert' : 'status'}
      aria-live="polite"
      title="انقر للإخفاء"
      onClick={() => { window.clearTimeout(timer.current); setMsg(null); }}
    >
      {msg.text}
    </div>
  ) : null;
  return [node, show];
}

/** حاسبة قابلة للسحب بمظهر آلة حقيقية (§Phase5 إضافات) */
type CalcKey = { label: string; value?: string; kind?: 'fn' | 'op' | 'eq' };

const KEYS: CalcKey[] = [
  { label: 'C', kind: 'fn' },
  { label: '⌫', kind: 'fn' },
  { label: '(', value: '(', kind: 'fn' },
  { label: '÷', value: '/', kind: 'op' },
  { label: '7', value: '7' },
  { label: '8', value: '8' },
  { label: '9', value: '9' },
  { label: '×', value: '*', kind: 'op' },
  { label: '4', value: '4' },
  { label: '5', value: '5' },
  { label: '6', value: '6' },
  { label: '−', value: '-', kind: 'op' },
  { label: '1', value: '1' },
  { label: '2', value: '2' },
  { label: '3', value: '3' },
  { label: '+', value: '+', kind: 'op' },
  { label: '0', value: '0' },
  { label: '00', value: '00' },
  { label: '.', value: '.' },
  { label: '=', kind: 'eq' },
];

export function Calculator() {
  const [open, setOpen] = useState(false);
  const [expr, setExpr] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragOffset = useRef({ dx: 0, dy: 0 });
  const dragSize = useRef({ w: 0, h: 0 });

  useEffect(() => {
    if (open) return;
    setPos(null);
    setDragging(false);
    setError(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!dragging) return;
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.userSelect = '';
    };
  }, [dragging]);

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    setPos({ x: rect.left, y: rect.top });
    dragOffset.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    dragSize.current = { w: rect.width, h: rect.height };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const x = Math.min(Math.max(e.clientX - dragOffset.current.dx, 8), window.innerWidth - dragSize.current.w - 8);
    const y = Math.min(Math.max(e.clientY - dragOffset.current.dy, 8), window.innerHeight - dragSize.current.h - 8);
    setPos({ x, y });
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const press = (v: string) => {
    setError(false);
    setExpr((e) => e + v);
  };

  const backspace = () => {
    setError(false);
    setExpr((e) => e.slice(0, -1));
  };

  const clearAll = () => {
    setExpr('');
    setResult('');
    setError(false);
  };

  const equals = () => {
    if (!expr) return;
    try {
      // محدد: أرقام وعمليات فقط
      if (!/^[\d+\-*/.() ]+$/.test(expr)) throw new Error();
      // eslint-disable-next-line no-new-func
      const val = Function(`"use strict";return (${expr})`)() as number;
      if (!Number.isFinite(val)) throw new Error();
      setResult(String(Math.round(val * 100) / 100));
      setError(false);
    } catch {
      setResult('خطأ');
      setError(true);
    }
  };

  const pretty = expr.replace(/\*/g, '×').replace(/\//g, '÷').replace(/-/g, '−');

  const onKeyClick = (k: CalcKey) => {
    if (k.label === 'C') clearAll();
    else if (k.label === '⌫') backspace();
    else if (k.kind === 'eq') equals();
    else press(k.value ?? k.label);
  };

  return (
    <div className="calc">
      {open && (
        <div
          ref={panelRef}
          className={`calc-body${pos ? ' floating' : ''}${dragging ? ' dragging' : ''}`}
          style={pos ? { position: 'fixed', left: pos.x, top: pos.y } : undefined}
        >
          <div
            className="calc-head"
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            title="اسحب لنقل الحاسبة"
          >
            <span className="calc-grip" aria-hidden="true">⠿</span>
            <span>الحاسبة</span>
            <button type="button" className="calc-close" aria-label="إغلاق الحاسبة" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="calc-screen">
            <div className="calc-expr">{pretty || '0'}</div>
            <div className={`calc-res${error ? ' error' : ''}`}>{result || '0'}</div>
          </div>
          <div className="calc-keys">
            {KEYS.map((k) => (
              <button key={k.label} type="button" className={k.kind ? `key-${k.kind}` : undefined} onClick={() => onKeyClick(k)}>
                {k.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <button type="button" className="btn secondary calc-toggle" onClick={() => setOpen(!open)} aria-label="الحاسبة">🧮</button>
    </div>
  );
}

/** ساعة حية (موجودة منذ المرحلة 0) */
export function useLiveClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function CsvButton({ filename, rows }: { filename: string; rows: Record<string, unknown>[] }) {
  const download = () => {
    if (!rows.length) return;
    const head = Object.keys(rows[0]);
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = `\uFEFF${head.map(esc).join(',')}\n${rows.map((r) => head.map((h) => esc(r[h])).join(',')).join('\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  return <button className="btn secondary" onClick={download}>تصدير CSV</button>;
}
