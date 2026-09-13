import { create } from 'zustand';
import * as SQLite from 'expo-sqlite';
import { Opening, Quote } from '@/types';
import { generateUUID } from '@/utils/uuid';

type CreateQuoteDraftInput = {
  customer_name: string;
  customer_phone?: string;
  job_address: string;
  notes?: string;
};

type CreateOpeningDraftInput = Omit<Opening, 'id'> & {
  id?: string;
};

type BatchOpeningUpdateInput = {
  openingId: string;
  patch: Partial<Opening>;
};

interface DraftStore {
  quotes: Quote[];
  isReady: boolean;
  isLoading: boolean;
  error: string | null;

  initialize: (db: SQLite.SQLiteDatabase) => Promise<void>;
  loadDrafts: () => Promise<void>;
  getQuote: (id: string) => Quote | undefined;
  createQuoteDraft: (input: CreateQuoteDraftInput) => Promise<Quote>;
  cacheBundleQuotes: (quotes: Quote[]) => Promise<void>;
  addOpeningDraft: (quoteId: string, opening: CreateOpeningDraftInput) => Promise<Opening>;
  batchUpdateOpenings: (updates: BatchOpeningUpdateInput[]) => Promise<Quote | null>;
  updateOpeningDraft: (openingId: string, patch: Partial<Opening>) => Promise<Quote | null>;
}

let dbInstance: SQLite.SQLiteDatabase | null = null;

