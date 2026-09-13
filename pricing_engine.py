"""
pricing_engine.py — WindowCalc Alpha 9.4e
==========================================
Pure-Python pricing calculation module. Zero database dependency.

All functions take pre-fetched data as plain dicts / scalars and return
structured dicts. This makes the module:
  - Unit-testable without a database
  - Importable by server.py (thin DB wrapper calls these)
  - Portable to the React Native offline bundle (via pyodide or JS port)
  - Ready for extraction to a standalone pricing microservice

CONTRACT: The function signatures here are the stable API contract.
Changes must be versioned. server.py and any React Native pricing logic
must agree on VERSION.
"""

from __future__ import annotations

VERSION = "9.4e-1"  # pricing engine semantic version; bump on any formula change

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def safe_float(value, default: float = 0.0) -> float:
    """Coerce value to float with a safe fallback."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def safe_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Margin & governance helpers
# ---------------------------------------------------------------------------

def compute_margin_status(margin_pct: float, margin_floor: float, yellow_threshold: float) -> str:
    """Classify a margin percentage as 'green', 'yellow', or 'red'.

    Args:
        margin_pct:       Gross margin % (e.g. 42.5)
        margin_floor:     Minimum acceptable margin % before requiring approval
        yellow_threshold: Band above the floor that earns a 'yellow' warning

    Returns:
        'green' | 'yellow' | 'red'
    """
    if margin_pct >= margin_floor + yellow_threshold:
        return "green"
    elif margin_pct >= margin_floor:
        return "yellow"
    else:
        return "red"


def apply_governance_rules(
    margin_pct: float,
    discount_pct: float,
    governance: dict,
) -> dict:
    """Evaluate whether a priced opening requires manager approval.

    Args:
        margin_pct:   Computed gross margin % for the opening
        discount_pct: Applied discount % off baseline price
        governance:   Governance dict with keys:
                        margin_floor, yellow_threshold, max_discount_pct,
                        discount_approval_required, tier

    Returns:
        {
          tier: str,
          margin_floor: float,
          yellow_threshold: float,
          max_discount_pct: float,
          discount_approval_required: bool,
          margin_status: 'green'|'yellow'|'red',
          requires_approval: bool,
          reasons: list[str],
        }
    """
    floor = safe_float(governance.get("margin_floor"), 30.0)
    yellow = safe_float(governance.get("yellow_threshold"), 3.0)
    max_discount = safe_float(governance.get("max_discount_pct"), 5.0)
    approval_required = bool(governance.get("discount_approval_required", True))
    tier = governance.get("tier", "standard")

    reasons: list[str] = []
    if approval_required and margin_pct < floor:
        reasons.append("margin_below_floor")
    if discount_pct > max_discount:
        reasons.append("discount_above_threshold")

    return {
        "tier": tier,
        "margin_floor": floor,
        "yellow_threshold": yellow,
        "max_discount_pct": max_discount,
        "discount_approval_required": approval_required,
        "margin_status": compute_margin_status(margin_pct, floor, yellow),
        "requires_approval": len(reasons) > 0,
        "reasons": reasons,
    }


# ---------------------------------------------------------------------------
# Sell price & margin calculation
# ---------------------------------------------------------------------------

def compute_sell_price(
    total_cost: float,
    default_markup: float,
    driveway_discount_pct: float = 0.0,
    requested_sell_price: float | None = None,
) -> dict:
    """Compute sell price, margins, and effective discount.

    If requested_sell_price is provided, it is used as the sell price and
    the effective discount is back-calculated. Otherwise, sell price is
    derived from total_cost * default_markup * (1 - discount).

    Args:
        total_cost:            Fully loaded cost (material + labor + consumables)
        default_markup:        Markup ratio, e.g. 1.75 = 75% markup
        driveway_discount_pct: Discount off baseline, 0–90 range
        requested_sell_price:  If set, overrides discount-based calculation

    Returns:
        {
          sell_price: float,
          baseline_sell_price: float,
          discount_pct: float,
          margin_pct: float,
          margin_dollars: float,
          markup_pct: float,
        }
    """
    baseline_sell_price = round(total_cost * default_markup, 2)
    driveway_discount_pct = max(0.0, min(90.0, safe_float(driveway_discount_pct, 0.0)))

    if requested_sell_price is not None:
        sell_price = round(max(0.01, safe_float(requested_sell_price, baseline_sell_price)), 2)
        if baseline_sell_price > 0:
            driveway_discount_pct = round(
                max(0.0, (1 - sell_price / baseline_sell_price) * 100), 2
            )
    else:
        sell_price = round(max(0.01, baseline_sell_price * (1 - driveway_discount_pct / 100.0)), 2)

    margin_dollars = round(sell_price - total_cost, 2)
    margin_pct = round((margin_dollars / sell_price) * 100, 1) if sell_price > 0 else 0.0
    markup_pct = round((margin_dollars / total_cost) * 100, 1) if total_cost > 0 else 0.0

    return {
        "sell_price": sell_price,
        "baseline_sell_price": baseline_sell_price,
        "discount_pct": driveway_discount_pct,
        "margin_pct": margin_pct,
        "margin_dollars": margin_dollars,
        "markup_pct": markup_pct,
    }


# ---------------------------------------------------------------------------
# Opening cost components
# ---------------------------------------------------------------------------

def compute_opening_cost_components(
    *,
    base_cost: float,
    size_cost: float,
    size_method: str,
    sqft: float,
    floor_labor: float,
    glass_adder: float,
    frame_adder: float,
    complexity_cost: float,
    territory_mult: float,
    global_mult: float,
    consumables_cost: float,
    consumables_breakdown: list,
) -> dict:
    """Compute the fully loaded unit cost for one opening.

    All adders and multipliers must be pre-fetched from the database before
    calling this function. This is the canonical cost formula for WindowCalc.

    Formula:
        sized_material_cost = base_cost + size_cost
        subtotal            = sized_material_cost + floor_labor + glass_adder + frame_adder + complexity_cost
        after_territory     = subtotal × territory_mult
        pre_consumables     = after_territory × global_mult
        total_cost          = pre_consumables + consumables_cost

    Returns:
        {
          base_cost, size_cost, size_method, sqft,
          floor_labor, glass_adder, frame_adder, complexity_cost,
          subtotal, territory_multiplier, subtotal_after_territory,
          global_multiplier, total_cost_pre_consumables,
          consumables_cost, consumables_breakdown,
          total_cost,
        }
    """
    sized_material_cost = round(base_cost + size_cost, 2)
    subtotal = round(sized_material_cost + floor_labor + glass_adder + frame_adder + complexity_cost, 2)
    subtotal_after_territory = round(subtotal * territory_mult, 2)
    total_cost_pre_consumables = round(subtotal_after_territory * global_mult, 2)
    total_cost = round(total_cost_pre_consumables + consumables_cost, 2)

    return {
        "base_cost": round(base_cost, 2),
        "size_cost": round(size_cost, 2),
        "size_method": size_method,
        "sqft": round(sqft, 2),
        "floor_labor": round(floor_labor, 2),
        "glass_adder": round(glass_adder, 2),
        "frame_adder": round(frame_adder, 2),
        "complexity_adder": round(complexity_cost, 2),
        "subtotal": subtotal,
        "territory_multiplier": territory_mult,
        "subtotal_after_territory": subtotal_after_territory,
        "global_multiplier": global_mult,
        "total_cost_pre_consumables": total_cost_pre_consumables,
        "consumables_cost": round(consumables_cost, 2),
        "consumables_breakdown": consumables_breakdown,
        "total_cost": total_cost,
    }


# ---------------------------------------------------------------------------
# Clamp dimensions to product min/max
# ---------------------------------------------------------------------------

def clamp_dimensions(
    width: float,
    height: float,
    min_width: float | None,
    max_width: float | None,
    min_height: float | None,
    max_height: float | None,
) -> tuple[float, float]:
    """Clamp width and height to the product's allowed dimension range."""
    if min_width is not None and width < min_width:
        width = min_width
    if max_width is not None and width > max_width:
        width = max_width
    if min_height is not None and height < min_height:
        height = min_height
    if max_height is not None and height > max_height:
        height = max_height
    return width, height


