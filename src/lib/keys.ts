// نظام المفاتيح المتسلسلة — قلب المشروع
// الترتيب صارم حسب ترتيب الإضافة (created_at ASC, id ASC) — ليس round-robin وليس «الأقل استخدامًا»
import { q, nowISO, uuid } from "./turso";
import type { ProviderId } from "./models";

export type KeyStatus = "active" | "exhausted" | "disabled";
export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export interface ApiKeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface AttemptRecord {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: ErrorClass;
  error?: string;
  at: string;
}

// إخفاء المفتاح إلزامي في كل الاستجابات والسجلات — لا يُعاد المفتاح الكامل أبدًا
export function maskKey(key: string): string {
  if (key.length >= 14) return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
  return `${key.slice(0, 3)}••••••`;
}

/**
 * تصنيف أخطاء المزودين — دالة موحدة وفق جدول 4.2:
 * نفاد الرصيد يُفحص قبل 400 لأن بعض المزودين يرسلونه بحالة 400.
 */
export function classifyProviderError(status: number | undefined, message: string): ErrorClass {
  const msg = (message || "").toLowerCase();
  const exhausted =
    status === 402 ||
    /insufficient|quota|balance|credit|out of credits|exhausted|充值|رصيد/.test(msg);
  if (exhausted) return "exhausted";
  const disabled =
    status === 401 ||
    status === 403 ||
    /invalid api key|invalid_api_key|unauthorized|forbidden|authentication|api key|auth|token/.test(msg);
  if (disabled) return "disabled";
  if (/model not found|unsupported model|no available channel|not found for this model|model.*not.*exist/.test(msg) && [400, 404, 422].includes(status ?? 0))
    return "provider";
  if ([400, 422].includes(status ?? 0)) return "params";
  if (status === 429 || (status ?? 0) >= 500) return "temporary";
  return "temporary";
}

/** جلب المفاتيح غير المعطّلة لهذه المزودات بالترتيب التسلسلي الصارم */
export async function getKeyPool(providers: ProviderId[]): Promise<ApiKeyRow[]> {
  if (providers.length === 0) return [];
  const placeholders = providers.map(() => "?").join(", ");
  const res = await q(
    `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${placeholders})
     ORDER BY created_at ASC, id ASC`,
    [...providers],
  );
  return res.rows as unknown as ApiKeyRow[];
}

export async function insertKey(provider: string, apiKey: string, label: string): Promise<ApiKeyRow> {
  const id = uuid();
  await q(
    `INSERT INTO api_keys (id, provider, label, api_key, status, usage_count, success_count, fail_count, created_at)
     VALUES (?, ?, ?, ?, 'active', 0, 0, 0, ?)`,
    [id, provider, label || "", apiKey, nowISO()],
  );
  return (await getKeyById(id))!;
}

export async function getKeyById(id: string): Promise<ApiKeyRow | null> {
  const res = await q("SELECT * FROM api_keys WHERE id = ?", [id]);
  return (res.rows[0] as unknown as ApiKeyRow) || null;
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<ApiKeyRow | null> {
  const res = await q("SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1", [provider, apiKey]);
  return (res.rows[0] as unknown as ApiKeyRow) || null;
}

export async function listKeys(): Promise<ApiKeyRow[]> {
  const res = await q("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return res.rows as unknown as ApiKeyRow[];
}

export async function setKeyStatus(id: string, status: KeyStatus, error?: string): Promise<void> {
  await q("UPDATE api_keys SET status = ?, last_error = ?, last_checked_at = ? WHERE id = ?", [
    status,
    error ?? null,
    nowISO(),
    id,
  ]);
}

export async function deleteKey(id: string): Promise<void> {
  await q("DELETE FROM api_keys WHERE id = ?", [id]);
}

/** تحديث عدّادات المفتاح — تُحدَّث دائمًا (نجاح أو فشل)، مع تعليم الحالة تلقائيًا عند الرفض/الاستنزاف */
export async function updateKeyStats(
  id: string,
  ok: boolean,
  opts?: { error?: string; errorClass?: ErrorClass },
): Promise<void> {
  const cls = opts?.errorClass;
  await q(
    `UPDATE api_keys SET
       usage_count = usage_count + 1,
       success_count = success_count + ?,
       fail_count = fail_count + ?,
       last_used_at = ?,
       last_checked_at = ?,
       last_error = ?,
       -- المفتاح المرفوض أو المستنزف يُعلَّم تلقائيًا (يبقى في القاعدة ولا يُستبعد إلا بالتعطيل اليدوي)
       status = CASE
         WHEN ? = 1 THEN status
         WHEN ? = 'exhausted' THEN 'exhausted'
         WHEN ? = 'disabled' THEN 'disabled'
         ELSE status END
     WHERE id = ?`,
    [
      ok ? 1 : 0,
      ok ? 0 : 1,
      nowISO(),
      nowISO(),
      opts?.error ?? null,
      ok ? 1 : 0,
      !ok && cls === "exhausted" ? 1 : 0,
      !ok && cls === "disabled" ? 1 : 0,
      id,
    ],
  );
}
