import { create } from 'zustand';
import * as SQLite from 'expo-sqlite';
import * as Network from 'expo-network';
import { api } from '@/api/endpoints';
import { FlushResult, SyncEvent, SyncQueueRow } from '@/types';
import { generateUUID } from '@/utils/uuid';
import { MOBILE_SYNC_BATCH_SIZE, RETRY_CONFIG } from '@/constants/api';
import { getOrCreateDeviceId } from '@/store/authStore';
import { useDraftStore } from '@/store/draftStore';

type EntityRef = {
  type: 'quote' | 'opening';
  id: string;
};

interface SyncStore {
  isOnline: boolean;
  pendingCount: number;
  failedCount: number;
  isSyncing: boolean;
  error: string | null;
  lastSyncTime: string | null;
  lastFailedError: string | null;

  enqueueEvent: (
    type: string,
    payload: Record<string, unknown>,
    entity?: EntityRef
  ) => Promise<string>;
  flush: (deviceId: string) => Promise<FlushResult>;
  flushIfOnline: () => Promise<FlushResult>;
  initialize: (db: SQLite.SQLiteDatabase) => Promise<void>;
  getPendingCount: () => Promise<number>;
  getFailedCount: () => Promise<number>;
  setupNetworkListener: () => void;
}

let dbInstance: SQLite.SQLiteDatabase | null = null;
let networkSubscription: ReturnType<typeof setInterval> | null = null;

