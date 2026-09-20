import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CatalogService } from './catalog.service.js';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  @RequirePerm('catalog.view')
  categories(@CurrentUser() u: AuthUser) { return this.catalog.listCategories(u.tenantId); }

  @Get('brands')
  @RequirePerm('catalog.view')
  brands(@CurrentUser() u: AuthUser) { return this.catalog.listBrands(u.tenantId); }

  @Get('units')
  @RequirePerm('catalog.view')
  units(@CurrentUser() u: AuthUser) { return this.catalog.listUnits(u.tenantId); }

  @Post('categories')
  @RequirePerm('catalog.manage')
  createCategory(@CurrentUser() u: AuthUser, @Body() b: { name: string; parentId?: string | null }) { return this.catalog.createCategory(u.tenantId, b, u.userId); }

  @Post('brands')
  @RequirePerm('catalog.manage')
  createBrand(@CurrentUser() u: AuthUser, @Body() b: { name: string }) { return this.catalog.createBrand(u.tenantId, b, u.userId); }

  @Post('units')
  @RequirePerm('catalog.manage')
  createUnit(@CurrentUser() u: AuthUser, @Body() b: { name: string; symbol?: string }) { return this.catalog.createUnit(u.tenantId, b, u.userId); }

  @Delete(':entity/:id')
  @RequirePerm('catalog.manage')
  softDelete(@CurrentUser() u: AuthUser, @Param('entity') entity: string, @Param('id') id: string) {
    if (!['category', 'brand', 'unit'].includes(entity)) throw new BadRequestException('لا يمكن حذف هذا النوع من العناصر');
    return this.catalog.softDelete(u.tenantId, entity as 'category' | 'brand' | 'unit', id, u.userId);
  }

  @Get('products')
  @RequirePerm('catalog.view')
  products(
    @CurrentUser() u: AuthUser,
    @Query('search') search?: string,
    @Query('categoryId') categoryId?: string,
    @Query('brandId') brandId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.catalog.listProducts(u.tenantId, { search, categoryId, brandId, page: page ? Number(page) : 1, pageSize: pageSize ? Number(pageSize) : 50 });
  }

  @Get('products/:id')
  @RequirePerm('catalog.view')
  product(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.catalog.getProduct(u.tenantId, id); }

  @Post('products')
  @RequirePerm('catalog.manage')
  createProduct(@CurrentUser() u: AuthUser, @Body() b: Parameters<CatalogService['createProduct']>[1]) {
    return this.catalog.createProduct(u.tenantId, b, u.userId);
  }

  @Put('products/:id')
  @RequirePerm('catalog.manage')
  updateProduct(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: Parameters<CatalogService['updateProduct']>[2]) {
    return this.catalog.updateProduct(u.tenantId, id, b, u.userId);
  }

  @Post('products/:id/image')
  @RequirePerm('catalog.manage')
  uploadImage(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { dataUrl: string }) {
    return this.catalog.setProductImage(u.tenantId, id, b?.dataUrl ?? '', u.userId);
  }

  @Post('products/:id/convert')
  @RequirePerm('catalog.manage')
  convert(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { variants: { name: string; barcode?: string }[] }) {
    return this.catalog.convertToVariants(u.tenantId, id, b.variants, u.userId);
  }

  @Post('products/:id/variants')
  @RequirePerm('catalog.manage')
  addVariant(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { name: string; barcode?: string }) {
    return this.catalog.addVariant(u.tenantId, id, b, u.userId);
  }

  @Put('products/:id/units')
  @RequirePerm('catalog.manage')
  setUnits(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { units: { unitId: string; factor: number; barcode?: string | null }[] }) {
    return this.catalog.setProductUnits(u.tenantId, id, b.units, u.userId);
  }

  @Put('products/:id/cost-components')
  @RequirePerm('catalog.manage')
  setCost(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { components: { label: string; amountAgora: number }[] }) {
    return this.catalog.setCostComponents(u.tenantId, id, b.components, u.userId);
  }

  @Put('products/:id/branches/:branchId')
  @RequirePerm('catalog.manage')
  setBranch(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('branchId') branchId: string, @Body() b: { priceAgora?: number; costAgora?: number; minAlert?: number | null }) {
    return this.catalog.setBranchData(u.tenantId, id, branchId, b, u.userId);
  }

  @Get('search')
  @RequirePerm('pos.view')
  search(@CurrentUser() u: AuthUser, @Query('branchId') branchId: string, @Query('q') q: string) {
    return this.catalog.searchForSale(u.tenantId, branchId ?? u.branchId ?? '', q ?? '');
  }
}
