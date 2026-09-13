import { MobileBundle, PriceBounds, Product } from '@/types';

export const OFFLINE_PRICING_ENGINE_VERSION = '9.4e-1';
export type CanonicalWallType = 'cbs' | 'frame' | 'concrete';

type GovernanceEvaluation = {
  tier: string;
  margin_floor: number;
  yellow_threshold: number;
  max_discount_pct: number;
  discount_approval_required: boolean;
  margin_status: 'green' | 'yellow' | 'red';
  requires_approval: boolean;
  reasons: string[];
};

type OpeningPricingInput = {
  productId: string;
  width: number;
  height: number;
  floorLevel: string | number;
  glassOptionId?: string | null;
  frameColorId?: string | null;
  complexityIds?: string[];
  zipCode?: string | null;
  wallType?: string | null;
  openingCount?: number;
  quoteTotal?: number | null;
  drivewayDiscountPct?: number;
  requestedSellPrice?: number | null;
};

export type OfflineOpeningPricing = {
  pricing_engine_version: string;
  total_cost: number;
  sell_price: number;
  baseline_sell_price: number;
  discount_pct: number;
  margin_pct: number;
  margin_dollars: number;
  markup_pct: number;
  margin_status: 'green' | 'yellow' | 'red';
  margin_floor: number;
  requires_approval: boolean;
  governance: GovernanceEvaluation;
  breakdown: {
    base_cost: number;
    size_cost: number;
    size_method: string;
    sqft: number;
    floor_labor: number;
    glass_adder: number;
    frame_adder: number;
    complexity_adder: number;
    subtotal: number;
    territory_multiplier: number;
    subtotal_after_territory: number;
    global_multiplier: number;
    total_cost_pre_consumables: number;
    consumables_cost: number;
    consumables_breakdown: Array<{ name: string; unit_cost: number }>;
    total_cost: number;
    default_markup: number;
  };
  bounds: PriceBounds;
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPct(value: number): number {
  return Math.round(value * 10) / 10;
}

function safeNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function normalizeWallType(value?: string | null): CanonicalWallType {
  const raw = (value || '').trim().toLowerCase();
  if (raw === 'frame') {
    return 'frame';
  }
  if (raw === 'concrete' || raw === 'masonry') {
    return 'concrete';
  }
  return 'cbs';
}

function clamp(value: number, minValue?: number | null, maxValue?: number | null): number {
  let next = value;
  if (minValue !== undefined && minValue !== null && Number.isFinite(minValue) && next < minValue) {
    next = minValue;
  }
  if (maxValue !== undefined && maxValue !== null && Number.isFinite(maxValue) && next > maxValue) {
    next = maxValue;
  }
  return next;
}

function computeMarginStatus(
  marginPct: number,
  marginFloor: number,
  yellowThreshold: number
): 'green' | 'yellow' | 'red' {
  if (marginPct >= marginFloor + yellowThreshold) {
    return 'green';
  }
  if (marginPct >= marginFloor) {
    return 'yellow';
  }
  return 'red';
}

function computeSellPrice(
  totalCost: number,
  defaultMarkup: number,
  drivewayDiscountPct = 0,
  requestedSellPrice?: number | null
) {
  const baselineSellPrice = roundMoney(totalCost * defaultMarkup);
  let nextDiscountPct = Math.max(0, Math.min(90, safeNumber(drivewayDiscountPct, 0)));
  let sellPrice = baselineSellPrice;

  if (requestedSellPrice !== undefined && requestedSellPrice !== null) {
    sellPrice = roundMoney(Math.max(0.01, safeNumber(requestedSellPrice, baselineSellPrice)));
    if (baselineSellPrice > 0) {
      nextDiscountPct = roundMoney(Math.max(0, (1 - sellPrice / baselineSellPrice) * 100));
    }
  } else {
    sellPrice = roundMoney(
      Math.max(0.01, baselineSellPrice * (1 - nextDiscountPct / 100))
    );
  }

  const marginDollars = roundMoney(sellPrice - totalCost);
  const marginPct = sellPrice > 0 ? roundPct((marginDollars / sellPrice) * 100) : 0;
  const markupPct = totalCost > 0 ? roundPct((marginDollars / totalCost) * 100) : 0;

  return {
    sell_price: sellPrice,
    baseline_sell_price: baselineSellPrice,
    discount_pct: nextDiscountPct,
    margin_pct: marginPct,
    margin_dollars: marginDollars,
    markup_pct: markupPct,
  };
}

function applyGovernanceRules(
  marginPct: number,
  discountPct: number,
  governance: {
    margin_floor?: number;
    yellow_threshold?: number;
    max_discount_pct?: number;
    discount_approval_required?: boolean;
    tier?: string;
  }
): GovernanceEvaluation {
  const marginFloor = safeNumber(governance.margin_floor, 30);
  const yellowThreshold = safeNumber(governance.yellow_threshold, 3);
  const maxDiscountPct = safeNumber(governance.max_discount_pct, 5);
  const discountApprovalRequired = Boolean(
    governance.discount_approval_required ?? true
  );

  const reasons: string[] = [];
  if (discountApprovalRequired && marginPct < marginFloor) {
    reasons.push('margin_below_floor');
  }
  if (discountPct > maxDiscountPct) {
    reasons.push('discount_above_threshold');
  }

  return {
    tier: governance.tier || 'standard',
    margin_floor: marginFloor,
    yellow_threshold: yellowThreshold,
    max_discount_pct: maxDiscountPct,
    discount_approval_required: discountApprovalRequired,
    margin_status: computeMarginStatus(marginPct, marginFloor, yellowThreshold),
    requires_approval: reasons.length > 0,
    reasons,
  };
}

function findProduct(bundle: MobileBundle, productId: string): Product | null {
  return bundle.products.find((product) => product.id === productId) || null;
}

function getFloorLabor(bundle: MobileBundle, floorLevel: string | number): number {
  const floorKey = String(floorLevel);
  const row = bundle.floor_labor?.find(
    (item) => String(item.floor_level) === floorKey
  );
  return safeNumber(row?.labor_adder, 0);
}

function getTerritoryMultiplier(bundle: MobileBundle, zipCode?: string | null): number {
  if (!zipCode) {
    return 1;
  }

  const normalized = String(zipCode).trim().slice(0, 5);
  const row = bundle.territory_multipliers?.find((item) => {
    const candidate = String(item.zip_code || item.territory || '').trim().slice(0, 5);
    return candidate === normalized;
  });

  return safeNumber(row?.multiplier, 1);
}

function getConsumables(
  bundle: MobileBundle,
  wallType: string,
  openingCount: number
): { total: number; breakdown: Array<{ name: string; unit_cost: number }> } {
  const applicable =
    bundle.consumables?.filter((item) => {
      const isActive = item.active === undefined || Boolean(item.active);
      if (!isActive) {
        return false;
      }
      const wallFilter = (item.wall_type_filter || '').trim();
      if (wallFilter && wallFilter !== wallType) {
        return false;
      }
      const minOpenings = safeNumber(item.min_openings, 0);
      return openingCount >= minOpenings;
    }) || [];

  return {
    total: roundMoney(
      applicable.reduce((sum, item) => sum + safeNumber(item.unit_cost, 0), 0)
    ),
    breakdown: applicable.map((item) => ({
      name: item.name,
      unit_cost: roundMoney(safeNumber(item.unit_cost, 0)),
    })),
  };
}

function getSizePointPrice(
  bundle: MobileBundle,
  productId: string,
  width: number,
  height: number
): { price: number; method: string } | null {
  const rows =
    bundle.product_price_points?.filter(
      (row) => row.product_id === productId && (row.active === undefined || Boolean(row.active))
    ) || [];

  if (!rows.length) {
    return null;
  }

  const exact = rows.find(
    (row) =>
      Math.abs(safeNumber(row.width, 0) - width) < 0.01 &&
      Math.abs(safeNumber(row.height, 0) - height) < 0.01
  );
  if (exact) {
    return { price: roundMoney(safeNumber(exact.price, 0)), method: 'exact' };
  }

  let nearest = rows[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const distance = Math.sqrt(
      (safeNumber(row.width, 0) - width) ** 2 +
        (safeNumber(row.height, 0) - height) ** 2
    );
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = row;
    }
  }

  return { price: roundMoney(safeNumber(nearest.price, 0)), method: 'nearest' };
}

