-- 课栈 · Cloudflare D1 表结构
-- 在 Cloudflare 控制台 D1 → 你的数据库 → Console 里整段执行

CREATE TABLE IF NOT EXISTS households (
  code       TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS progress (
  code       TEXT NOT NULL,
  course_id  TEXT NOT NULL,
  watched    INTEGER NOT NULL DEFAULT 0,
  duration   INTEGER NOT NULL DEFAULT 0,
  percent    REAL    NOT NULL DEFAULT 0,
  done       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (code, course_id)
);

CREATE INDEX IF NOT EXISTS idx_progress_code ON progress (code);
