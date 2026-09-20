-- Medad 0006_product_thumb — مصغّرة صورة الصنف.
-- تُولَّد على الخادم (sharp) عند رفع الصورة: WebP 128×128 لعرض سريع في القوائم.
-- عند غياب المصغّرة تعرض الواجهة الصورة الأصلية ثم الصورة الافتراضية /product-default.png.

ALTER TABLE "products" ADD COLUMN "thumbUrl" TEXT;