function getEffectiveMaxDiscountPct(bundle: MobileBundle, quoteTotal?: number | null): number {
  const baseMaxDiscount = safeNumber(bundle.governance?.max_discount_pct, 5);
  if (quoteTotal === undefined || quoteTotal === null) {
    return baseMaxDiscount;
  }

  const matchingTier =
    bundle.discount_tiers
      ?.filter((tier) => tier.active === undefined || Boolean(tier.active))
      .filter((tier) => {
        const min = safeNumber(tier.min_job_total, 0);
        const max = tier.max_job_total == null ? null : safeNumber(tier.max_job_total, 0);
        return quoteTotal >= min && (max == null || quoteTotal <= max);
      })
      .sort((a, b) => safeNumber(b.min_job_total, 0) - safeNumber(a.min_job_total, 0))[0] || null;

  return matchingTier
    ? safeNumber(matchingTier.max_discount_pct, baseMaxDiscount)
    : baseMaxDiscount;
}

export function calculateOpeningPricing(
  bundle: MobileBundle | null,
  input: OpeningPricingInput
): OfflineOpeningPricing | null {
  if (!bundle) {
    return null;
  }

  const product = findProduct(bundle, input.productId);
  if (!product) {
    return null;
  }

  const normalizedWidth = clamp(
    safeNumber(input.width, 0),
    product.min_width ?? null,
    product.max_width ?? null
  );
  const normalizedHeight = clamp(
    safeNumber(input.height, 0),
    product.min_height ?? null,
    product.max_height ?? null
  );
  const sqft = (normalizedWidth * normalizedHeight) / 144;

  const baseCost = roundMoney(safeNumber(product.base_cost, 0));
  let sizeCost = roundMoney(sqft * safeNumber(product.size_multiplier_per_sqft, 0));
  let sizeMethod = 'formula';
  const sizePoint = getSizePointPrice(bundle, product.id, normalizedWidth, normalizedHeight);
  if (sizePoint) {
    sizeCost = roundMoney(sizePoint.price - baseCost);
    sizeMethod = sizePoint.method;
  }

  const floorLabor = roundMoney(getFloorLabor(bundle, input.floorLevel));
  const glassAdder = roundMoney(
    safeNumber(
      bundle.glass_options.find((item) => item.id === input.glassOptionId)?.cost_adder,
      0
    )
  );
  const frameAdder = roundMoney(
    safeNumber(
      bundle.frame_colors.find((item) => item.id === input.frameColorId)?.cost_adder,
      0
    )
  );
  const complexityAdder = roundMoney(
    (input.complexityIds || []).reduce((sum, id) => {
      const row = bundle.complexity_items?.find((item) => item.id === id);
      return sum + safeNumber(row?.cost, 0);
    }, 0)
  );
  const territoryMultiplier = safeNumber(
    getTerritoryMultiplier(bundle, input.zipCode),
    1
  );
  const globalMultiplier = safeNumber(bundle.global_settings?.global_multiplier, 1);
  const wallType = normalizeWallType(input.wallType);
  const openingCount = Math.max(1, safeNumber(input.openingCount, 1));
  const consumables = getConsumables(bundle, wallType, openingCount);
  const defaultMarkup = safeNumber(bundle.global_settings?.default_markup, 1.75);

  const sizedMaterialCost = roundMoney(baseCost + sizeCost);
  const subtotal = roundMoney(
    sizedMaterialCost + floorLabor + glassAdder + frameAdder + complexityAdder
  );
  const subtotalAfterTerritory = roundMoney(subtotal * territoryMultiplier);
  const totalCostPreConsumables = roundMoney(subtotalAfterTerritory * globalMultiplier);
  const totalCost = roundMoney(totalCostPreConsumables + consumables.total);

  const sell = computeSellPrice(
    totalCost,
    defaultMarkup,
    input.drivewayDiscountPct,
    input.requestedSellPrice
  );

  const quoteTotal =
    input.quoteTotal === undefined || input.quoteTotal === null
      ? sell.sell_price
      : safeNumber(input.quoteTotal, sell.sell_price);
  const effectiveMaxDiscountPct = getEffectiveMaxDiscountPct(bundle, quoteTotal);
  const governance = applyGovernanceRules(sell.margin_pct, sell.discount_pct, {
    ...bundle.governance,
    max_discount_pct: effectiveMaxDiscountPct,
  });

  const marginFloor = safeNumber(governance.margin_floor, 30);
  const floorByMargin =
    marginFloor >= 100
      ? sell.baseline_sell_price
      : totalCost > 0
      ? roundMoney(totalCost / (1 - marginFloor / 100))
      : 0;
  const floorByDiscount =
    sell.baseline_sell_price > 0
      ? roundMoney(sell.baseline_sell_price * (1 - effectiveMaxDiscountPct / 100))
      : 0;
  const floorSellPrice = Math.max(floorByMargin, floorByDiscount);
  const minSellPrice = Math.max(floorByDiscount, floorSellPrice);

  return {
    pricing_engine_version: OFFLINE_PRICING_ENGINE_VERSION,
    total_cost: totalCost,
    sell_price: sell.sell_price,
    baseline_sell_price: sell.baseline_sell_price,
    discount_pct: sell.discount_pct,
    margin_pct: sell.margin_pct,
    margin_dollars: sell.margin_dollars,
    markup_pct: sell.markup_pct,
    margin_status: governance.margin_status,
    margin_floor: governance.margin_floor,
    requires_approval: governance.requires_approval,
    governance,
    breakdown: {
      base_cost: baseCost,
      size_cost: sizeCost,
      size_method: sizeMethod,
      sqft: roundMoney(sqft),
      floor_labor: floorLabor,
      glass_adder: glassAdder,
      frame_adder: frameAdder,
      complexity_adder: complexityAdder,
      subtotal,
      territory_multiplier: territoryMultiplier,
      subtotal_after_territory: subtotalAfterTerritory,
      global_multiplier: globalMultiplier,
      total_cost_pre_consumables: totalCostPreConsumables,
      consumables_cost: consumables.total,
      consumables_breakdown: consumables.breakdown,
      total_cost: totalCost,
      default_markup: defaultMarkup,
    },
    bounds: {
      opening_id: '',
      baseline_sell_price: sell.baseline_sell_price,
      floor_sell_price: roundMoney(floorSellPrice),
      min_sell_price: roundMoney(minSellPrice),
      max_discount_pct: roundMoney(effectiveMaxDiscountPct),
      suggested_sell_price: roundMoney(Math.max(minSellPrice, sell.baseline_sell_price)),
    },
  };
}

export function buildLocalPriceBounds(
  openingId: string,
  pricing: OfflineOpeningPricing | null
): PriceBounds | null {
  if (!pricing) {
    return null;
  }

  return {
    ...pricing.bounds,
    opening_id: openingId,
  };
}
