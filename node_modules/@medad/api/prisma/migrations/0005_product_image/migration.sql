-- Medad 0005_product_image — صورة الصنف (اختيارية).
-- عند غياب الصورة تعرض الواجهة الصورة الافتراضية /product.png من مجلد public لتطبيق الويب.
-- الصور المرفوعة تُخزن على القرص (UPLOAD_DIR) وتُخدم عبر /api/uploads.

ALTER TABLE "products" ADD COLUMN "imageUrl" TEXT;
