// تخزين Blobs في Turso — تقسيم إلى صفوف 2MB (حد HTTP في Turso) وقراءة تدفقيًا بصفحات من 8 صفوف
import { q } from "../turso";

export const CHUNK_BYTES = 2 * 1024 * 1024; // 2MB لكل صف

/** حفظ ملف كامل كصفوف chunks — يعيد عدد الصفوف والحجم */
export async function saveBlobChunks(
  table: "source_chunks" | "output_chunks",
  keyCols: Record<string, string | number>,
  data: Buffer,
): Promise<{ chunks: number; size: number }> {
  const rows: { sql: string; args: unknown[] }[] = [];
  const nChunks = Math.max(1, Math.ceil(data.length / CHUNK_BYTES));
  for (let i = 0; i < nChunks; i++) {
    const slice = data.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    const cols = Object.entries({ ...keyCols, chunk: i }).map(([k]) => k);
    const placeholders = Object.entries({ ...keyCols, chunk: i }).map(() => "?");
    rows.push({
      sql: `INSERT INTO ${table} (${cols.join(", ")}, data) VALUES (${placeholders.join(", ")}, ?)`,
      args: [...Object.values({ ...keyCols, chunk: i }), slice],
    });
  }
  await q(`DELETE FROM ${table} WHERE ${Object.keys(keyCols).map((k) => `${k} = ?`).join(" AND ")}`, Object.values(keyCols) as never[]);
  if (rows.length) {
    const db = (await import("../turso")).getDb();
    await db.batch(rows as never[], "write");
  }
  return { chunks: rows.length, size: data.length };
}

/** قراءة ملف كامل من صفوف chunks (للملفات الصغيرة/المعالجة في /tmp) */
export async function loadBlobChunks(
  table: "source_chunks" | "output_chunks",
  keyWhere: { sql: string; args: unknown[] },
): Promise<Buffer | null> {
  const res = await q(
    `SELECT chunk, length(data) AS len, data FROM ${table} WHERE ${keyWhere.sql} ORDER BY chunk ASC`,
    keyWhere.args as never[],
  );
  if (!res.rows.length) return null;
  const parts = res.rows.map((r) => Buffer.from(r.data as ArrayBuffer));
  return Buffer.concat(parts);
}

/** قراءة مجمّعة من صف واحد (للأجزاء المرفوعة بالتسلسل) */
export async function appendSourceChunk(jobId: string, seq: number, chunkIndex: number, data: Buffer): Promise<void> {
  await q(
    `INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)
     ON CONFLICT (job_id, seq, chunk) DO UPDATE SET data = excluded.data`,
    [jobId, seq, chunkIndex, data],
  );
}

export async function sourceChunkCount(jobId: string, seq: number): Promise<{ count: number; size: number }> {
  const res = await q("SELECT COUNT(*) AS c, COALESCE(SUM(length(data)),0) AS s FROM source_chunks WHERE job_id = ? AND seq = ?", [
    jobId,
    seq,
  ]);
  const r = res.rows[0] as unknown as { c: number; s: number };
  return { count: Number(r.c), size: Number(r.s) };
}

/** تدفّق قراءة output_chunks مع تقليم أول/آخر جزء حسب المدى المطلوب (Range 206) */
export async function outputChunkRows(jobId: string): Promise<{ chunk: number; data: Buffer }[]> {
  const res = await q("SELECT chunk, data FROM output_chunks WHERE job_id = ? ORDER BY chunk ASC", [jobId]);
  return res.rows.map((r) => ({ chunk: Number(r.chunk), data: Buffer.from(r.data as ArrayBuffer) }));
}
