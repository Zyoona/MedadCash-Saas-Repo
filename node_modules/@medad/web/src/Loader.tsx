import { useEffect, useRef, useState } from 'react';
import { subscribeLoading } from './api.js';

export function BrandLoader({ onDone }: { onDone?: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const t1 = setTimeout(() => setLeaving(true), 1900);
    const t2 = setTimeout(() => doneRef.current?.(), 2450);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  return (
    <div className={leaving ? 'brand-loader leaving' : 'brand-loader'} aria-busy="true" role="status">
      <div className="loader-stage">
        <div className="loader-ring" />
        <div className="loader-ring ring-2" />
        <div className="loader-halo" />
        <div className="loader-logo-wrap">
          <img src="/logo.png" alt="مداد" className="loader-logo" />
          <div className="loader-shine" />
        </div>
      </div>
      <div className="loader-title">مداد</div>
      <div className="loader-sub">إدارة ومحاسبة المكتبة</div>
      <div className="loader-bar">
        <div className="loader-bar-fill" />
      </div>
    </div>
  );
}

function usePendingCount(): number {
  const [n, setN] = useState(0);
  useEffect(() => subscribeLoading(setN), []);
  return n;
}

/** لودر علوي رفيع يظهر مع أي طلب API جارٍ. */
export function TopLoader() {
  const pending = usePendingCount();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (pending > 0) {
      const t = setTimeout(() => setVisible(true), 120);
      return () => clearTimeout(t);
    }
    setVisible(false);
    return undefined;
  }, [pending]);

  if (!visible) return null;
  return (
    <div className="top-loader" role="status" aria-busy="true" aria-label="جارٍ التحميل">
      <div className="top-loader-fill" />
    </div>
  );
}

/** لودر داخل الصفحة يُستخدم بدل نص "جارٍ التحميل..." أو "...". */
export function PageLoader({ text = 'جارٍ التحميل...' }: { text?: string }) {
  return (
    <div className="page-loader" role="status" aria-busy="true" aria-label={text}>
      <div className="page-loader-spinner" />
      <div className="page-loader-text">{text}</div>
    </div>
  );
}

/** طبقة تحميل فوق المحتوى عند التنقل بين الصفحات أو انتظار طلبات ثقيلة. */
export function RouteLoaderOverlay({ text }: { text?: string }) {
  return (
    <div className="route-loader-overlay">
      <div className="route-loader-card">
        <PageLoader text={text} />
      </div>
    </div>
  );
}
