import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money } from '../api.js';
import { useAuth } from '../auth.js';
import { Badge, DEFAULT_VARIANT, Field, FieldHint, Modal, ProductImage, readImageFile, SplitAgora, useToast } from '../ui.js';
import { PageLoader } from '../Loader.js';

interface StockRow {
  id: string; name: string; sku: string | null; isContainer: boolean; imageUrl: string | null; thumbUrl: string | null;
  category: string | null; brand: string | null;
  priceAgora: number | null; costAgora: number | null; minAlert: number;
  rows: { variantId: string | null; qty: number }[];
  totalQty: number; low: boolean; negative: boolean;
  variants: { id: string; name: string; barcode: string }[];
}

export function Inventory() {
  const [rows, setRows] = useState<StockRow[]>([]);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<StockRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [toast, showToast] = useToast();

  const load = () => api<StockRow[]>('/inventory/stock').then(setRows).catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);

  return (
    <div className="card full">
      {toast}
      <div className="row-between">
        <h2>المخزون — سعر وكمية لكل فرع</h2>
        <div className="row2">
          <button className="btn secondary" onClick={load}>تحديث</button>
          <button className="btn" onClick={() => setCreating(true)}>+ صنف جديد</button>
        </div>
      </div>
      <input placeholder="بحث اسم / SKU / باركود..." value={q} onChange={(e) => setQ(e.target.value)} style={{ margin: '10px 0' }} />
      <div className="table-scroll">
      <table className="grid">
        <thead>
          <tr><th>الصنف</th><th>الفئة</th><th>الباركود</th><th>السعر</th><th>التكلفة</th><th>الكمية</th><th>الحالة</th><th></th></tr>
        </thead>
        <tbody>
          {rows.filter((r) => {
            const term = q.trim().toLowerCase();
            if (!term) return true;
            return (
              r.name.toLowerCase().includes(term)
              || (r.sku ?? '').toLowerCase().includes(term)
              || r.variants.some((v) => v.barcode.includes(term))
            );
          }).map((r) => (
            <tr key={r.id}>
              <td>
                <span className="cell-with-img">
                  <ProductImage src={r.imageUrl} thumb={r.thumbUrl} alt={r.name} />
                  {r.name}{r.isContainer ? ' (حاوية)' : ''}
                </span>
              </td>
              <td>{r.category ?? '—'}</td>
              <td className="mono">{r.variants[0]?.barcode ?? r.sku ?? '—'}</td>
              <td>{r.priceAgora === null ? '—' : money(r.priceAgora)}</td>
              <td>{r.costAgora === null ? '—' : money(r.costAgora)}</td>
              <td>{r.totalQty}</td>
              <td>
                {r.negative ? <Badge tone="bad">سالب</Badge> : r.low ? <Badge tone="warn">ناقص</Badge> : <Badge tone="ok">جيد</Badge>}
              </td>
              <td><button className="btn secondary small" onClick={() => setEditing(r)}>تفاصيل</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {creating && <NewProductModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} showToast={showToast} />}
      {editing && <ProductModal product={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} showToast={showToast} />}
    </div>
  );
}

function NewProductModal({ onClose, onDone, showToast }: { onClose: () => void; onDone: () => void; showToast: (m: string, t?: 'ok' | 'bad') => void }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [form, setForm] = useState({ barcode: '', name: '', sku: '', categoryId: '', brandId: '', lowStockDefault: 5, priceAgora: 0, costAgora: 0, variants: '' });
  const [created, setCreated] = useState<any>(null);
  const [taxonomy, setTaxonomy] = useState<{ categories: any[]; brands: any[]; units: any[]; branches: any[] }>({ categories: [], brands: [], units: [], branches: [] });
  const [baseUnitId, setBaseUnitId] = useState('');
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([
      api<any[]>('/catalog/categories'), api<any[]>('/catalog/brands'),
      api<any[]>('/catalog/units'), api<any[]>('/org/branches'),
      api<Record<string, any>>('/settings').catch(() => ({} as Record<string, any>)),
    ]).then(([c, b, u, br, s]) => {
      setTaxonomy({ categories: c, brands: b, units: u, branches: br });
      const qty = Number(s?.low_stock_default?.qty);
      setForm((f) => ({ ...f, lowStockDefault: Number.isFinite(qty) ? qty : 5 }));
    }).catch((e) => showToast((e as Error).message, 'bad'));
  }, []);

  const pickImage = async (file: File | undefined) => {
    if (!file) { setImageDataUrl(null); return; }
    try { setImageDataUrl(await readImageFile(file)); }
    catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const submit = async () => {
    if (!form.name.trim()) { showToast('أدخل اسم الصنف', 'bad'); return; }
    try {
      const branch = taxonomy.branches[0];
      // الباركود الممسوح: يُخصَّص لأول متغير، أو يُنشأ متغير افتراضي للصنف البسيط.
      // إن تُرك فارغاً يولّد الخادم باركوداً تلقائياً.
      const barcode = form.barcode.trim();
      const variantNames = form.variants.split('،').map((v) => v.trim()).filter(Boolean);
      const variants: { name: string; barcode?: string }[] = variantNames.length
        ? variantNames.map((name, i) => (i === 0 && barcode ? { name, barcode } : { name }))
        : barcode
          ? [{ name: DEFAULT_VARIANT, barcode }]
          : [];
      const res = await api<any>('/catalog/products', {
        method: 'POST',
        body: {
          name: form.name.trim(), sku: form.sku || undefined,
          categoryId: form.categoryId || null, brandId: form.brandId || null,
          baseUnitId: baseUnitId || null, lowStockDefault: form.lowStockDefault,
          variants,
          branches: branch ? [{ branchId: branch.id, priceAgora: form.priceAgora, costAgora: form.costAgora }] : [],
        },
      });
      let imgErr = '';
      if (imageDataUrl && res?.id) {
        try { await api(`/catalog/products/${res.id}/image`, { method: 'POST', body: { dataUrl: imageDataUrl } }); }
        catch (e) { imgErr = (e as Error).message; }
      }
      showToast(imgErr ? `أُنشئ الصنف لكن فشل رفع الصورة: ${imgErr}` : 'أُنشئ الصنف', imgErr ? 'bad' : 'ok');
      setCreated(res);
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const addAnother = () => {
    setCreated(null);
    setImageDataUrl(null);
    setForm((f) => ({ ...f, barcode: '', name: '', sku: '', variants: '', priceAgora: 0, costAgora: 0 }));
  };

  const printLabels = () => {
    const vs: any[] = created?.variants ?? [];
    const rows = vs.map((v) => ({
      key: v.barcode,
      name: created.name,
      barcode: v.barcode,
      variant: v.name === DEFAULT_VARIANT ? '' : v.name,
      priceAgora: Math.round(Number(created.branchData?.[0]?.priceAgora ?? 0)),
      brand: created.brand?.name ?? '',
    }));
    sessionStorage.setItem('medad_labels_seed', JSON.stringify(rows));
    navigate('/labels');
  };

  if (created) {
    const bars: string[] = (created.variants ?? []).map((v: any) => v.barcode);
    return (
      <Modal title="أُنشئ الصنف" onClose={onDone}>
        <div className="np-created">
          <p className="np-created-msg">تم إنشاء الصنف «{created.name}» بنجاح.</p>
          <p className="muted">الباركود: <span className="mono" dir="ltr">{bars.length ? bars.join(' ، ') : '—'}</span></p>
          <div className="np-actions">
            <button type="button" className="btn secondary" onClick={onDone}>إغلاق</button>
            <button type="button" className="btn secondary" onClick={addAnother}>صنف جديد آخر</button>
            {can('labels.print') && bars.length > 0 && (
              <button type="button" className="btn" onClick={printLabels}>طباعة الملصقات</button>
            )}
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="صنف جديد" onClose={onClose}>
      <div className="np-form">
        <div className="np-barcode">
          <Field label="الباركود" hint="الخانة الأولى: امسح باركود المنتج الأصلي بجهاز الباركود وسيُعبَّأ تلقائياً. للأصناف بلا باركود اتركه فارغاً ليُولَّد باركود داخلي. عند إدخال المتغيرات يُخصَّص الباركود لأول متغير.">
            <input
              dir="ltr"
              autoFocus
              className="mono"
              value={form.barcode}
              onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); nameRef.current?.focus(); } }}
              placeholder="امسح الباركود هنا…"
            />
          </Field>
        </div>
        <div className="np-photo">
          <ProductImage src={imageDataUrl} alt="صورة الصنف" size={88} />
          <div className="np-photo-body">
            <span className="field-label">
              صورة الصنف
              <FieldHint text="صورة اختيارية تظهر في الكاشير وجدول المخزون. الصيغ المدعومة: PNG و JPEG و WebP و GIF." />
            </span>
            <div className="np-photo-actions">
              <label className="btn secondary small np-file-btn">
                {imageDataUrl ? 'تغيير الصورة' : 'اختيار صورة'}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => void pickImage(e.target.files?.[0])} />
              </label>
              {imageDataUrl && <button type="button" className="btn secondary small" onClick={() => setImageDataUrl(null)}>إزالة</button>}
            </div>
            <span className="np-photo-note">اختياري — إن تُركت فارغة تُستخدم الصورة الافتراضية</span>
          </div>
        </div>
        <div className="np-grid">
          <div className="np-span-2">
            <Field label="الاسم" hint="اسم الصنف كما سيظهر في الكاشير والمخزون والفواتير.">
              <input ref={nameRef} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="مثال: حليب كامل الدسم" />
            </Field>
          </div>
          <Field label="SKU" hint="رمز داخلي اختياري لتمييز الصنف. يمكن البحث به لاحقاً من شريط البحث.">
            <input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} placeholder="اختياري" />
          </Field>
          <Field label="حد التنبيه" hint="الكمية التي عندها يُعتبر الصنف ناقصاً. القيمة الافتراضية مأخوذة من إعداد «حد التنبيه العام (النواقص)» في صفحة الإعدادات.">
            <input type="number" min={0} value={form.lowStockDefault} onChange={(e) => setForm({ ...form, lowStockDefault: Number(e.target.value) })} />
          </Field>
          <Field label="الفئة" hint="تصنيف الصنف لتسهيل التصفية والتقارير. يمكن تركه فارغاً.">
            <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
              <option value="">بدون فئة</option>
              {taxonomy.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="الماركة" hint="الشركة أو العلامة التجارية للصنف. اختياري.">
            <select value={form.brandId} onChange={(e) => setForm({ ...form, brandId: e.target.value })}>
              <option value="">بدون ماركة</option>
              {taxonomy.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="الوحدة الأساسية" hint="وحدة القياس الافتراضية (قطعة، كغ، لتر…). تُستخدم عند البيع والجرد.">
            <select value={baseUnitId} onChange={(e) => setBaseUnitId(e.target.value)}>
              <option value="">بدون وحدة</option>
              {taxonomy.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
          <Field label="المتغيرات" hint="أسماء الألوان أو المقاسات مفصولة بفاصلة عربية «،». يُنشأ لكل منها باركود تلقائي (أول متغير يأخذ الباركود الممسوح إن وُجد). اتركه فارغاً لصنف بسيط.">
            <input placeholder="أحمر، أزرق" value={form.variants} onChange={(e) => setForm({ ...form, variants: e.target.value })} />
          </Field>
          <Field label="سعر البيع" hint="سعر البيع في الفرع الحالي بالشيكل كما يظهر للزبون. خانة الأغورات اختيارية ولا يلزم تعبئتها.">
            <SplitAgora agora={form.priceAgora} onAgora={(v) => setForm({ ...form, priceAgora: v })} label="سعر البيع" />
          </Field>
          <Field label="التكلفة" hint="تكلفة شراء الصنف في الفرع الحالي. تُستخدم لحساب الربح ولا تظهر للزبون.">
            <SplitAgora agora={form.costAgora} onAgora={(v) => setForm({ ...form, costAgora: v })} label="التكلفة" />
          </Field>
        </div>
        <div className="np-actions">
          <button type="button" className="btn secondary" onClick={onClose}>إلغاء</button>
          <button type="button" className="btn" onClick={submit} disabled={!form.name.trim()}>حفظ الصنف</button>
        </div>
      </div>
    </Modal>
  );
}

function ProductModal({ product, onClose, onDone, showToast }: { product: StockRow; onClose: () => void; onDone: () => void; showToast: (m: string, t?: 'ok' | 'bad') => void }) {
  const [detail, setDetail] = useState<any>(null);
  const [newVariant, setNewVariant] = useState('');
  const [convert, setConvert] = useState('');
  const [units, setUnits] = useState<{ unitId: string; factor: number }[]>([]);
  const [components, setComponents] = useState<{ label: string; amountAgora: number }[]>([]);
  const [price, setPrice] = useState(product.priceAgora ?? 0);
  const [cost, setCost] = useState(product.costAgora ?? 0);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);

  const load = () => api<any>(`/catalog/products/${product.id}`).then((d) => {
    setDetail(d);
    setUnits(d.units.map((u: any) => ({ unitId: u.unitId, factor: u.factor })));
    setComponents(d.costComponents.map((c: any) => ({ label: c.label, amountAgora: c.amountAgora })));
  });
  useEffect(() => { void load(); /* eslint-disable-line */ }, []);

  const branchId = async () => (await api<any[]>('/org/branches'))[0]?.id ?? '';

  const pickImage = async (file: File | undefined) => {
    if (!file) { setImageDataUrl(null); return; }
    try { setImageDataUrl(await readImageFile(file)); }
    catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const saveImage = async () => {
    if (!imageDataUrl) return;
    try {
      await api(`/catalog/products/${product.id}/image`, { method: 'POST', body: { dataUrl: imageDataUrl } });
      showToast('حُفظت صورة الصنف');
      setImageDataUrl(null);
      onDone();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const removeImage = async () => {
    try {
      await api(`/catalog/products/${product.id}`, { method: 'PUT', body: { imageUrl: null } });
      showToast('أُزيلت صورة الصنف — ستظهر الصورة الافتراضية');
      onDone();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const saveBranch = async () => {
    try {
      await api(`/catalog/products/${product.id}/branches/${await branchId()}`, { method: 'PUT', body: { priceAgora: price, costAgora: cost } });
      showToast('حُفظ السعر والتكلفة');
      onDone();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const addVariant = async () => {
    try {
      await api(`/catalog/products/${product.id}/variants`, { method: 'POST', body: { name: newVariant } });
      showToast('أُضيف متغير بباركود تلقائي');
      setNewVariant(''); void load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const doConvert = async () => {
    try {
      await api(`/catalog/products/${product.id}/convert`, { method: 'POST', body: { variants: convert.split('،').map((v) => v.trim()).filter(Boolean).map((name) => ({ name })) } });
      showToast('تحوّل لمتغيرات — الصنف الأب صار حاوية');
      onDone();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const saveUnits = async () => {
    try {
      await api(`/catalog/products/${product.id}/units`, { method: 'PUT', body: { units } });
      showToast('حُفظت معاملات الوحدات');
      void load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const saveCost = async () => {
    try {
      const r = await api<{ totalAgora: number }>(`/catalog/products/${product.id}/cost-components`, { method: 'PUT', body: { components } });
      showToast(`مكونات التكلفة = ${money(r.totalAgora)} (تطبق تلقائياً على كل الفروع)`);
      void load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <Modal title={`تفاصيل: ${product.name}`} onClose={onClose}>
      {!detail ? <PageLoader /> : (
        <>
          <h4>صورة الصنف</h4>
          <div className="img-editor">
            <ProductImage src={imageDataUrl ?? detail.imageUrl} thumb={imageDataUrl ? undefined : detail.thumbUrl} alt={product.name} size={72} />
            <Field label="اختيار صورة (اختياري)">
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => void pickImage(e.target.files?.[0])} />
            </Field>
            {imageDataUrl && <button className="btn small" onClick={saveImage}>حفظ الصورة</button>}
            {detail.imageUrl && <button className="btn secondary small" onClick={removeImage}>إزالة الصورة</button>}
          </div>
          <h4>الباركودات</h4>
          <ul className="mono">
            {detail.variants.map((v: any) => <li key={v.id}>{v.name}: {v.barcode}</li>)}
          </ul>
          <div className="row2">
            <input placeholder="متغير جديد" value={newVariant} onChange={(e) => setNewVariant(e.target.value)} />
            <button className="btn secondary" onClick={addVariant}>+ متغير</button>
          </div>
          {!detail.isContainer && (
            <div className="row2">
              <input placeholder="تحويل: أحمر، أزرق" value={convert} onChange={(e) => setConvert(e.target.value)} />
              <button className="btn secondary" onClick={doConvert}>تحويل بسيط → متغيرات</button>
            </div>
          )}
          <h4>وحدات البيع (معامل يدوي)</h4>
          {units.map((u, i) => (
            <div className="row2" key={i}>
              <input type="number" min={1} value={u.factor} onChange={(e) => setUnits(units.map((x, j) => j === i ? { ...x, factor: Number(e.target.value) } : x))} placeholder="معامل" />
              <button className="btn secondary small" onClick={() => setUnits(units.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="btn secondary small" onClick={() => setUnits([...units, { unitId: detail.baseUnitId ?? '', factor: 1 }])}>+ وحدة</button>
          <button className="btn secondary small" onClick={saveUnits}>حفظ الوحدات</button>

          <h4>مكونات التكلفة (المجموع = التكلفة تلقائياً)</h4>
          {components.map((c, i) => (
            <div className="row2" key={i}>
              <input value={c.label} onChange={(e) => setComponents(components.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} placeholder="الوصف" />
              <SplitAgora agora={c.amountAgora} label="مبلغ المكوّن" onAgora={(v) => setComponents(components.map((x, j) => j === i ? { ...x, amountAgora: v } : x))} />
              <button className="btn secondary small" onClick={() => setComponents(components.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div className="row2">
            <button className="btn secondary small" onClick={() => setComponents([...components, { label: '', amountAgora: 0 }])}>+ مكون</button>
            <button className="btn secondary small" onClick={saveCost}>حفظ المكونات</button>
          </div>

          <h4>سعر وتكلفة الفرع</h4>
          <div className="row2">
            <Field label="السعر"><SplitAgora agora={price} onAgora={setPrice} label="السعر" /></Field>
            <Field label="التكلفة"><SplitAgora agora={cost} onAgora={setCost} label="التكلفة" /></Field>
            <button className="btn" onClick={saveBranch}>حفظ</button>
          </div>
        </>
      )}
    </Modal>
  );
}
