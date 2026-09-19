import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { agoraToDec, decToAgora } from '../../common/money.util.js';
import { auditTx, type Db } from '../../common/ctx.js';

// Catalog (§Phase2): central tenant-level catalog (name/barcode/category/unit),
// price & cost per branch (ProductBranch), qty DERIVED from BranchStock only.

function genBarcode(): string {
  // Internal barcode: 2 + 12 digits (timestamp+random). Uniqueness verified by caller.
  const t = Date.now().toString().slice(-9);
  const r = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `2${t}${r}`;
}

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  private async uniqueBarcode(db: Db, tenantId: string): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const b = genBarcode();
      const exists = await db.productVariant.findFirst({ where: { tenantId, barcode: b }, select: { id: true } });
      if (!exists) return b;
    }
    throw new ConflictException('تعذر توليد باركود فريد');
  }

  // ─── Taxonomy ───

  listCategories(tenantId: string) {
    return this.prisma.category.findMany({ where: { tenantId, deletedAt: null }, orderBy: { name: 'asc' } });
  }
  listBrands(tenantId: string) {
    return this.prisma.brand.findMany({ where: { tenantId, deletedAt: null }, orderBy: { name: 'asc' } });
  }
  listUnits(tenantId: string) {
    return this.prisma.unit.findMany({ where: { tenantId, deletedAt: null }, orderBy: { name: 'asc' } });
  }

  async createCategory(tenantId: string, input: { name: string; parentId?: string | null }, actorId: string) {
    return this.prisma.$transaction(async (db: Db) => {
      const row = await db.category.create({ data: { tenantId, name: input.name, parentId: input.parentId ?? null } });
      await auditTx(db, { tenantId, actorId, action: 'create', entity: 'categories', entityId: row.id, diff: input });
      return row;
    });
  }
  async createBrand(tenantId: string, input: { name: string }, actorId: string) {
    return this.prisma.$transaction(async (db: Db) => {
      const row = await db.brand.create({ data: { tenantId, name: input.name } });
      await auditTx(db, { tenantId, actorId, action: 'create', entity: 'brands', entityId: row.id, diff: input });
      return row;
    });
  }
  async createUnit(tenantId: string, input: { name: string; symbol?: string }, actorId: string) {
    return this.prisma.$transaction(async (db: Db) => {
      const row = await db.unit.create({ data: { tenantId, name: input.name, symbol: input.symbol ?? null } });
      await auditTx(db, { tenantId, actorId, action: 'create', entity: 'units', entityId: row.id, diff: input });
      return row;
    });
  }
  async softDelete(tenantId: string, entity: 'category' | 'brand' | 'unit', id: string, actorId: string) {
    const model = { category: 'category', brand: 'brand', unit: 'unit' }[entity];
    return this.prisma.$transaction(async (db: Db) => {
      const row = await db[model].update({ where: { id }, data: { deletedAt: new Date() } });
      await auditTx(db, { tenantId, actorId, action: 'delete', entity: `${entity}s`, entityId: id });
      return row;
    });
  }

  // ─── Products ───

  async listProducts(tenantId: string, q: { search?: string; categoryId?: string; brandId?: string; page?: number; pageSize?: number }) {
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 50, 200);
    const where: Prisma.ProductWhereInput = {
      tenantId,
      deletedAt: null,
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.brandId ? { brandId: q.brandId } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { sku: { contains: q.search, mode: 'insensitive' } },
              { variants: { some: { barcode: { contains: q.search } } } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          category: { select: { id: true, name: true } },
          brand: { select: { id: true, name: true } },
          variants: { where: { deletedAt: null }, select: { id: true, name: true, barcode: true } },
          branchData: { select: { branchId: true, price: true, cost: true, minAlert: true } },
        },
      }),
    ]);
    return {
      total, page, pageSize,
      rows: rows.map((p) => ({
        ...p,
        branchData: p.branchData.map((b) => ({ ...b, priceAgora: decToAgora(b.price), costAgora: decToAgora(b.cost) })),
      })),
    };
  }

  async getProduct(tenantId: string, id: string) {
    const p = await this.prisma.product.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        category: true, brand: true,
        variants: { where: { deletedAt: null } },
        units: { include: { unit: true } },
        costComponents: true,
        branchData: true,
      },
    });
    if (!p) throw new NotFoundException('الصنف غير موجود');
    return {
      ...p,
      costComponents: p.costComponents.map((c) => ({ ...c, amountAgora: decToAgora(c.amount) })),
      branchData: p.branchData.map((b) => ({ ...b, priceAgora: decToAgora(b.price), costAgora: decToAgora(b.cost) })),
    };
  }

  async createProduct(tenantId: string, input: {
    name: string; sku?: string; categoryId?: string | null; brandId?: string | null; baseUnitId?: string | null;
    lowStockDefault?: number;
    variants?: { name: string; barcode?: string }[];
    branches?: { branchId: string; priceAgora?: number; costAgora?: number; minAlert?: number | null }[];
  }, actorId: string) {
    if (!input.name?.trim()) throw new BadRequestException('اسم الصنف مطلوب');
    const created = await this.prisma.$transaction(async (db: Db) => {
      const product = await db.product.create({
        data: {
          tenantId, name: input.name.trim(), sku: input.sku ?? null,
          categoryId: input.categoryId ?? null, brandId: input.brandId ?? null,
          baseUnitId: input.baseUnitId ?? null, lowStockDefault: input.lowStockDefault ?? 0,
        },
      });
      for (const v of input.variants ?? []) {
        const barcode = v.barcode?.trim() || (await this.uniqueBarcode(db, tenantId));
        const dup = await db.productVariant.findFirst({ where: { tenantId, barcode } });
        if (dup) throw new ConflictException(`باركود مستخدم: ${barcode}`);
        await db.productVariant.create({ data: { tenantId, productId: product.id, name: v.name, barcode } });
      }
      for (const b of input.branches ?? []) {
        await db.productBranch.create({
          data: {
            tenantId, productId: product.id, branchId: b.branchId,
            price: agoraToDec(b.priceAgora ?? 0),
            cost: agoraToDec(b.costAgora ?? 0),
            minAlert: b.minAlert ?? null,
          },
        });
      }
      await auditTx(db, { tenantId, actorId, action: 'create', entity: 'products', entityId: product.id, diff: input });
      return product;
    });
    return this.getProduct(tenantId, created.id);
  }

  async updateProduct(tenantId: string, id: string, patch: {
    name?: string; sku?: string | null; categoryId?: string | null; brandId?: string | null;
    baseUnitId?: string | null; lowStockDefault?: number;
  }, actorId: string) {
    const p = await this.prisma.product.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!p) throw new NotFoundException('الصنف غير موجود');
    return this.prisma.$transaction(async (db: Db) => {
      const updated = await db.product.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.sku !== undefined ? { sku: patch.sku } : {}),
          ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
          ...(patch.brandId !== undefined ? { brandId: patch.brandId } : {}),
          ...(patch.baseUnitId !== undefined ? { baseUnitId: patch.baseUnitId } : {}),
          ...(patch.lowStockDefault !== undefined ? { lowStockDefault: patch.lowStockDefault } : {}),
        },
      });
      await auditTx(db, { tenantId, actorId, action: 'update', entity: 'products', entityId: id, diff: patch });
      return updated;
    });
  }

  /** Simple → variants (§3): create variants, parent becomes a non-sellable container. Old sales stay linked to parent. */
  async convertToVariants(tenantId: string, productId: string, variants: { name: string; barcode?: string }[], actorId: string) {
    const p = await this.prisma.product.findFirst({ where: { id: productId, tenantId, deletedAt: null } });
    if (!p) throw new NotFoundException('الصنف غير موجود');
    if (p.isContainer) throw new ConflictException('الصنف حاوية مسبقاً');
    if (!variants?.length) throw new BadRequestException('قائمة المتغيرات مطلوبة');
    return this.prisma.$transaction(async (db: Db) => {
      const created = [];
      for (const v of variants) {
        const barcode = v.barcode?.trim() || (await this.uniqueBarcode(db, tenantId));
        const dup = await db.productVariant.findFirst({ where: { tenantId, barcode } });
        if (dup) throw new ConflictException(`باركود مستخدم: ${barcode}`);
        created.push(await db.productVariant.create({ data: { tenantId, productId, name: v.name, barcode } }));
      }
      await db.product.update({ where: { id: productId }, data: { isContainer: true } });
      await auditTx(db, { tenantId, actorId, action: 'convert_to_variants', entity: 'products', entityId: productId, diff: { variants: created.map((c) => c.barcode) } });
      return created;
    });
  }

  async addVariant(tenantId: string, productId: string, input: { name: string; barcode?: string }, actorId: string) {
    return this.prisma.$transaction(async (db: Db) => {
      const barcode = input.barcode?.trim() || (await this.uniqueBarcode(db, tenantId));
      const dup = await db.productVariant.findFirst({ where: { tenantId, barcode } });
      if (dup) throw new ConflictException(`باركود مستخدم: ${barcode}`);
      const v = await db.productVariant.create({ data: { tenantId, productId, name: input.name, barcode } });
      await auditTx(db, { tenantId, actorId, action: 'create', entity: 'product_variants', entityId: v.id, diff: input });
      return v;
    });
  }

  /** Replace the unit-conversion set (manual factors §3). */
  async setProductUnits(tenantId: string, productId: string, units: { unitId: string; factor: number; barcode?: string | null }[], actorId: string) {
    if (units.some((u) => !Number.isInteger(u.factor) || u.factor < 1)) throw new BadRequestException('معامل التحويل عدد صحيح ≥ 1');
    return this.prisma.$transaction(async (db: Db) => {
      await db.productUnit.deleteMany({ where: { productId, tenantId } });
      for (const u of units) {
        await db.productUnit.create({ data: { tenantId, productId, unitId: u.unitId, factor: u.factor, barcode: u.barcode ?? null } });
      }
      await auditTx(db, { tenantId, actorId, action: 'update', entity: 'product_units', entityId: productId, diff: units });
      return db.productUnit.findMany({ where: { productId, tenantId }, include: { unit: true } });
    });
  }

  /** Replace cost components; product cost = sum → auto-applied to all branches (§3). */
  async setCostComponents(tenantId: string, productId: string, components: { label: string; amountAgora: number }[], actorId: string) {
    if (components.some((c) => !Number.isInteger(c.amountAgora) || c.amountAgora < 0)) throw new BadRequestException('مبالغ غير صالحة');
    const total = components.reduce((s, c) => s + c.amountAgora, 0);
    return this.prisma.$transaction(async (db: Db) => {
      await db.costComponent.deleteMany({ where: { productId, tenantId } });
      for (const c of components) {
        await db.costComponent.create({ data: { tenantId, productId, label: c.label, amount: agoraToDec(c.amountAgora) } });
      }
      await db.productBranch.updateMany({ where: { tenantId, productId }, data: { cost: agoraToDec(total) } });
      await auditTx(db, { tenantId, actorId, action: 'update', entity: 'cost_components', entityId: productId, diff: { components, totalAgora: total } });
      return { totalAgora: total };
    });
  }

  /** Per-branch price/cost/minAlert (§3: السعر لكل فرع). */
  async setBranchData(tenantId: string, productId: string, branchId: string, input: { priceAgora?: number; costAgora?: number; minAlert?: number | null }, actorId: string) {
    return this.prisma.$transaction(async (db: Db) => {
      const existing = await db.productBranch.findFirst({ where: { tenantId, productId, branchId } });
      const data = {
        ...(input.priceAgora !== undefined ? { price: agoraToDec(input.priceAgora) } : {}),
        ...(input.costAgora !== undefined ? { cost: agoraToDec(input.costAgora) } : {}),
        ...(input.minAlert !== undefined ? { minAlert: input.minAlert } : {}),
      };
      const row = existing
        ? await db.productBranch.update({ where: { id: existing.id }, data })
        : await db.productBranch.create({
            data: {
              tenantId, productId, branchId,
              price: agoraToDec(input.priceAgora ?? 0),
              cost: agoraToDec(input.costAgora ?? 0),
              minAlert: input.minAlert ?? null,
            },
          });
      await auditTx(db, { tenantId, actorId, branchId, action: 'update', entity: 'product_branch', entityId: row.id, diff: input });
      return row;
    });
  }

  /** POS search: name / sku / barcode (§Phase4), sellable items only. */
  async searchForSale(tenantId: string, branchId: string, q: string) {
    const term = q.trim();
    if (!term) return [];
    const products = await this.prisma.product.findMany({
      where: {
        tenantId, deletedAt: null,
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { sku: { contains: term, mode: 'insensitive' } },
          { variants: { some: { barcode: { contains: term }, deletedAt: null } } },
        ],
      },
      take: 25,
      include: {
        variants: { where: { deletedAt: null }, select: { id: true, name: true, barcode: true } },
        branchData: { where: { branchId }, select: { price: true, cost: true, minAlert: true } },
      },
    });
    const exactBarcode = await this.prisma.productUnit.findMany({
      where: { tenantId, barcode: term },
      include: { product: { include: { branchData: { where: { branchId } } } } },
      take: 1,
    });
    return { products, unitMatch: exactBarcode };
  }
}
