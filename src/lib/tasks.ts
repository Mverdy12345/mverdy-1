// عمليات المهام على Turso — insertTask / getTask / updateTask (patch جزئي) / listRecentTasks / taskStats
import { q, nowISO } from "./turso";

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  params_json: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskPatch {
  provider?: string;
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: TaskRow["status"];
  progress?: number;
  result_urls_json?: string | null;
  error_message?: string | null;
  attempt?: { provider: string; keyId: string; keyLabel: string; ok: boolean; errorClass?: string; error?: string };
}

export async function insertTask(t: {
  id: string;
  model: string;
  type: TaskRow["type"];
  prompt?: string;
  params_json?: string;
  status?: TaskRow["status"];
}): Promise<void> {
  await q(
    `INSERT INTO tasks (id, model, type, prompt, params_json, status, progress, attempts_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, '[]', ?, ?)`,
    [t.id, t.model, t.type, t.prompt ?? "", t.params_json ?? "{}", t.status ?? "pending", nowISO(), nowISO()],
  );
}

export async function getTask(id: string): Promise<TaskRow | null> {
  const res = await q("SELECT * FROM tasks WHERE id = ?", [id]);
  return (res.rows[0] as unknown as TaskRow) || null;
}

/** patch جزئي: يضيف attempt إلى attempts_json ويضبط completed_at تلقائيًا عند الاكتمال */
export async function updateTask(id: string, patch: TaskPatch): Promise<TaskRow | null> {
  const sets: string[] = ["updated_at = ?"];
  const args: (string | number | null)[] = [nowISO()];

  const plain: [string, string | number | null][] = [];
  if (patch.provider !== undefined) plain.push(["provider", patch.provider]);
  if (patch.provider_task_id !== undefined) plain.push(["provider_task_id", patch.provider_task_id]);
  if (patch.key_id !== undefined) plain.push(["key_id", patch.key_id]);
  if (patch.status !== undefined) plain.push(["status", patch.status]);
  if (patch.progress !== undefined) plain.push(["progress", patch.progress]);
  if (patch.result_urls_json !== undefined) plain.push(["result_urls_json", patch.result_urls_json]);
  if (patch.error_message !== undefined) plain.push(["error_message", patch.error_message]);
  for (const [col, val] of plain) {
    sets.push(`${col} = ?`);
    args.push(val as string | number | null);
  }
  if (patch.status === "completed") {
    sets.push("completed_at = COALESCE(completed_at, ?)");
    args.push(nowISO());
    sets.push("progress = MAX(progress, 100)");
  }

  if (patch.attempt) {
    const cur = await q("SELECT attempts_json FROM tasks WHERE id = ?", [id]);
    let arr: unknown[] = [];
    try {
      arr = JSON.parse(String(cur.rows[0]?.attempts_json ?? "[]"));
    } catch {
      arr = [];
    }
    arr.push({ at: nowISO(), ...patch.attempt });
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(arr).slice(0, 20000)); // حماية من تضخم السجل
  }

  args.push(id);
  await q(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args as never[]);
  return getTask(id);
}

export async function listRecentTasks(
  limit = 10,
  filters: { type?: string; status?: string } = {},
): Promise<TaskRow[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filters.type) {
    where.push("type = ?");
    args.push(filters.type);
  }
  if (filters.status) {
    where.push("status = ?");
    args.push(filters.status);
  }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY created_at DESC, id DESC LIMIT ?`;
  args.push(limit);
  const res = await q(sql, args as never[]);
  return res.rows as unknown as TaskRow[];
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  const res = await q(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('processing','pending') THEN 1 ELSE 0 END) AS processing
     FROM tasks`,
  );
  const r = res.rows[0] as unknown as Record<string, number | null>;
  return {
    total: Number(r?.total ?? 0),
    completed: Number(r?.completed ?? 0),
    failed: Number(r?.failed ?? 0),
    processing: Number(r?.processing ?? 0),
  };
}

/** حذف مهام الاختبار — للتنظيف بعد التجارب */
export async function deleteTask(id: string): Promise<void> {
  await q("DELETE FROM tasks WHERE id = ?", [id]);
}

export function taskResultUrls(task: TaskRow): string[] {
  if (!task.result_urls_json) return [];
  try {
    const arr = JSON.parse(task.result_urls_json);
    return Array.isArray(arr) ? arr.filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}