async function runColumnMigration(db: SQLite.SQLiteDatabase, sql: string): Promise<void> {
  try {
    await db.execAsync(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (!message.includes('duplicate column name')) {
      console.warn('Sync store migration warning:', error);
    }
  }
}

function buildPlaceholders(items: unknown[]): string {
  return items.map(() => '?').join(',');
}

type QueueHealth = {
  pendingCount: number;
  failedCount: number;
  lastFailedError: string | null;
};

async function getQueueHealth(db: SQLite.SQLiteDatabase): Promise<QueueHealth> {
  const counts = await db.getFirstAsync<{ pending_count: number; failed_count: number }>(
    `
    SELECT
      COALESCE(SUM(CASE WHEN attempts < ? THEN 1 ELSE 0 END), 0) AS pending_count,
      COALESCE(SUM(CASE WHEN attempts >= ? THEN 1 ELSE 0 END), 0) AS failed_count
    FROM sync_queue
  `,
    [RETRY_CONFIG.MAX_ATTEMPTS, RETRY_CONFIG.MAX_ATTEMPTS]
  );

  const latestFailure = await db.getFirstAsync<{ last_error: string | null }>(
    `
    SELECT last_error
    FROM sync_queue
    WHERE attempts >= ?
      AND COALESCE(last_error, '') <> ''
    ORDER BY queued_at DESC
    LIMIT 1
  `,
    [RETRY_CONFIG.MAX_ATTEMPTS]
  );

  return {
    pendingCount: Number(counts?.pending_count || 0),
    failedCount: Number(counts?.failed_count || 0),
    lastFailedError: latestFailure?.last_error || null,
  };
}

async function updateEntitySyncState(
  db: SQLite.SQLiteDatabase,
  entity: EntityRef,
  eventType: string
): Promise<void> {
  if (entity.type === 'quote') {
    const pending = await db.getFirstAsync<{ count: number }>(
      `
      SELECT COUNT(*) AS count
      FROM sync_queue
      WHERE entity_type = 'quote'
        AND entity_id = ?
        AND attempts < ?
    `,
      [entity.id, RETRY_CONFIG.MAX_ATTEMPTS]
    );

    const openingFlags = await db.getFirstAsync<{ dirty_count: number; local_count: number }>(
      `
      SELECT
        COALESCE(SUM(CASE WHEN dirty = 1 THEN 1 ELSE 0 END), 0) AS dirty_count,
        COALESCE(SUM(CASE WHEN local_only = 1 THEN 1 ELSE 0 END), 0) AS local_count
      FROM local_openings
      WHERE quote_id = ?
    `,
      [entity.id]
    );

    const dirty =
      Number(pending?.count || 0) > 0 || Number(openingFlags?.dirty_count || 0) > 0 ? 1 : 0;
    const localOnly =
      eventType === 'quote_create' && dirty === 0 && Number(openingFlags?.local_count || 0) === 0
        ? 0
        : undefined;

    if (localOnly === undefined) {
      await db.runAsync(
        `
        UPDATE local_quotes
        SET dirty = ?
        WHERE id = ?
      `,
        [dirty, entity.id]
      );
      return;
    }

    await db.runAsync(
      `
      UPDATE local_quotes
      SET dirty = ?,
          local_only = ?
      WHERE id = ?
    `,
      [dirty, localOnly, entity.id]
    );
    return;
  }

  const pending = await db.getFirstAsync<{ count: number }>(
    `
    SELECT COUNT(*) AS count
    FROM sync_queue
    WHERE entity_type = 'opening'
      AND entity_id = ?
      AND attempts < ?
  `,
    [entity.id, RETRY_CONFIG.MAX_ATTEMPTS]
  );

  const dirty = Number(pending?.count || 0) > 0 ? 1 : 0;
  const localOnly = eventType === 'opening_add' && dirty === 0 ? 0 : undefined;

  if (localOnly === undefined) {
    await db.runAsync(
      `
      UPDATE local_openings
      SET dirty = ?
      WHERE id = ?
    `,
      [dirty, entity.id]
    );
  } else {
    await db.runAsync(
      `
      UPDATE local_openings
      SET dirty = ?,
          local_only = ?
      WHERE id = ?
    `,
      [dirty, localOnly, entity.id]
    );
  }

  const quoteRef = await db.getFirstAsync<{ quote_id: string }>(
    `
    SELECT quote_id
    FROM local_openings
    WHERE id = ?
  `,
    [entity.id]
  );

  if (!quoteRef) {
    return;
  }

  const quotePending = await db.getFirstAsync<{ count: number }>(
    `
    SELECT COUNT(*) AS count
    FROM sync_queue
    WHERE entity_type = 'quote'
      AND entity_id = ?
      AND attempts < ?
  `,
    [quoteRef.quote_id, RETRY_CONFIG.MAX_ATTEMPTS]
  );

  const openingFlags = await db.getFirstAsync<{ dirty_count: number; local_count: number }>(
    `
    SELECT
      COALESCE(SUM(CASE WHEN dirty = 1 THEN 1 ELSE 0 END), 0) AS dirty_count,
      COALESCE(SUM(CASE WHEN local_only = 1 THEN 1 ELSE 0 END), 0) AS local_count
    FROM local_openings
    WHERE quote_id = ?
  `,
    [quoteRef.quote_id]
  );

  await db.runAsync(
    `
    UPDATE local_quotes
    SET dirty = ?,
        local_only = ?
    WHERE id = ?
  `,
    [
      Number(quotePending?.count || 0) > 0 || Number(openingFlags?.dirty_count || 0) > 0 ? 1 : 0,
      Number(openingFlags?.local_count || 0) > 0 ? 1 : 0,
      quoteRef.quote_id,
    ]
  );
}

async function markRowsFailed(
  db: SQLite.SQLiteDatabase,
  rows: SyncQueueRow[],
  errorByEventId: Map<string, string>,
  fallbackError: string | null = null
): Promise<void> {
  for (const row of rows) {
    const message = errorByEventId.get(row.client_event_id) || fallbackError || 'Sync failed';
    await db.runAsync(
      `
      UPDATE sync_queue
      SET attempts = attempts + 1,
          last_error = ?
      WHERE id = ?
    `,
      [message, row.id]
    );
  }
}

async function deleteRows(db: SQLite.SQLiteDatabase, rows: SyncQueueRow[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  const ids = rows.map((row) => row.id);
  await db.runAsync(
    `DELETE FROM sync_queue WHERE id IN (${buildPlaceholders(ids)})`,
    ids
  );
}

export const useSyncStore = create<SyncStore>((set, get) => ({
  isOnline: true,
  pendingCount: 0,
  failedCount: 0,
  isSyncing: false,
  error: null,
  lastSyncTime: null,
  lastFailedError: null,

  initialize: async (db: SQLite.SQLiteDatabase) => {
    dbInstance = db;

    try {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS sync_queue (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          client_event_id TEXT UNIQUE NOT NULL,
          queued_at TEXT NOT NULL,
          attempts INTEGER DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_sync_queue_attempts
          ON sync_queue (attempts, queued_at);
      `);

      await runColumnMigration(db, 'ALTER TABLE sync_queue ADD COLUMN entity_type TEXT');
      await runColumnMigration(db, 'ALTER TABLE sync_queue ADD COLUMN entity_id TEXT');
      await runColumnMigration(db, 'ALTER TABLE sync_queue ADD COLUMN last_error TEXT');
      await db.execAsync(`
        CREATE INDEX IF NOT EXISTS idx_sync_queue_entity
          ON sync_queue (entity_type, entity_id);
      `);

      const networkState = await Network.getNetworkStateAsync();
      const isOnline =
        (networkState.isConnected ?? true) &&
        (networkState.isInternetReachable ?? true);
      const summary = await getQueueHealth(db);

      set({
        isOnline,
        pendingCount: summary.pendingCount,
        failedCount: summary.failedCount,
        lastFailedError: summary.lastFailedError,
      });

      get().setupNetworkListener();

      if (isOnline && summary.pendingCount > 0) {
        await get().flushIfOnline().catch((error) => {
          console.warn('Initial sync flush failed:', error);
        });
      }
    } catch (error) {
      console.error('Failed to initialize sync store:', error);
      throw error;
    }
  },

  enqueueEvent: async (
    type: string,
    payload: Record<string, unknown>,
    entity?: EntityRef
  ) => {
    if (!dbInstance) {
      throw new Error('Sync store not initialized');
    }

    const clientEventId = generateUUID();
    const id = generateUUID();
    const now = new Date().toISOString();

    await dbInstance.runAsync(
      `
      INSERT INTO sync_queue (
        id,
        event_type,
        payload_json,
        client_event_id,
        queued_at,
        attempts,
        entity_type,
        entity_id,
        last_error
      )
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL)
    `,
      [
        id,
        type,
        JSON.stringify(payload),
        clientEventId,
        now,
        entity?.type || null,
        entity?.id || null,
      ]
    );

    const summary = await getQueueHealth(dbInstance);
    set({
      pendingCount: summary.pendingCount,
      failedCount: summary.failedCount,
      lastFailedError: summary.lastFailedError,
    });

    return clientEventId;
  },

  getPendingCount: async () => {
    if (!dbInstance) return 0;

    try {
      const summary = await getQueueHealth(dbInstance);
      return summary.pendingCount;
    } catch (error) {
      console.warn('Failed to get pending count:', error);
      return 0;
    }
  },

  getFailedCount: async () => {
    if (!dbInstance) return 0;

    try {
      const summary = await getQueueHealth(dbInstance);
      return summary.failedCount;
    } catch (error) {
      console.warn('Failed to get failed count:', error);
      return 0;
    }
  },

  flushIfOnline: async () => {
    if (!get().isOnline) {
      return { processed: 0, skipped: 0, errors: [] };
    }

    const deviceId = await getOrCreateDeviceId();
    return get().flush(deviceId);
  },

  flush: async (deviceId: string): Promise<FlushResult> => {
    if (!dbInstance || !get().isOnline) {
      return { processed: 0, skipped: 0, errors: [] };
    }

    set({ isSyncing: true, error: null });

    let pendingEvents: SyncQueueRow[] = [];

    try {
      pendingEvents = await dbInstance.getAllAsync<SyncQueueRow>(
        `
        SELECT *
        FROM sync_queue
        WHERE attempts < ?
        ORDER BY queued_at ASC
        LIMIT ?
      `,
        [RETRY_CONFIG.MAX_ATTEMPTS, MOBILE_SYNC_BATCH_SIZE]
      );

      if (pendingEvents.length === 0) {
        const summary = await getQueueHealth(dbInstance);
        set({
          isSyncing: false,
          pendingCount: summary.pendingCount,
          failedCount: summary.failedCount,
          lastFailedError: summary.lastFailedError,
        });
        return { processed: 0, skipped: 0, errors: [] };
      }

      const events: SyncEvent[] = pendingEvents.map((row) => ({
        client_event_id: row.client_event_id,
        type: row.event_type,
        payload: JSON.parse(row.payload_json),
        occurred_at: row.queued_at,
      }));

      const response = await api.mobile.syncEvents(deviceId, events);
      const errorByEventId = new Map(
        (response.errors || []).map((error) => [error.client_event_id, error.error])
      );

      const successfulRows = pendingEvents.filter(
        (row) => !errorByEventId.has(row.client_event_id)
      );
      const failedRows = pendingEvents.filter((row) =>
        errorByEventId.has(row.client_event_id)
      );

      await deleteRows(dbInstance, successfulRows);
      await markRowsFailed(dbInstance, failedRows, errorByEventId);

      for (const row of successfulRows) {
        if (row.entity_type && row.entity_id) {
          await updateEntitySyncState(
            dbInstance,
            { type: row.entity_type, id: row.entity_id },
            row.event_type
          );
        }
      }

      await useDraftStore.getState().loadDrafts();

      const summary = await getQueueHealth(dbInstance);
      set({
        isSyncing: false,
        pendingCount: summary.pendingCount,
        failedCount: summary.failedCount,
        lastFailedError: summary.lastFailedError,
        error:
          summary.failedCount > 0
            ? `${summary.failedCount} event(s) need manager review`
            : response.errors?.length
            ? `${response.errors.length} event(s) need attention`
            : null,
        lastSyncTime: response.server_time || new Date().toISOString(),
      });

      return {
        processed: response.processed,
        skipped: response.skipped,
        errors: (response.errors || []).map((error) => ({
          event_id: error.client_event_id,
          error: error.error,
        })),
        server_time: response.server_time,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed';
      set({
        isSyncing: false,
        error: message,
      });

      if (dbInstance && pendingEvents.length > 0) {
        await markRowsFailed(dbInstance, pendingEvents, new Map(), message).catch((markError) => {
          console.warn('Failed to increment retry attempts:', markError);
        });
      }

      if (dbInstance) {
        const summary = await getQueueHealth(dbInstance);
        set({
          pendingCount: summary.pendingCount,
          failedCount: summary.failedCount,
          lastFailedError: summary.lastFailedError,
          error:
            summary.failedCount > 0
              ? `${summary.failedCount} event(s) need manager review`
              : message,
        });
      }

      throw error;
    }
  },

  setupNetworkListener: () => {
    if (networkSubscription) {
      return;
    }

    const syncNetworkState = async () => {
      try {
        const state = await Network.getNetworkStateAsync();
        const isOnline =
          (state.isConnected ?? true) &&
          (state.isInternetReachable ?? true);

        const wasOnline = get().isOnline;
        set({ isOnline });

        if (isOnline && !wasOnline && !get().isSyncing && get().pendingCount > 0) {
          await get().flushIfOnline().catch((error) => {
            console.warn('Auto-flush on reconnect failed:', error);
          });
        }
      } catch (error) {
        console.warn('Network state refresh failed:', error);
      }
    };

    void syncNetworkState();
    networkSubscription = setInterval(() => {
      void syncNetworkState();
    }, 10000);
  },
}));
