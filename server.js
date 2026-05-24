require('dotenv').config();
const express = require('express');
const https = require('https');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { execSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const dbPath = path.join(__dirname, 'canvas.db');
for (const suffix of ['', '-shm', '-wal']) {
  try { fs.unlinkSync(dbPath + suffix); } catch {}
}
execSync('node init_db.js', { cwd: __dirname, stdio: 'inherit' });

const app = express();
const db = new Database(dbPath, { readonly: false });
db.pragma('journal_mode = WAL');

const jwtSecret = process.env.JWT_SECRET;
const accessExp = process.env.JWT_ACCESS_TOKEN_EXPIRES_IN || '15m';
const refreshExp = process.env.JWT_REFRESH_TOKEN_EXPIRES_IN || '7d';
const port = process.env.PORT || 3000;
const appOrigin = `https://localhost:${port}`;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// CORS - restrict to same origin only
app.use((req, res, next) => {
  const reqOrigin = req.headers.origin;
  if (reqOrigin === appOrigin) {
    res.setHeader('Access-Control-Allow-Origin', appOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  next();
});

// CSRF - reject state-changing requests from foreign origins
app.use((req, res, next) => {
  const mutatingMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];
  if (mutatingMethods.includes(req.method)) {
    const reqOrigin = req.headers.origin;
    if (reqOrigin && reqOrigin !== appOrigin) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }
  next();
});

// Content Security Policy
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'");
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Compare plaintext password against stored hash
function checkPassword(plain, storedHash) {
  const [salt, expected] = storedHash.split(':');
  const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(derived, 'hex'));
}

// JWT auth middleware
function requireAuth(req, res, next) {
  const { accessToken } = req.cookies;
  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(accessToken, jwtSecret, { algorithms: ['HS256'] });
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Login
app.post('/api/login', (req, res) => {
  const { uid, password } = req.body;
  const row = db.prepare('SELECT uid, name, password, role FROM login WHERE uid = ?').get(uid);
  if (!row || !checkPassword(password, row.password)) {
    return res.status(401).json({ error: 'Invalid UID or password' });
  }

  const tokenData = { uid: row.uid, name: row.name, role: row.role };
  const access = jwt.sign(tokenData, jwtSecret, { expiresIn: accessExp });
  const refresh = jwt.sign({ uid: row.uid }, jwtSecret, { expiresIn: refreshExp });

  const cookieOpts = { httpOnly: true, secure: true, sameSite: 'Strict' };
  res.cookie('accessToken', access, cookieOpts);
  res.cookie('refreshToken', refresh, cookieOpts);

  res.json({ uid: row.uid, name: row.name, role: row.role });
});

// Refresh token
app.post('/api/refresh', (req, res) => {
  const { refreshToken } = req.cookies;
  if (!refreshToken) return res.status(401).json({ error: 'No refresh token' });
  try {
    const decoded = jwt.verify(refreshToken, jwtSecret, { algorithms: ['HS256'] });
    const row = db.prepare('SELECT uid, name, role FROM login WHERE uid = ?').get(decoded.uid);
    if (!row) return res.status(401).json({ error: 'User not found' });

    const tokenData = { uid: row.uid, name: row.name, role: row.role };
    const access = jwt.sign(tokenData, jwtSecret, { expiresIn: accessExp });

    res.cookie('accessToken', access, { httpOnly: true, secure: true, sameSite: 'Strict' });
    res.json({ uid: row.uid, name: row.name, role: row.role });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('accessToken');
  res.clearCookie('refreshToken');
  res.json({ success: true });
});

// Get enrolled courses - students only see their own
app.get('/api/students/:uid/courses', requireAuth, (req, res) => {
  if (req.user.uid !== req.params.uid) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const results = db.prepare(`
    SELECT course_id, course_code, course_title, instructor
    FROM student_courses
    WHERE login_uid = ?
  `).all(req.params.uid);
  res.json(results);
});

// Get course content - only enrolled students or teaching professor
app.get('/api/courses/:courseId/content', requireAuth, (req, res) => {
  const { courseId } = req.params;
  const enrolled = db.prepare('SELECT 1 FROM enrollment WHERE login_uid = ? AND course_id = ?').get(req.user.uid, courseId);
  const teaches = db.prepare('SELECT 1 FROM course WHERE id = ? AND professor_uid = ?').get(courseId, req.user.uid);
  if (!enrolled && !teaches) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const results = db.prepare(`
    SELECT week_id, week_title, week_sort, entry_id, entry_title, entry_type, entry_url, entry_sort
    FROM course_content
    WHERE course_id = ?
    ORDER BY week_sort, entry_sort
  `).all(courseId);
  res.json(results);
});

// Get courses taught by a professor
app.get('/api/professors/:uid/courses', requireAuth, (req, res) => {
  if (req.user.uid !== req.params.uid || req.user.role !== 'professor') {
    return res.status(403).json({ error: 'Access denied' });
  }
  const results = db.prepare(`
    SELECT course_id, course_code, course_title, instructor
    FROM professor_courses
    WHERE professor_uid = ?
  `).all(req.params.uid);
  res.json(results);
});

// Get enrolled students for a course - only teaching professor
app.get('/api/courses/:courseId/students', requireAuth, (req, res) => {
  const { courseId } = req.params;
  const teaches = db.prepare('SELECT 1 FROM course WHERE id = ? AND professor_uid = ?').get(courseId, req.user.uid);
  if (!teaches) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const results = db.prepare(`
    SELECT uid, name
    FROM course_students
    WHERE course_id = ?
    ORDER BY name
  `).all(courseId);
  res.json(results);
});

// Get grades - student sees own, professor sees students in their course
app.get('/api/students/:uid/courses/:courseId/grades', requireAuth, (req, res) => {
  const { uid, courseId } = req.params;
  const ownsData = req.user.uid === uid;
  const teaches = db.prepare('SELECT 1 FROM course WHERE id = ? AND professor_uid = ?').get(courseId, req.user.uid);
  if (!ownsData && !teaches) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const results = db.prepare(`
    SELECT grade_id, assignment_id, assignment_name, score
    FROM student_grades
    WHERE login_uid = ? AND course_id = ?
    ORDER BY sort_order
  `).all(uid, courseId);
  res.json(results);
});

// Search course materials - safe from command injection via execFileSync
app.get('/api/search', requireAuth, (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ files: [] });
  try {
    const raw = execFileSync('grep', ['-rl', q, 'public/'], { cwd: __dirname }).toString();
    const matches = raw.trim().split('\n').filter(Boolean);
    res.json({ files: matches });
  } catch (e) {
    res.json({ files: [] });
  }
});

// Update grades - professors only
app.post('/api/grades', requireAuth, (req, res) => {
  if (req.user.role !== 'professor') {
    return res.status(403).json({ error: 'Only professors can update grades' });
  }
  const { grades } = req.body;
  const updateNorm = db.prepare('UPDATE grade SET score = ? WHERE id = ?');
  const updateDenorm = db.prepare('UPDATE student_grades SET score = ? WHERE grade_id = ?');
  const save = db.transaction(() => {
    for (const g of grades) {
      updateNorm.run(g.score, g.grade_id);
      updateDenorm.run(g.score, g.grade_id);
    }
  });
  save();
  res.json({ success: true });
});

// HTTPS server
const tlsCert = {
  key: fs.readFileSync(path.join(__dirname, 'localhost-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'localhost.pem')),
};

const server = https.createServer(tlsCert, app).listen(port, () => {
  console.log(`Server running on https://localhost:${port}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try: PORT=3001 node server.js`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
