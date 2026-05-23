const express = require('express');
const Database = require('better-sqlite3');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');

const app = express();
const db = new Database('survey.db');

// ── Database setup ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS fortune_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
    viewed_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Admin credentials (change these!) ───────────────────────────
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin1234';

// ── Middleware ───────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'survey-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 2 } // 2 hours
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ──────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ════════════════════════════════════════════════════════════════
//  PUBLIC API
// ════════════════════════════════════════════════════════════════

// Submit survey — upsert by (name + phone)
app.post('/api/submit', (req, res) => {
  const { name, email, phone } = req.body;

  if (!name || !email || !phone)
    return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบทุกช่อง' });

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email))
    return res.status(400).json({ error: 'รูปแบบอีเมล์ไม่ถูกต้อง' });

  const phoneRegex = /^[0-9]{9,10}$/;
  if (!phoneRegex.test(phone.replace(/-/g, '')))
    return res.status(400).json({ error: 'รูปแบบเบอร์โทรไม่ถูกต้อง' });

  // Check duplicate by name + phone
  const existing = db.prepare('SELECT id FROM responses WHERE name = ? AND phone = ?').get(name, phone.replace(/-/g, ''));

  let id;
  let isNew = false;
  if (existing) {
    // Update email only
    db.prepare('UPDATE responses SET email = ? WHERE id = ?').run(email, existing.id);
    id = existing.id;
  } else {
    const result = db.prepare('INSERT INTO responses (name, email, phone) VALUES (?, ?, ?)').run(name, email, phone.replace(/-/g, ''));
    id = result.lastInsertRowid;
    isNew = true;
  }

  res.json({ success: true, id, isNew });
});

// Get star count (public)
app.get('/api/stars', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM responses').get().c;
  res.json({ count });
});

// Log fortune view (public) — called every time popup opens
app.post('/api/fortune/log', (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'missing params' });
  const row = db.prepare('SELECT id FROM responses WHERE name = ? AND phone = ?').get(name, phone.replace(/-/g, ''));
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('INSERT INTO fortune_logs (response_id) VALUES (?)').run(row.id);
  res.json({ success: true });
});

// Fortune prediction (public)
app.get('/api/fortune', (req, res) => {
  const { name, phone } = req.query;
  if (!name || !phone) return res.status(400).json({ error: 'missing params' });

  const seed = [...(name + phone)].reduce((a, c) => a + c.charCodeAt(0), 0);

  const luckScore  = 60 + (seed % 35);
  const loveScore  = 55 + ((seed * 3) % 40);
  const workScore  = 50 + ((seed * 7) % 45);
  const moneyScore = 45 + ((seed * 11) % 50);

  const elements = ['ไฟ 🔥','น้ำ 💧','ดิน 🌿','ลม 🌬️','ทอง ✨'];
  const stones   = ['ไพลิน 💎','ทับทิม ❤️','มรกต 💚','อเมทิสต์ 💜','มุก 🤍','โทแพซ 💛'];
  const colors   = ['ทอง','ม่วง','น้ำเงิน','เขียว','แดง','ขาว'];
  const days     = ['จันทร์','อังคาร','พุธ','พฤหัส','ศุกร์','เสาร์','อาทิตย์'];
  const numbers  = [3,7,8,9,11,18,21,28,33,36,42,49,55,66,77,88,99];

  const luckyNum   = numbers[Math.abs(seed * 13) % numbers.length];
  const luckyColor = colors[Math.abs(seed * 5) % colors.length];
  const luckyDay   = days[Math.abs(seed * 3) % days.length];
  const element    = elements[Math.abs(seed * 7) % elements.length];
  const stone      = stones[Math.abs(seed * 11) % stones.length];

  const loveTexts = [
    'ดาวศุกร์ส่องแสงให้ท่าน ความรักกำลังจะเบ่งบาน เปิดใจรับสิ่งดีๆ ที่กำลังจะมา',
    'ช่วงนี้ความสัมพันธ์มีความอบอุ่น คนรักเข้าใจท่านมากขึ้น',
    'โอกาสพบเจอคนพิเศษใกล้เข้ามา จงเปิดใจและแสดงตัวตนที่แท้จริง',
    'ความรักต้องการเวลา อย่าเร่งรีบ ผลลัพธ์ที่ดีกำลังรอท่านอยู่',
  ];
  const workTexts = [
    'ดาวพฤหัสเสริมดวงการงาน โปรเจกต์ที่ค้างอยู่จะคืบหน้า ผู้ใหญ่ให้การสนับสนุน',
    'ความพยายามของท่านกำลังจะออกดอกผล ความสำเร็จอยู่ไม่ไกล',
    'ช่วงนี้เหมาะกับการเริ่มต้นสิ่งใหม่ ความคิดสร้างสรรค์จะนำพาความก้าวหน้า',
    'ระวังความขัดแย้งในที่ทำงาน ใช้ความสุขุมและเหตุผลในการแก้ปัญหา',
  ];
  const moneyTexts = [
    'ดาวเสาร์เปิดทางการเงิน รายได้พิเศษอาจเข้ามาในช่วงนี้ แต่ควรวางแผนการใช้จ่าย',
    'โชคลาภมีโอกาสเข้ามา แต่ต้องระวังการลงทุนที่เสี่ยงเกินไป',
    'การออมเงินในช่วงนี้จะให้ผลดีในอนาคต ความมั่นคงทางการเงินกำลังก่อตัว',
    'ระวังรายจ่ายที่ไม่จำเป็น วางแผนการเงินให้รอบคอบก่อนตัดสินใจ',
  ];

  res.json({
    name, element, stone, luckyNumber: luckyNum, luckyColor, luckyDay,
    scores: { luck: luckScore, love: loveScore, work: workScore, money: moneyScore },
    messages: {
      love:  loveTexts[Math.abs(seed * 2) % loveTexts.length],
      work:  workTexts[Math.abs(seed * 4) % workTexts.length],
      money: moneyTexts[Math.abs(seed * 6) % moneyTexts.length],
    }
  });
});