def compute_sqft(width: float, height: float) -> float:
    """Compute square footage from width × height in inches."""
    return (width * height) / 144.0


# ---------------------------------------------------------------------------
# Assembly pricing helper
# ---------------------------------------------------------------------------

def compute_assembly_totals(
    *,
    panel_costs: list[float],
    panel_sells: list[float],
    mull_count: int,
    mull_bar_cost: float,
    needs_reinforcement: bool,
    mull_reinforcement_cost: float,
    assembly_labor_per_mull: float,
    default_markup: float,
) -> dict:
    """Compute totals for a multipart assembly opening.

    Args:
        panel_costs:             List of total_cost per panel
        panel_sells:             List of sell_price per panel (pre-assembly)
        mull_count:              Number of mullions (panel_count - 1)
        mull_bar_cost:           Cost per mullion bar (from global settings)
        needs_reinforcement:     True if any panel > 30 sqft
        mull_reinforcement_cost: Extra cost when reinforcement is required
        assembly_labor_per_mull: Labor cost per mullion
        default_markup:          Markup ratio, e.g. 1.75

    Returns:
        {
          total_panel_cost, mull_count, mull_bar_total,
          needs_reinforcement, reinforcement_cost,
          assembly_labor_total, total_cost,
          sell_price, margin_pct, margin_dollars, markup_pct,
        }
    """
    total_panel_cost = sum(panel_costs)
    mull_bar_total = round(mull_bar_cost * mull_count, 2)
    reinforcement_cost = round(mull_reinforcement_cost, 2) if needs_reinforcement else 0.0
    assembly_labor_total = round(assembly_labor_per_mull * mull_count, 2)
    total_cost = round(total_panel_cost + mull_bar_total + reinforcement_cost + assembly_labor_total, 2)

    sell_price = round(total_cost * default_markup, 2)
    margin_dollars = round(sell_price - total_cost, 2)
    margin_pct = round((margin_dollars / sell_price) * 100, 1) if sell_price > 0 else 0.0
    markup_pct = round((margin_dollars / total_cost) * 100, 1) if total_cost > 0 else 0.0

    return {
        "total_panel_cost": round(total_panel_cost, 2),
        "mull_count": mull_count,
        "mull_bar_total": mull_bar_total,
        "needs_reinforcement": needs_reinforcement,
        "reinforcement_cost": reinforcement_cost,
        "assembly_labor_total": assembly_labor_total,
        "total_cost": total_cost,
        "sell_price": sell_price,
        "margin_pct": margin_pct,
        "margin_dollars": margin_dollars,
        "markup_pct": markup_pct,
    }


# ---------------------------------------------------------------------------
# Quote-level totals
# ---------------------------------------------------------------------------

def compute_quote_totals(openings: list[dict]) -> dict:
    """Compute rolled-up totals for all openings in a quote.

    Args:
        openings: List of opening dicts, each with sell_price, total_cost, discount_pct

    Returns:
        {
          opening_count, total_price, total_cost, margin_dollars,
          margin_pct, average_discount_pct
        }
    """
    total_price = round(sum(safe_float(o.get("sell_price"), 0) for o in openings), 2)
    total_cost = round(sum(safe_float(o.get("total_cost"), 0) for o in openings), 2)
    margin_dollars = round(total_price - total_cost, 2)
    margin_pct = round((margin_dollars / total_price) * 100, 1) if total_price > 0 else 0.0
    avg_discount = round(
        sum(safe_float(o.get("discount_pct"), 0) for o in openings) / len(openings), 2
    ) if openings else 0.0

    return {
        "opening_count": len(openings),
        "total_price": total_price,
        "total_cost": total_cost,
        "margin_dollars": margin_dollars,
        "margin_pct": margin_pct,
        "average_discount_pct": avg_discount,
    }
