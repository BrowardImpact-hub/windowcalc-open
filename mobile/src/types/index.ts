export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  tier: string;
  permissions: string[];
  tenant_id: string;
}

export interface Quote {
  id: string;
  customer_name: string;
  customer_phone?: string | null;
  customer_email?: string | null;
  job_address: string;
  job_zip?: string | null;
  notes?: string | null;
  status: 'draft' | 'submitted' | 'pending_approval' | 'approved' | 'ordered' | 'completed' | 'denied';
  total_price: number;
  total_cost: number;
  margin_pct: number;
  opening_count: number;
  maps_verified: boolean;
  property_verified: boolean;
  created_at?: string;
  updated_at?: string;
  rep_name?: string;
  rep_tier?: string;
  dirty?: boolean;
  local_only?: boolean;
  sync_state?: 'local' | 'pending' | 'synced';
  openings?: Opening[];
}

export interface Opening {
  id: string;
  quote_id: string;
  opening_type: string;
  opening_mode: string;
  total_width: number;
  total_height: number;
  floor_level: string | number;
  product_id: string;
  product_name: string;
  glass_option_id: string;
  glass_name: string;
  frame_color_id: string;
  frame_name: string;
  sell_price: number;
  total_cost: number;
  discount_pct?: number;
  baseline_sell_price?: number;
  margin_pct: number;
  margin_dollars?: number;
  noa_status: string;
  dp_status: string;
  wall_type?: string;
  opening_number?: number;
  created_at?: string;
  updated_at?: string;
  dirty?: boolean;
  local_only?: boolean;
  sync_state?: 'local' | 'pending' | 'synced';
}

export interface Product {
  id: string;
  name: string;
  base_cost: number;
  model_number?: string;
  product_line?: string;
  manufacturer?: string;
  type?: string;
  size_multiplier_per_sqft?: number;
  min_width?: number | null;
  max_width?: number | null;
  min_height?: number | null;
  max_height?: number | null;
  active: boolean | number;
}

export interface GlassOption {
  id: string;
  name: string;
  cost_adder: number;
}

export interface FrameColor {
  id: string;
  name: string;
  cost_adder: number;
}

export interface Governance {
  margin_floor: number;
  yellow_threshold: number;
  max_discount_pct: number;
  discount_approval_required: boolean;
}

export interface GlobalSettings {
  [key: string]: unknown;
}

export interface ComplexityItem {
  id: string;
  name: string;
  cost: number;
}

export interface FloorLaborRow {
  floor_level: string | number;
  labor_adder: number;
}

export interface TerritoryMultiplier {
  zip_code?: string;
  territory?: string;
  multiplier: number;
}

export interface Consumable {
  id: string;
  name: string;
  unit_cost: number;
  unit?: string;
  wall_type_filter?: string | null;
  min_openings?: number | null;
  active?: boolean | number;
}

export interface ProductPricePoint {
  id?: string;
  product_id: string;
  width: number;
  height: number;
  price: number;
  active?: boolean | number;
}

export interface DiscountTier {
  id?: string;
  label: string;
  min_job_total: number;
  max_job_total?: number | null;
  max_discount_pct: number;
  active?: boolean | number;
}

export interface FeatureFlags {
  [key: string]: boolean;
}

export interface DPRating {
  id: string;
  product_id: string;
  product_name?: string;
  width?: number;
  height?: number;
  design_pressure?: number;
}

export interface MobileBundle {
  rep: User;
  quotes: Quote[];
  products: Product[];
  glass_options: GlassOption[];
  frame_colors: FrameColor[];
  complexity_items?: ComplexityItem[];
  floor_labor?: FloorLaborRow[];
  territory_multipliers?: TerritoryMultiplier[];
  consumables?: Consumable[];
  product_price_points?: ProductPricePoint[];
  discount_tiers?: DiscountTier[];
  governance: Governance;
  global_settings: GlobalSettings;
  feature_flags?: FeatureFlags;
  dp_ratings?: DPRating[];
  pricing_engine_version?: string;
  quote_scope?: 'rep' | 'tenant';
  app_version?: string;
  schema_version?: string | number;
  bundled_at: string;
}

export interface SyncEvent {
  client_event_id: string;
  type: string;
  payload: Record<string, unknown>;
  occurred_at: string;
}

export interface PriceBounds {
  opening_id: string;
  floor_sell_price: number;
  baseline_sell_price: number;
  suggested_sell_price?: number;
  min_sell_price?: number;
  max_discount_pct?: number;
  opening_number?: number;
}

export interface QuotePriceBoundsResponse {
  quote_id: string;
  quote_total: number;
  discount_tier?: {
    label: string;
    max_discount_pct: number;
  } | null;
  governance_max_discount_pct: number;
  effective_max_discount_pct: number;
  openings: PriceBounds[];
}

export interface AuthSession {
  token: string;
  expires_at: string;
  user: User;
}

export interface DeviceInfo {
  device_id: string;
  device_name?: string;
  platform: 'ios' | 'android';
}

export interface ApiError {
  status: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface FlushResult {
  processed: number;
  skipped: number;
  errors: Array<{ event_id: string; error: string }>;
  server_time?: string;
}

export interface SyncQueueRow {
  id: string;
  event_type: string;
  payload_json: string;
  client_event_id: string;
  queued_at: string;
  attempts: number;
  entity_type?: 'quote' | 'opening' | null;
  entity_id?: string | null;
  last_error?: string | null;
}

export interface ThemeColors {
  primary: string;
  background: string;
  card: string;
  elevated: string;
  border: string;
  textPrimary: string;
  textMuted: string;
  green: string;
  red: string;
  amber: string;
  teal: string;
}
