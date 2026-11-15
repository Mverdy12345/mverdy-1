// طبقة قاعدة البيانات Turso (libSQL عبر HTTP — إلزامية للتوافق مع Vercel serverless)
// لا ملفات SQLite محلية في الإنتاج؛ كل الاتصالات عبر الشبكة.
import { createClient, type Client, type InValue } from "@libsql/client";

const g = globalThis as unknown as {
  __tursoClient?: Client;
  __tursoSchema?: Promise<void>;
};

/** عميل واحد مُعاد استخدامه (يبقى حيًا عبر hot-reload في التطوير) */
export function getDb(): Client {
  if (g.__tursoClient) return g.__tursoClient;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new Error(
      "متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة — أضفهما في .env محليًا وفي Vercel → Settings → Environment Variables",
    );
  }
  const client = createClient({ url, authToken });
  g.__tursoClient = client;
  return client;
}

/** إنشاء كل الجداول عند أول وصول — لا حاجة لأداة migrations */
export function ensureSchema(): Promise<void> {
  if (!g.__tursoSchema) {
    g.__tursoSchema = (async () => {
      const db = getDb();
      await db.batch(
        [
          // جدول مهام التوليد (صور/فيديو/دمج) — task_id الذي يراه العميل هو id
          `CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            provider TEXT,
            provider_task_id TEXT,
            key_id TEXT,
            model TEXT NOT NULL,
            type TEXT NOT NULL,
            prompt TEXT DEFAULT '',
            params_json TEXT DEFAULT '{}',
            status TEXT NOT NULL,
            progress INTEGER DEFAULT 0,
            result_urls_json TEXT,
            error_message TEXT,
            attempts_json TEXT DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            completed_at TEXT
          )`,
          // جدول مفاتيح API — الترتيب التسلسلي حسب created_at ASC, id ASC
          `CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            label TEXT DEFAULT '',
            api_key TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            usage_count INTEGER DEFAULT 0,
            success_count INTEGER DEFAULT 0,
            fail_count INTEGER DEFAULT 0,
            last_used_at TEXT,
            last_checked_at TEXT,
            last_error TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          )`,
          // جداول خدمة الدمج المدمجة (نفس قاعدة Turso — لا S3 ولا خدمات خارجية)
          `CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'queued',
            progress INTEGER DEFAULT 0,
            error TEXT,
            sources_json TEXT NOT NULL DEFAULT '[]',
            expected_files INTEGER DEFAULT 0,
            output_url TEXT,
            output_size INTEGER,
            output_duration REAL,
            output_resolution TEXT,
            expires_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
          )`,
          `CREATE TABLE IF NOT EXISTS sources (
            job_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            kind TEXT NOT NULL,
            url TEXT,
            name TEXT,
            mime TEXT,
            size INTEGER DEFAULT 0,
            uploaded INTEGER DEFAULT 0,
            PRIMARY KEY (job_id, seq)
          )`,
          // كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso)
          `CREATE TABLE IF NOT EXISTS source_chunks (
            job_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            chunk INTEGER NOT NULL,
            data BLOB,
            PRIMARY KEY (job_id, seq, chunk)
          )`,
          `CREATE TABLE IF NOT EXISTS output_chunks (
            job_id TEXT NOT NULL,
            chunk INTEGER NOT NULL,
            data BLOB,
            PRIMARY KEY (job_id, chunk)
          )`,
        ],
        "write",
      );
    })().catch((e) => {
      g.__tursoSchema = undefined; // اسمح بإعادة المحاولة عند الفشل
      throw e;
    });
  }
  return g.__tursoSchema;
}

/** فحص صحة الاتصال: SELECT 1 */
export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    const r = await getDb().execute("SELECT 1");
    return r.rows.length === 1;
  } catch {
    return false;
  }
}

/** تنفيذ استعلام مع ضمان المخطط أولًا */
export async function q(sql: string, params: InValue[] = []) {
  await ensureSchema();
  return getDb().execute({ sql, args: params });
}

/** وقت ISO بدقة مللي ثانية — لضمان الترتيب التسلسلي الصارم للمفاتيح */
export function nowISO(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}