async function runColumnMigration(db: SQLite.SQLiteDatabase, sql: string): Promise<void> {
  try {
    await db.execAsync(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (!message.includes('duplicate column name')) {
      console.warn('Draft store migration warning:', error);
    }
  }
}

function deriveSyncState(localOnly: boolean, dirty: boolean): Quote['sync_state'] {
  if (localOnly) return 'local';
  if (dirty) return 'pending';
  return 'synced';
}

function mapOpeningRow(row: Record<string, unknown>): Opening {
  const localOnly = Boolean(row.local_only);
  const dirty = Boolean(row.dirty);
  return {
    id: String(row.id),
    quote_id: String(row.quote_id),
    opening_type: String(row.opening_type || 'single_hung'),
    opening_mode: String(row.opening_mode || 'standard'),
    total_width: Number(row.total_width || 0),
    total_height: Number(row.total_height || 0),
    floor_level: String(row.floor_level || '1'),
    product_id: String(row.product_id || ''),
    product_name: String(row.product_name || ''),
    glass_option_id: String(row.glass_option_id || ''),
    glass_name: String(row.glass_name || ''),
    frame_color_id: String(row.frame_color_id || ''),
    frame_name: String(row.frame_name || ''),
    sell_price: Number(row.sell_price || 0),
    total_cost: Number(row.total_cost || 0),
    discount_pct: Number(row.discount_pct || 0),
    baseline_sell_price: Number(
      row.baseline_sell_price ?? row.sell_price ?? 0
    ),
    margin_pct: Number(row.margin_pct || 0),
    margin_dollars: Number(row.margin_dollars || 0),
    noa_status: String(row.noa_status || 'pending'),
    dp_status: String(row.dp_status || 'pending'),
    wall_type: row.wall_type ? String(row.wall_type) : undefined,
    opening_number: row.opening_number ? Number(row.opening_number) : undefined,
    created_at: row.created_at ? String(row.created_at) : undefined,
    updated_at: row.updated_at ? String(row.updated_at) : undefined,
    local_only: localOnly,
    dirty,
    sync_state: deriveSyncState(localOnly, dirty),
  };
}

function mapQuoteRow(
  row: Record<string, unknown>,
  openings: Opening[]
): Quote {
  const localOnly = Boolean(row.local_only);
  const dirty = Boolean(row.dirty);

  return {
    id: String(row.id),
    customer_name: String(row.customer_name || ''),
    customer_phone: row.customer_phone ? String(row.customer_phone) : null,
    customer_email: row.customer_email ? String(row.customer_email) : null,
    job_address: String(row.job_address || ''),
    job_zip: row.job_zip ? String(row.job_zip) : null,
    notes: row.notes ? String(row.notes) : null,
    status: String(row.status || 'draft') as Quote['status'],
    total_price: Number(row.total_price || 0),
    total_cost: Number(row.total_cost || 0),
    margin_pct: Number(row.margin_pct || 0),
    opening_count: Number(row.opening_count || openings.length || 0),
    maps_verified: Boolean(row.maps_verified),
    property_verified: Boolean(row.property_verified),
    created_at: row.created_at ? String(row.created_at) : undefined,
    updated_at: row.updated_at ? String(row.updated_at) : undefined,
    dirty,
    local_only: localOnly,
    sync_state: deriveSyncState(localOnly, dirty),
    openings,
  };
}

async function hydrateQuotes(db: SQLite.SQLiteDatabase): Promise<Quote[]> {
  const quoteRows = await db.getAllAsync<Record<string, unknown>>(
    `
    SELECT *
    FROM local_quotes
    ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
  `
  );
  const openingRows = await db.getAllAsync<Record<string, unknown>>(
    `
    SELECT *
    FROM local_openings
    ORDER BY quote_id ASC, opening_number ASC, datetime(created_at) ASC
  `
  );

  const openingsByQuote = new Map<string, Opening[]>();
  for (const row of openingRows) {
    const opening = mapOpeningRow(row);
    const existing = openingsByQuote.get(opening.quote_id) || [];
    existing.push(opening);
    openingsByQuote.set(opening.quote_id, existing);
  }

  return quoteRows.map((quoteRow) =>
    mapQuoteRow(quoteRow, openingsByQuote.get(String(quoteRow.id)) || [])
  );
}

async function refreshState(
  db: SQLite.SQLiteDatabase,
  set: (partial: Partial<DraftStore>) => void
): Promise<void> {
  const quotes = await hydrateQuotes(db);
  set({
    quotes,
    isReady: true,
    isLoading: false,
    error: null,
  });
}

function buildQuoteId(): string {
  return `q-${generateUUID()}`;
}

function buildOpeningId(): string {
  return `op-${generateUUID()}`;
}

async function recalculateQuote(
  db: SQLite.SQLiteDatabase,
  quoteId: string
): Promise<void> {
  const totals = await db.getFirstAsync<{
    total_price: number;
    total_cost: number;
    opening_count: number;
    dirty_openings: number;
    local_only_openings: number;
  }>(
    `
    SELECT
      COALESCE(SUM(sell_price), 0) AS total_price,
      COALESCE(SUM(total_cost), 0) AS total_cost,
      COUNT(*) AS opening_count,
      COALESCE(SUM(CASE WHEN dirty = 1 THEN 1 ELSE 0 END), 0) AS dirty_openings,
      COALESCE(SUM(CASE WHEN local_only = 1 THEN 1 ELSE 0 END), 0) AS local_only_openings
    FROM local_openings
    WHERE quote_id = ?
  `,
    [quoteId]
  );

  const quoteRow = await db.getFirstAsync<{ dirty: number; local_only: number }>(
    `
    SELECT dirty, local_only
    FROM local_quotes
    WHERE id = ?
  `,
    [quoteId]
  );

  if (!quoteRow) {
    return;
  }

  const totalPrice = Number(totals?.total_price || 0);
  const totalCost = Number(totals?.total_cost || 0);
  const marginPct = totalPrice > 0 ? ((totalPrice - totalCost) / totalPrice) * 100 : 0;
  const quoteDirty = Boolean(quoteRow.dirty) || Number(totals?.dirty_openings || 0) > 0;
  const quoteLocalOnly = Boolean(quoteRow.local_only) || Number(totals?.local_only_openings || 0) > 0;

  await db.runAsync(
    `
    UPDATE local_quotes
    SET total_price = ?,
        total_cost = ?,
        margin_pct = ?,
        opening_count = ?,
        dirty = ?,
        local_only = ?,
        updated_at = ?
    WHERE id = ?
  `,
    [
      totalPrice,
      totalCost,
      marginPct,
      Number(totals?.opening_count || 0),
      quoteDirty ? 1 : 0,
      quoteLocalOnly ? 1 : 0,
      new Date().toISOString(),
      quoteId,
    ]
  );
}

async function applyOpeningPatch(
  db: SQLite.SQLiteDatabase,
  openingId: string,
  patch: Partial<Opening>,
  timestamp = new Date().toISOString()
): Promise<string> {
  const openingRow = await db.getFirstAsync<Record<string, unknown>>(
    `
    SELECT *
    FROM local_openings
    WHERE id = ?
  `,
    [openingId]
  );

  if (!openingRow) {
    throw new Error('Opening not found');
  }

  const nextSellPrice = Number(
    patch.sell_price !== undefined ? patch.sell_price : openingRow.sell_price
  );
  const nextTotalCost = Number(
    patch.total_cost !== undefined ? patch.total_cost : openingRow.total_cost
  );
  const nextDiscountPct = Number(
    patch.discount_pct !== undefined ? patch.discount_pct : openingRow.discount_pct || 0
  );
  const nextBaselineSellPrice = Number(
    patch.baseline_sell_price !== undefined
      ? patch.baseline_sell_price
      : (openingRow.baseline_sell_price ?? openingRow.sell_price ?? 0)
  );
  const nextMarginPct =
    nextSellPrice > 0
      ? Number(
          patch.margin_pct ??
            ((nextSellPrice - nextTotalCost) / nextSellPrice) * 100
        )
      : Number(patch.margin_pct || 0);
  const nextMarginDollars = Number(
    patch.margin_dollars ?? nextSellPrice - nextTotalCost
  );
  const quoteId = String(openingRow.quote_id);

  await db.runAsync(
    `
    UPDATE local_openings
    SET opening_type = ?,
        opening_mode = ?,
        total_width = ?,
        total_height = ?,
        floor_level = ?,
        product_id = ?,
        product_name = ?,
        glass_option_id = ?,
        glass_name = ?,
        frame_color_id = ?,
        frame_name = ?,
        wall_type = ?,
        sell_price = ?,
        total_cost = ?,
        discount_pct = ?,
        baseline_sell_price = ?,
        margin_pct = ?,
        margin_dollars = ?,
        noa_status = ?,
        dp_status = ?,
        dirty = 1,
        updated_at = ?
    WHERE id = ?
  `,
    [
      patch.opening_type || String(openingRow.opening_type || 'single_hung'),
      patch.opening_mode || String(openingRow.opening_mode || 'standard'),
      patch.total_width ?? Number(openingRow.total_width || 0),
      patch.total_height ?? Number(openingRow.total_height || 0),
      patch.floor_level !== undefined ? String(patch.floor_level) : String(openingRow.floor_level || '1'),
      patch.product_id || String(openingRow.product_id || ''),
      patch.product_name || String(openingRow.product_name || ''),
      patch.glass_option_id || String(openingRow.glass_option_id || ''),
      patch.glass_name || String(openingRow.glass_name || ''),
      patch.frame_color_id || String(openingRow.frame_color_id || ''),
      patch.frame_name || String(openingRow.frame_name || ''),
      patch.wall_type || (openingRow.wall_type ? String(openingRow.wall_type) : null),
      nextSellPrice,
      nextTotalCost,
      nextDiscountPct,
      nextBaselineSellPrice,
      nextMarginPct,
      nextMarginDollars,
      patch.noa_status || String(openingRow.noa_status || 'pending'),
      patch.dp_status || String(openingRow.dp_status || 'pending'),
      timestamp,
      openingId,
    ]
  );

  await db.runAsync(
    `
    UPDATE local_quotes
    SET dirty = 1,
        updated_at = ?
    WHERE id = ?
  `,
    [timestamp, quoteId]
  );

  return quoteId;
}

export const useDraftStore = create<DraftStore>((set, get) => ({
  quotes: [],
  isReady: false,
  isLoading: true,
  error: null,

  initialize: async (db: SQLite.SQLiteDatabase) => {
    dbInstance = db;

    try {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS local_quotes (
          id TEXT PRIMARY KEY,
          customer_name TEXT NOT NULL,
          customer_phone TEXT,
          customer_email TEXT,
          job_address TEXT,
          job_zip TEXT,
          notes TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          total_price REAL NOT NULL DEFAULT 0,
          total_cost REAL NOT NULL DEFAULT 0,
          margin_pct REAL NOT NULL DEFAULT 0,
          opening_count INTEGER NOT NULL DEFAULT 0,
          maps_verified INTEGER NOT NULL DEFAULT 0,
          property_verified INTEGER NOT NULL DEFAULT 0,
          dirty INTEGER NOT NULL DEFAULT 0,
          local_only INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS local_openings (
          id TEXT PRIMARY KEY,
          quote_id TEXT NOT NULL,
          opening_number INTEGER NOT NULL DEFAULT 1,
          opening_type TEXT NOT NULL,
          opening_mode TEXT NOT NULL,
          total_width REAL NOT NULL,
          total_height REAL NOT NULL,
          floor_level TEXT NOT NULL,
          product_id TEXT,
          product_name TEXT,
          glass_option_id TEXT,
          glass_name TEXT,
          frame_color_id TEXT,
          frame_name TEXT,
          wall_type TEXT,
          sell_price REAL NOT NULL DEFAULT 0,
          total_cost REAL NOT NULL DEFAULT 0,
          discount_pct REAL NOT NULL DEFAULT 0,
          baseline_sell_price REAL NOT NULL DEFAULT 0,
          margin_pct REAL NOT NULL DEFAULT 0,
          margin_dollars REAL NOT NULL DEFAULT 0,
          noa_status TEXT DEFAULT 'pending',
          dp_status TEXT DEFAULT 'pending',
          dirty INTEGER NOT NULL DEFAULT 0,
          local_only INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_local_openings_quote
          ON local_openings (quote_id, opening_number);
      `);

      await runColumnMigration(
        db,
        'ALTER TABLE local_openings ADD COLUMN discount_pct REAL NOT NULL DEFAULT 0'
      );
      await runColumnMigration(
        db,
        'ALTER TABLE local_openings ADD COLUMN baseline_sell_price REAL NOT NULL DEFAULT 0'
      );

      await get().loadDrafts();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to initialize draft store';
      set({
        error: message,
        isLoading: false,
      });
      throw error;
    }
  },

  loadDrafts: async () => {
    if (!dbInstance) {
      set({ quotes: [], isReady: true, isLoading: false });
      return;
    }
    await refreshState(dbInstance, set);
  },

  getQuote: (id: string) => get().quotes.find((quote) => quote.id === id),

  createQuoteDraft: async (input: CreateQuoteDraftInput) => {
    if (!dbInstance) {
      throw new Error('Draft store not initialized');
    }

    const quoteId = buildQuoteId();
    const now = new Date().toISOString();

    await dbInstance.runAsync(
      `
      INSERT INTO local_quotes (
        id,
        customer_name,
        customer_phone,
        job_address,
        notes,
        status,
        total_price,
        total_cost,
        margin_pct,
        opening_count,
        maps_verified,
        property_verified,
        dirty,
        local_only,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'draft', 0, 0, 0, 0, 0, 0, 1, 1, ?, ?)
    `,
      [
        quoteId,
        input.customer_name.trim(),
        input.customer_phone?.trim() || null,
        input.job_address.trim(),
        input.notes?.trim() || null,
        now,
        now,
      ]
    );

    await refreshState(dbInstance, set);

    const quote = get().getQuote(quoteId);
    if (!quote) {
      throw new Error('Quote draft was not created');
    }

    return quote;
  },

  cacheBundleQuotes: async (quotes: Quote[]) => {
    if (!dbInstance || quotes.length === 0) {
      return;
    }

    for (const quote of quotes) {
      const localMeta = await dbInstance.getFirstAsync<{ dirty: number }>(
        `
        SELECT dirty
        FROM local_quotes
        WHERE id = ?
      `,
        [quote.id]
      );

      if (localMeta && Boolean(localMeta.dirty)) {
        continue;
      }

      const quoteUpdatedAt = quote.updated_at || quote.created_at || new Date().toISOString();
      const quoteCreatedAt = quote.created_at || quote.updated_at || quoteUpdatedAt;

      await dbInstance.runAsync(
        `
        INSERT OR REPLACE INTO local_quotes (
          id,
          customer_name,
          customer_phone,
          customer_email,
          job_address,
          job_zip,
          notes,
          status,
          total_price,
          total_cost,
          margin_pct,
          opening_count,
          maps_verified,
          property_verified,
          dirty,
          local_only,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
      `,
        [
          quote.id,
          quote.customer_name,
          quote.customer_phone || null,
          quote.customer_email || null,
          quote.job_address,
          quote.job_zip || null,
          quote.notes || null,
          quote.status,
          quote.total_price || 0,
          quote.total_cost || 0,
          quote.margin_pct || 0,
          quote.opening_count || quote.openings?.length || 0,
          quote.maps_verified ? 1 : 0,
          quote.property_verified ? 1 : 0,
          quoteCreatedAt,
          quoteUpdatedAt,
        ]
      );

      await dbInstance.runAsync('DELETE FROM local_openings WHERE quote_id = ?', [quote.id]);

      for (const opening of quote.openings || []) {
        const openingUpdatedAt = opening.updated_at || opening.created_at || quoteUpdatedAt;
        const openingCreatedAt = opening.created_at || opening.updated_at || openingUpdatedAt;
        await dbInstance.runAsync(
          `
          INSERT OR REPLACE INTO local_openings (
            id,
            quote_id,
            opening_number,
            opening_type,
            opening_mode,
            total_width,
            total_height,
            floor_level,
            product_id,
            product_name,
            glass_option_id,
            glass_name,
            frame_color_id,
            frame_name,
            wall_type,
            sell_price,
            total_cost,
            discount_pct,
            baseline_sell_price,
            margin_pct,
            margin_dollars,
            noa_status,
            dp_status,
            dirty,
            local_only,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
        `,
          [
            opening.id,
            quote.id,
            opening.opening_number || 1,
            opening.opening_type,
            opening.opening_mode || 'standard',
            opening.total_width,
            opening.total_height,
            opening.floor_level,
            opening.product_id || null,
            opening.product_name || null,
            opening.glass_option_id || null,
            opening.glass_name || null,
            opening.frame_color_id || null,
            opening.frame_name || null,
            opening.wall_type || null,
            opening.sell_price || 0,
            opening.total_cost || 0,
            opening.discount_pct || 0,
            opening.baseline_sell_price || opening.sell_price || 0,
            opening.margin_pct || 0,
            opening.margin_dollars || 0,
            opening.noa_status || 'pending',
            opening.dp_status || 'pending',
            openingCreatedAt,
            openingUpdatedAt,
          ]
        );
      }
    }

    await refreshState(dbInstance, set);
  },

  addOpeningDraft: async (quoteId: string, opening: CreateOpeningDraftInput) => {
    if (!dbInstance) {
      throw new Error('Draft store not initialized');
    }

    const existingQuote = await dbInstance.getFirstAsync<{ id: string }>(
      'SELECT id FROM local_quotes WHERE id = ?',
      [quoteId]
    );
    if (!existingQuote) {
      throw new Error('Quote draft not found');
    }

    const nextNumberRow = await dbInstance.getFirstAsync<{ next_number: number }>(
      `
      SELECT COALESCE(MAX(opening_number), 0) + 1 AS next_number
      FROM local_openings
      WHERE quote_id = ?
    `,
      [quoteId]
    );

    const openingId = opening.id || buildOpeningId();
    const now = new Date().toISOString();
    const totalCost = Number(opening.total_cost || 0);
    const sellPrice = Number(opening.sell_price || 0);
    const discountPct = Number(opening.discount_pct || 0);
    const baselineSellPrice = Number(opening.baseline_sell_price || sellPrice);
    const marginPct =
      sellPrice > 0
        ? Number(
            opening.margin_pct ??
              ((sellPrice - totalCost) / sellPrice) * 100
          )
        : Number(opening.margin_pct || 0);
    const marginDollars = Number(
      opening.margin_dollars ?? sellPrice - totalCost
    );

    await dbInstance.runAsync(
      `
      INSERT INTO local_openings (
        id,
        quote_id,
        opening_number,
        opening_type,
        opening_mode,
        total_width,
        total_height,
        floor_level,
        product_id,
        product_name,
        glass_option_id,
        glass_name,
        frame_color_id,
        frame_name,
        wall_type,
        sell_price,
        total_cost,
        discount_pct,
        baseline_sell_price,
        margin_pct,
        margin_dollars,
        noa_status,
        dp_status,
        dirty,
        local_only,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
    `,
      [
        openingId,
        quoteId,
        nextNumberRow?.next_number || 1,
        opening.opening_type,
        opening.opening_mode || 'standard',
        opening.total_width,
        opening.total_height,
        String(opening.floor_level),
        opening.product_id || null,
        opening.product_name || null,
        opening.glass_option_id || null,
        opening.glass_name || null,
        opening.frame_color_id || null,
        opening.frame_name || null,
        opening.wall_type || null,
        sellPrice,
        totalCost,
        discountPct,
        baselineSellPrice,
        marginPct,
        marginDollars,
        opening.noa_status || 'pending',
        opening.dp_status || 'pending',
        now,
        now,
      ]
    );

    await dbInstance.runAsync(
      `
      UPDATE local_quotes
      SET dirty = 1,
          updated_at = ?
      WHERE id = ?
    `,
      [now, quoteId]
    );

    await recalculateQuote(dbInstance, quoteId);
    await refreshState(dbInstance, set);

    const quote = get().getQuote(quoteId);
    const createdOpening = quote?.openings?.find((item) => item.id === openingId);
    if (!createdOpening) {
      throw new Error('Opening draft was not created');
    }

    return createdOpening;
  },

  batchUpdateOpenings: async (updates: BatchOpeningUpdateInput[]) => {
    if (!dbInstance) {
      throw new Error('Draft store not initialized');
    }

    if (updates.length === 0) {
      return null;
    }

    const timestamp = new Date().toISOString();
    const touchedQuoteIds = new Set<string>();

    await dbInstance.execAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
      for (const update of updates) {
        const quoteId = await applyOpeningPatch(
          dbInstance,
          update.openingId,
          update.patch,
          timestamp
        );
        touchedQuoteIds.add(quoteId);
      }

      for (const quoteId of touchedQuoteIds) {
        await recalculateQuote(dbInstance, quoteId);
      }

      await dbInstance.execAsync('COMMIT');
    } catch (error) {
      await dbInstance.execAsync('ROLLBACK').catch(() => {
        // Ignore rollback noise if SQLite already unwound the transaction.
      });
      throw error;
    }

    await refreshState(dbInstance, set);

    const firstQuoteId = [...touchedQuoteIds][0];
    return firstQuoteId ? get().getQuote(firstQuoteId) || null : null;
  },

  updateOpeningDraft: async (openingId: string, patch: Partial<Opening>) => {
    return get().batchUpdateOpenings([{ openingId, patch }]);
  },
}));
