const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const initSqlJs = require('sql.js');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.FLY_APP_NAME
  ? '/data/quitbuddy.db'
  : path.join(__dirname, 'quitbuddy.db');

let db;

// ── Database Setup ──────────────────────────────────────────
async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      daily_limit INTEGER DEFAULT 20,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS cigarette_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      logged_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS friendships (
      user_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, friend_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (friend_id) REFERENCES users(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (sender_id) REFERENCES users(id),
      FOREIGN KEY (receiver_id) REFERENCES users(id)
    )
  `);
  saveDB();
  console.log('📦 Database initialized');
}

function saveDB() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Helper: query returning rows
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDB();
}

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth Routes ─────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, daily_limit } = req.body;
  if (!username || username.length < 2 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 2-20 characters' });
  }
  const existing = queryOne('SELECT * FROM users WHERE username = ?', [username]);
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  const id = uuidv4();
  run('INSERT INTO users (id, username, daily_limit) VALUES (?, ?, ?)', [id, username, daily_limit || 20]);
  const user = queryOne('SELECT * FROM users WHERE id = ?', [id]);
  res.json({ user });
});

app.post('/api/login', (req, res) => {
  const { username } = req.body;
  const user = queryOne('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// ── User Routes ─────────────────────────────────────────────
app.get('/api/user/:id', (req, res) => {
  const user = queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const todayCount = (queryOne(
    'SELECT COUNT(*) as count FROM cigarette_logs WHERE user_id = ? AND date(logged_at) = date("now")',
    [req.params.id]
  ) || { count: 0 }).count;
  const weekData = queryAll(
    'SELECT date(logged_at) as day, COUNT(*) as count FROM cigarette_logs WHERE user_id = ? AND logged_at >= datetime("now", "-7 days") GROUP BY date(logged_at) ORDER BY day',
    [req.params.id]
  );
  const totalSmokeDays = (queryOne(
    'SELECT COUNT(DISTINCT date(logged_at)) as count FROM cigarette_logs WHERE user_id = ?',
    [req.params.id]
  ) || { count: 0 }).count;
  const allTime = (queryOne(
    'SELECT COUNT(*) as count FROM cigarette_logs WHERE user_id = ?',
    [req.params.id]
  ) || { count: 0 }).count;
  const bestRow = queryOne(
    'SELECT MIN(day_count) as best FROM (SELECT COUNT(*) as day_count FROM cigarette_logs WHERE user_id = ? GROUP BY date(logged_at))',
    [req.params.id]
  );
  res.json({
    user,
    todayCount,
    weekData,
    stats: { totalSmokeDays, allTime, bestDay: bestRow?.best || 0 }
  });
});

app.put('/api/user/:id/limit', (req, res) => {
  const { daily_limit } = req.body;
  if (!daily_limit || daily_limit < 1 || daily_limit > 100) {
    return res.status(400).json({ error: 'Limit must be 1-100' });
  }
  run('UPDATE users SET daily_limit = ? WHERE id = ?', [daily_limit, req.params.id]);
  res.json({ ok: true });
});

app.put('/api/user/:id/username', (req, res) => {
  const { username } = req.body;
  if (!username || username.length < 2 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 2-20 characters' });
  }
  const existing = queryOne('SELECT * FROM users WHERE username = ?', [username]);
  if (existing && existing.id !== req.params.id) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  run('UPDATE users SET username = ? WHERE id = ?', [username, req.params.id]);
  res.json({ ok: true });
});

// ── Cigarette Routes ────────────────────────────────────────
app.post('/api/cig/add', (req, res) => {
  const { user_id } = req.body;
  run('INSERT INTO cigarette_logs (user_id, logged_at) VALUES (?, datetime("now"))', [user_id]);
  const todayCount = (queryOne(
    'SELECT COUNT(*) as count FROM cigarette_logs WHERE user_id = ? AND date(logged_at) = date("now")',
    [user_id]
  ) || { count: 0 }).count;
  const user = queryOne('SELECT daily_limit FROM users WHERE id = ?', [user_id]);
  res.json({ todayCount, daily_limit: user?.daily_limit || 20 });
});

app.post('/api/cig/remove', (req, res) => {
  const { user_id } = req.body;
  const last = queryOne(
    'SELECT id FROM cigarette_logs WHERE user_id = ? ORDER BY logged_at DESC LIMIT 1',
    [user_id]
  );
  if (last) {
    run('DELETE FROM cigarette_logs WHERE id = ?', [last.id]);
  }
  const todayCount = (queryOne(
    'SELECT COUNT(*) as count FROM cigarette_logs WHERE user_id = ? AND date(logged_at) = date("now")',
    [user_id]
  ) || { count: 0 }).count;
  const user = queryOne('SELECT daily_limit FROM users WHERE id = ?', [user_id]);
  res.json({ todayCount, daily_limit: user?.daily_limit || 20 });
});

// ── Friend Routes ───────────────────────────────────────────
app.post('/api/friends/add', (req, res) => {
  const { user_id, friend_id } = req.body;
  if (user_id === friend_id) return res.status(400).json({ error: "Can't add yourself" });
  const friend = queryOne('SELECT * FROM users WHERE id = ?', [friend_id]);
  if (!friend) return res.status(404).json({ error: 'User not found' });
  // Check if already friends
  const existing = queryOne('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?', [user_id, friend_id]);
  if (!existing) {
    run('INSERT INTO friendships (user_id, friend_id) VALUES (?, ?)', [user_id, friend_id]);
    run('INSERT INTO friendships (user_id, friend_id) VALUES (?, ?)', [friend_id, user_id]);
  }
  res.json({ ok: true, friend: { id: friend.id, username: friend.username } });
});

app.get('/api/friends/:userId', (req, res) => {
  const friends = queryAll(
    'SELECT u.id, u.username FROM users u JOIN friendships f ON u.id = f.friend_id WHERE f.user_id = ?',
    [req.params.userId]
  );
  res.json({ friends });
});

app.get('/api/friends/:userId/progress', (req, res) => {
  const friends = queryAll(`
    SELECT u.id, u.username, u.daily_limit,
      (SELECT COUNT(*) FROM cigarette_logs WHERE user_id = u.id AND date(logged_at) = date('now')) as today_count
    FROM users u JOIN friendships f ON u.id = f.friend_id WHERE f.user_id = ?
  `, [req.params.userId]);
  res.json({ friends });
});

app.get('/api/search-users', (req, res) => {
  const { q, user_id } = req.query;
  if (!q || q.length < 2) return res.json({ users: [] });
  const users = queryAll(
    'SELECT id, username FROM users WHERE username LIKE ? AND id != ? LIMIT 10',
    [`%${q}%`, user_id]
  );
  res.json({ users });
});

// ── Chat Routes ─────────────────────────────────────────────
app.get('/api/messages/:userId/:friendId', (req, res) => {
  const messages = queryAll(`
    SELECT m.*, u.username as sender_name FROM messages m
    JOIN users u ON m.sender_id = u.id
    WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
    ORDER BY m.created_at ASC LIMIT 100
  `, [req.params.userId, req.params.friendId, req.params.friendId, req.params.userId]);
  res.json({ messages });
});

// ── Socket.io Chat ──────────────────────────────────────────
const onlineUsers = new Map();

io.on('connection', (socket) => {
  socket.on('user-online', (userId) => {
    onlineUsers.set(socket.id, userId);
    io.emit('user-status', { userId, online: true });
  });

  socket.on('send-message', ({ sender_id, receiver_id, content }) => {
    run('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)', [sender_id, receiver_id, content]);
    for (const [sid, uid] of onlineUsers) {
      if (uid === receiver_id) {
        io.to(sid).emit('new-message', { sender_id, receiver_id, content, created_at: new Date().toISOString() });
      }
    }
    socket.emit('message-sent', { sender_id, receiver_id, content, created_at: new Date().toISOString() });
  });

  socket.on('disconnect', () => {
    const userId = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    if (userId) io.emit('user-status', { userId, online: false });
  });
});

// ── SPA Fallback ────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ───────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`🚭 QuitBuddy running at http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