// ════════════════════════════════════════════════════════════════
//  ADMIN AUTH
// ════════════════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/admin/me', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// ════════════════════════════════════════════════════════════════
//  ADMIN DATA API  (protected)
// ════════════════════════════════════════════════════════════════

// Stats summary
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const total        = db.prepare('SELECT COUNT(*) as c FROM responses').get().c;
  const today        = db.prepare("SELECT COUNT(*) as c FROM responses WHERE date(created_at) = date('now','localtime')").get().c;
  const week         = db.prepare("SELECT COUNT(*) as c FROM responses WHERE created_at >= datetime('now','-7 days','localtime')").get().c;
  const latest       = db.prepare('SELECT created_at FROM responses ORDER BY created_at DESC LIMIT 1').get();
  const totalViews   = db.prepare('SELECT COUNT(*) as c FROM fortune_logs').get().c;
  const todayViews   = db.prepare("SELECT COUNT(*) as c FROM fortune_logs WHERE date(viewed_at) = date('now','localtime')").get().c;
  res.json({ total, today, week, latest: latest ? latest.created_at : null, totalViews, todayViews });
});

// Fortune stats — top viewers + daily trend
app.get('/api/admin/fortune-stats', requireAdmin, (req, res) => {
  // Top 10 most viewed
  const topViewers = db.prepare(`
    SELECT r.id, r.name, r.phone, r.email,
           COUNT(fl.id) as view_count,
           MAX(fl.viewed_at) as last_viewed
    FROM responses r
    LEFT JOIN fortune_logs fl ON fl.response_id = r.id
    GROUP BY r.id
    ORDER BY view_count DESC
    LIMIT 10
  `).all();

  // Daily views last 14 days
  const dailyViews = db.prepare(`
    SELECT date(viewed_at,'localtime') as day, COUNT(*) as count
    FROM fortune_logs
    WHERE viewed_at >= datetime('now','-13 days','localtime')
    GROUP BY day
    ORDER BY day ASC
  `).all();

  // Total views
  const totalViews = db.prepare('SELECT COUNT(*) as c FROM fortune_logs').get().c;
  const uniqueViewers = db.prepare('SELECT COUNT(DISTINCT response_id) as c FROM fortune_logs').get().c;
  const avgViews = uniqueViewers > 0 ? (totalViews / uniqueViewers).toFixed(1) : 0;

  // Most active hour
  const peakHour = db.prepare(`
    SELECT strftime('%H',viewed_at,'localtime') as hour, COUNT(*) as count
    FROM fortune_logs GROUP BY hour ORDER BY count DESC LIMIT 1
  `).get();

  res.json({ topViewers, dailyViews, totalViews, uniqueViewers, avgViews, peakHour });
});

// Paginated + searchable list
app.get('/api/admin/responses', requireAdmin, (req, res) => {
  const page    = Math.max(1, parseInt(req.query.page)  || 1);
  const limit   = Math.min(100, parseInt(req.query.limit) || 20);
  const search  = (req.query.search || '').trim();
  const offset  = (page - 1) * limit;

  let where = '';
  let params = [];
  if (search) {
    where = "WHERE name LIKE ? OR email LIKE ? OR phone LIKE ?";
    const q = `%${search}%`;
    params = [q, q, q];
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM responses ${where}`).get(...params).c;
  const rows  = db.prepare(`SELECT * FROM responses ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);

  res.json({ total, page, limit, pages: Math.ceil(total / limit), rows });
});

// Delete single
app.delete('/api/admin/responses/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const info = db.prepare('DELETE FROM responses WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
  res.json({ success: true });
});

// Delete all
app.delete('/api/admin/responses', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM responses').run();
  db.prepare("DELETE FROM sqlite_sequence WHERE name='responses'").run();
  res.json({ success: true });
});

// Export CSV
app.get('/api/admin/export', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM responses ORDER BY created_at ASC').all();
  const header = 'ID,ชื่อ-นามสกุล,อีเมล์,เบอร์โทร,วันที่\n';
  const csvEsc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const body = rows.map(r =>
    [r.id, csvEsc(r.name), csvEsc(r.email), csvEsc(r.phone), csvEsc(r.created_at)].join(',')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="survey_responses.csv"');
  res.send('\uFEFF' + header + body); // BOM for Excel Thai
});

// ── Serve admin page ─────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Start ────────────────────────────────────────────────────────
const PORT    = 3000;
const WS_PORT = 3001;

const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Admin panel  at http://localhost:${PORT}/admin`);
});

// ── Hot Reload via WebSocket ─────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT });

function broadcast(msg) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

chokidar.watch(path.join(__dirname, 'public'), {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 50 }
}).on('all', (event, filePath) => {
  const rel = path.relative(__dirname, filePath);
  console.log(`[hot] ${event}: ${rel}`);
  broadcast(JSON.stringify({ type: 'reload', file: rel }));
});

console.log(`Hot reload WS at ws://localhost:${WS_PORT}`);
