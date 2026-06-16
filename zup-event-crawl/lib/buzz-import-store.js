"use strict";

const { getBuzzEnvConfig, normalizeBuzzEnv, resolvePublishUserId } = require("./buzz-env");

const ENTITY_EVENT = "event";
const ENTITY_MERCHANT = "merchant";

function ensureBuzzImportSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS buzz_imports (
      entity_kind TEXT NOT NULL,
      entity_uid TEXT NOT NULL,
      buzz_env TEXT NOT NULL DEFAULT 'test',
      buzz_id TEXT NOT NULL DEFAULT '',
      buzz_group_id TEXT NOT NULL DEFAULT '',
      bubble_now_id TEXT NOT NULL DEFAULT '',
      bubble_published_at TEXT,
      import_status TEXT NOT NULL DEFAULT '',
      import_error TEXT NOT NULL DEFAULT '',
      imported_at TEXT,
      publish_user_id TEXT NOT NULL DEFAULT '',
      now_merchant_id TEXT NOT NULL DEFAULT '',
      now_merchant_name TEXT NOT NULL DEFAULT '',
      updated_at TEXT,
      PRIMARY KEY (entity_kind, entity_uid, buzz_env)
    )
  `);
  migrateLegacyBuzzImports(db);
}

function migrateLegacyBuzzImports(db) {
  const migrated = db.prepare(`
    SELECT value FROM app_meta WHERE key = 'buzz_imports_migrated_v1'
  `).get();
  if (migrated?.value === "1") return;

  const eventRows = db.prepare(`
    SELECT event_uid, buzz_now_id, buzz_group_id, import_status, import_error, imported_at,
           publish_user_id, now_merchant_id, now_merchant_name
    FROM events
    WHERE (buzz_now_id IS NOT NULL AND buzz_now_id != '')
       OR (import_status IS NOT NULL AND import_status != '')
  `).all();

  const upsert = db.prepare(`
    INSERT INTO buzz_imports (
      entity_kind, entity_uid, buzz_env, buzz_id, buzz_group_id,
      import_status, import_error, imported_at,
      publish_user_id, now_merchant_id, now_merchant_name, updated_at
    ) VALUES (
      @entity_kind, @entity_uid, 'test', @buzz_id, @buzz_group_id,
      @import_status, @import_error, @imported_at,
      @publish_user_id, @now_merchant_id, @now_merchant_name, @updated_at
    )
    ON CONFLICT(entity_kind, entity_uid, buzz_env) DO UPDATE SET
      buzz_id = excluded.buzz_id,
      buzz_group_id = excluded.buzz_group_id,
      import_status = excluded.import_status,
      import_error = excluded.import_error,
      imported_at = excluded.imported_at,
      publish_user_id = CASE WHEN excluded.publish_user_id != '' THEN excluded.publish_user_id ELSE buzz_imports.publish_user_id END,
      now_merchant_id = excluded.now_merchant_id,
      now_merchant_name = excluded.now_merchant_name,
      updated_at = excluded.updated_at
    WHERE buzz_imports.buzz_id = '' AND excluded.buzz_id != ''
  `);

  const now = new Date().toISOString();
  for (const row of eventRows) {
    upsert.run({
      entity_kind: ENTITY_EVENT,
      entity_uid: row.event_uid,
      buzz_id: row.buzz_now_id || "",
      buzz_group_id: row.buzz_group_id || "",
      import_status: row.import_status || "",
      import_error: row.import_error || "",
      imported_at: row.imported_at || null,
      publish_user_id: row.publish_user_id || "",
      now_merchant_id: row.now_merchant_id || "",
      now_merchant_name: row.now_merchant_name || "",
      updated_at: now,
    });
  }

  const merchantTable = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'merchants'
  `).get();
  if (merchantTable) {
    const merchantRows = db.prepare(`
      SELECT merchant_uid, buzz_merchant_id, buzz_group_id, bubble_now_id, bubble_published_at,
             import_status, import_error, imported_at
      FROM merchants
      WHERE (buzz_merchant_id IS NOT NULL AND buzz_merchant_id != '')
         OR (import_status IS NOT NULL AND import_status != '')
    `).all();
    for (const row of merchantRows) {
      upsert.run({
        entity_kind: ENTITY_MERCHANT,
        entity_uid: row.merchant_uid,
        buzz_id: row.buzz_merchant_id || "",
        buzz_group_id: row.buzz_group_id || "",
        import_status: row.import_status || "",
        import_error: row.import_error || "",
        imported_at: row.imported_at || null,
        publish_user_id: "",
        now_merchant_id: "",
        now_merchant_name: "",
        updated_at: now,
      });
      if (row.bubble_now_id || row.bubble_published_at) {
        db.prepare(`
          UPDATE buzz_imports SET
            bubble_now_id = @bubble_now_id,
            bubble_published_at = @bubble_published_at
          WHERE entity_kind = @entity_kind AND entity_uid = @entity_uid AND buzz_env = 'test'
        `).run({
          entity_kind: ENTITY_MERCHANT,
          entity_uid: row.merchant_uid,
          bubble_now_id: row.bubble_now_id || "",
          bubble_published_at: row.bubble_published_at || null,
        });
      }
    }
  }

  db.prepare(`
    INSERT INTO app_meta (key, value) VALUES ('buzz_imports_migrated_v1', '1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();
}

function rowToImportRecord(row) {
  if (!row) return null;
  return {
    buzz_env: row.buzz_env,
    buzz_id: row.buzz_id || "",
    buzz_group_id: row.buzz_group_id || "",
    bubble_now_id: row.bubble_now_id || "",
    bubble_published_at: row.bubble_published_at || null,
    import_status: row.import_status || "",
    import_error: row.import_error || "",
    imported_at: row.imported_at || null,
    publish_user_id: row.publish_user_id || "",
    now_merchant_id: row.now_merchant_id || "",
    now_merchant_name: row.now_merchant_name || "",
  };
}

function getBuzzImport(db, entityKind, entityUid, buzzEnv) {
  ensureBuzzImportSchema(db);
  const env = normalizeBuzzEnv(buzzEnv);
  const row = db.prepare(`
    SELECT * FROM buzz_imports
    WHERE entity_kind = ? AND entity_uid = ? AND buzz_env = ?
  `).get(entityKind, entityUid, env);
  return rowToImportRecord(row);
}

function sqlBind(value) {
  return value === undefined ? null : value;
}

function upsertBuzzImport(db, entityKind, entityUid, buzzEnv, patch = {}) {
  ensureBuzzImportSchema(db);
  const env = normalizeBuzzEnv(buzzEnv);
  const current = getBuzzImport(db, entityKind, entityUid, env) || {};
  const now = new Date().toISOString();
  const imported = patch.import_status === "imported";
  const pick = (key, fallback = "") => (
    Object.prototype.hasOwnProperty.call(patch, key)
      ? String(patch[key] ?? "").trim()
      : String(current[key] ?? fallback).trim()
  );
  const next = {
    entity_kind: entityKind,
    entity_uid: entityUid,
    buzz_env: env,
    buzz_id: pick("buzz_id", current.buzz_id),
    buzz_group_id: pick("buzz_group_id", current.buzz_group_id),
    bubble_now_id: pick("bubble_now_id", current.bubble_now_id),
    bubble_published_at: sqlBind(
      Object.prototype.hasOwnProperty.call(patch, "bubble_published_at")
        ? patch.bubble_published_at
        : (current.bubble_published_at ?? null),
    ),
    import_status: pick("import_status", current.import_status),
    import_error: pick("import_error", current.import_error),
    imported_at: sqlBind(imported
      ? now
      : (Object.prototype.hasOwnProperty.call(patch, "imported_at")
        ? patch.imported_at
        : (current.imported_at ?? null))),
    publish_user_id: pick("publish_user_id", current.publish_user_id),
    now_merchant_id: pick("now_merchant_id", current.now_merchant_id),
    now_merchant_name: pick("now_merchant_name", current.now_merchant_name),
    updated_at: now,
  };

  db.prepare(`
    INSERT INTO buzz_imports (
      entity_kind, entity_uid, buzz_env,
      buzz_id, buzz_group_id, bubble_now_id, bubble_published_at,
      import_status, import_error, imported_at,
      publish_user_id, now_merchant_id, now_merchant_name, updated_at
    ) VALUES (
      @entity_kind, @entity_uid, @buzz_env,
      @buzz_id, @buzz_group_id, @bubble_now_id, @bubble_published_at,
      @import_status, @import_error, @imported_at,
      @publish_user_id, @now_merchant_id, @now_merchant_name, @updated_at
    )
    ON CONFLICT(entity_kind, entity_uid, buzz_env) DO UPDATE SET
      buzz_id = excluded.buzz_id,
      buzz_group_id = excluded.buzz_group_id,
      bubble_now_id = excluded.bubble_now_id,
      bubble_published_at = excluded.bubble_published_at,
      import_status = excluded.import_status,
      import_error = excluded.import_error,
      imported_at = excluded.imported_at,
      publish_user_id = excluded.publish_user_id,
      now_merchant_id = excluded.now_merchant_id,
      now_merchant_name = excluded.now_merchant_name,
      updated_at = excluded.updated_at
  `).run(next);

  syncLegacyTestColumns(db, entityKind, entityUid, env, next);
  return getBuzzImport(db, entityKind, entityUid, env);
}

function syncLegacyTestColumns(db, entityKind, entityUid, buzzEnv, record) {
  if (normalizeBuzzEnv(buzzEnv) !== "test") return;
  const now = new Date().toISOString();
  if (entityKind === ENTITY_EVENT) {
    db.prepare(`
      UPDATE events SET
        buzz_now_id = @buzz_now_id,
        buzz_group_id = @buzz_group_id,
        import_status = @import_status,
        import_error = @import_error,
        imported_at = @imported_at,
        updated_at = @updated_at
      WHERE event_uid = @event_uid
    `).run({
      event_uid: entityUid,
      buzz_now_id: record.buzz_id,
      buzz_group_id: record.buzz_group_id,
      import_status: record.import_status,
      import_error: record.import_error,
      imported_at: sqlBind(record.imported_at),
      updated_at: now,
    });
  } else if (entityKind === ENTITY_MERCHANT) {
    db.prepare(`
      UPDATE merchants SET
        buzz_merchant_id = @buzz_merchant_id,
        buzz_group_id = @buzz_group_id,
        bubble_now_id = @bubble_now_id,
        bubble_published_at = @bubble_published_at,
        import_status = @import_status,
        import_error = @import_error,
        imported_at = @imported_at,
        updated_at = @updated_at
      WHERE merchant_uid = @merchant_uid
    `).run({
      merchant_uid: entityUid,
      buzz_merchant_id: record.buzz_id,
      buzz_group_id: record.buzz_group_id,
      bubble_now_id: record.bubble_now_id,
      bubble_published_at: sqlBind(record.bubble_published_at),
      import_status: record.import_status,
      import_error: record.import_error,
      imported_at: sqlBind(record.imported_at),
      updated_at: now,
    });
  }
}

function clearBuzzImport(db, entityKind, entityUid, buzzEnv) {
  return upsertBuzzImport(db, entityKind, entityUid, buzzEnv, {
    buzz_id: "",
    buzz_group_id: "",
    bubble_now_id: "",
    bubble_published_at: null,
    import_status: "",
    import_error: "",
    imported_at: null,
  });
}

function applyBuzzEnvToEvent(db, event, buzzEnv) {
  if (!event) return event;
  const env = normalizeBuzzEnv(buzzEnv);
  const imp = getBuzzImport(db, ENTITY_EVENT, event.event_uid || event.eventUid, env);
  const cfg = getBuzzEnvConfig(env);
  return {
    ...event,
    buzz_env: env,
    buzz_env_label: cfg.label || env,
    publish_user_id: resolvePublishUserId(
      env,
      imp?.publish_user_id,
      event.publish_user_id,
    ),
    now_merchant_id: imp?.now_merchant_id || "",
    now_merchant_name: imp?.now_merchant_name || "",
    buzz_now_id: imp?.buzz_id || "",
    buzz_group_id: imp?.buzz_group_id || "",
    import_status: imp?.import_status || "",
    import_error: imp?.import_error || "",
    imported_at: imp?.imported_at || null,
  };
}

function applyBuzzEnvToMerchant(db, merchant, buzzEnv) {
  if (!merchant) return merchant;
  const env = normalizeBuzzEnv(buzzEnv);
  const imp = getBuzzImport(db, ENTITY_MERCHANT, merchant.merchant_uid, env);
  const cfg = getBuzzEnvConfig(env);
  return {
    ...merchant,
    buzz_env: env,
    buzz_env_label: cfg.label || env,
    buzz_merchant_id: imp?.buzz_id || "",
    buzz_group_id: imp?.buzz_group_id || "",
    bubble_now_id: imp?.bubble_now_id || "",
    bubble_published_at: imp?.bubble_published_at || null,
    import_status: imp?.import_status || "",
    import_error: imp?.import_error || "",
    imported_at: imp?.imported_at || null,
  };
}

function isImportedInEnv(db, entityKind, entityUid, buzzEnv) {
  const imp = getBuzzImport(db, entityKind, entityUid, buzzEnv);
  return imp?.import_status === "imported" && Boolean(String(imp.buzz_id || "").trim());
}

function markEventImportResult(db, eventUid, result, buzzEnv = "test") {
  const env = normalizeBuzzEnv(buzzEnv);
  const patch = {};
  if (result.buzz_now_id !== undefined || result.buzz_id !== undefined) {
    patch.buzz_id = result.buzz_now_id ?? result.buzz_id;
  }
  if (result.buzz_group_id !== undefined) patch.buzz_group_id = result.buzz_group_id;
  if (result.import_status !== undefined) patch.import_status = result.import_status;
  if (result.import_error !== undefined) patch.import_error = result.import_error;
  if (result.imported_at !== undefined) patch.imported_at = result.imported_at;
  if (result.publish_user_id !== undefined) patch.publish_user_id = result.publish_user_id;
  if (result.now_merchant_id !== undefined) patch.now_merchant_id = result.now_merchant_id;
  if (result.now_merchant_name !== undefined) patch.now_merchant_name = result.now_merchant_name;
  return upsertBuzzImport(db, ENTITY_EVENT, eventUid, env, patch);
}

function markMerchantImportResult(db, merchantUid, result, buzzEnv = "test") {
  const env = normalizeBuzzEnv(buzzEnv);
  const patch = {};
  if (result.buzz_merchant_id !== undefined || result.buzz_id !== undefined) {
    patch.buzz_id = result.buzz_merchant_id ?? result.buzz_id;
  }
  if (result.buzz_group_id !== undefined) patch.buzz_group_id = result.buzz_group_id;
  if (result.bubble_now_id !== undefined) patch.bubble_now_id = result.bubble_now_id;
  if (result.bubble_published_at !== undefined) patch.bubble_published_at = result.bubble_published_at;
  if (result.import_status !== undefined) patch.import_status = result.import_status;
  if (result.import_error !== undefined) patch.import_error = result.import_error;
  if (result.imported_at !== undefined) patch.imported_at = result.imported_at;
  return upsertBuzzImport(db, ENTITY_MERCHANT, merchantUid, env, patch);
}

function clearEventBuzzNow(db, eventUid, buzzEnv = "test") {
  return markEventImportResult(db, eventUid, {
    buzz_now_id: "",
    buzz_group_id: "",
    import_status: "",
    import_error: "",
  }, buzzEnv);
}

function clearMerchantBuzzId(db, merchantUid, buzzEnv = "test") {
  return markMerchantImportResult(db, merchantUid, {
    buzz_merchant_id: "",
    import_status: "",
    import_error: "",
    imported_at: null,
  }, buzzEnv);
}

function updateEventMerchantInfoForEnv(db, eventUid, buzzEnv, info = {}) {
  return upsertBuzzImport(db, ENTITY_EVENT, eventUid, buzzEnv, {
    now_merchant_id: String(info.now_merchant_id || "").trim(),
    now_merchant_name: String(info.now_merchant_name || "").trim(),
  });
}

function updateEventImportPrepForEnv(db, eventUid, buzzEnv, patch = {}) {
  const impPatch = {};
  if (patch.publish_user_id !== undefined) {
    impPatch.publish_user_id = String(patch.publish_user_id || "").trim();
  }
  if (Object.keys(impPatch).length) {
    upsertBuzzImport(db, ENTITY_EVENT, eventUid, buzzEnv, impPatch);
  }
  return getBuzzImport(db, ENTITY_EVENT, eventUid, buzzEnv);
}

module.exports = {
  ENTITY_EVENT,
  ENTITY_MERCHANT,
  applyBuzzEnvToEvent,
  applyBuzzEnvToMerchant,
  clearBuzzImport,
  clearEventBuzzNow,
  clearMerchantBuzzId,
  ensureBuzzImportSchema,
  getBuzzImport,
  isImportedInEnv,
  markEventImportResult,
  markMerchantImportResult,
  updateEventImportPrepForEnv,
  updateEventMerchantInfoForEnv,
  upsertBuzzImport,
};
