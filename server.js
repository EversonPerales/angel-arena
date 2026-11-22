require('dotenv').config();
const fs = require('fs');
const zlib = require('zlib');
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { Server } = require('socket.io');

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Promesa rechazada no controlada:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Excepción no controlada:', err && err.message ? err.message : err);
});

const app = express();
// Necesario detrás de Cloudflare y el proxy inverso (Traefik/Caddy) de Coolify o Dokploy
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  pingInterval: 15000,
  pingTimeout: 10000
});

// Conexión a PostgreSQL compatible con Coolify, Dokploy, Docker Compose y Railway
function createDbPool(forceSsl) {
  if (!process.env.DATABASE_URL) return null;
  const url = process.env.DATABASE_URL;
  const useSsl =
    typeof forceSsl === 'boolean'
      ? forceSsl
      : process.env.DB_SSL === 'true' ||
        url.includes('sslmode=require') ||
        Boolean(process.env.RAILWAY_ENVIRONMENT);

  const newPool = new Pool({
    connectionString: url,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    max: parseInt(process.env.DB_POOL_MAX || '20', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
  newPool.on('error', (err) => {
    console.error('⚠️ Error inesperado en conexión inactiva de PostgreSQL:', err.message);
  });
  return newPool;
}

let pool = createDbPool();

let dbReady = false;
const JWT_SECRET = process.env.JWT_SECRET || 'clave_secreta_super_segura_cambiar_en_railway';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Extrae el ID numérico tanto de 'team-1' / 'p-5' como de '1' / 1
function parseId(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/^[a-z]+-/i, '');
  const num = parseInt(cleaned, 10);
  return Number.isNaN(num) ? null : num;
}

// ==========================================
// INICIALIZACIÓN OFICIAL DE POSTGRESQL (PRODUCCIÓN LIMPIA SIN DEMO)
// ==========================================
async function ensureOfficialAccounts(client) {
  const adminPassPlain = process.env.ADMIN_PASSWORD || 'admin123';
  const refPassPlain = process.env.REF_PASSWORD || 'ref123';
  const passAdmin = await bcrypt.hash(adminPassPlain, 10);
  const passRef = await bcrypt.hash(refPassPlain, 10);

  const officialUsers = [
    ['Organizador General — Liga F7 Caracas', 'admin@ligaf7caracas.com', passAdmin, 'admin'],
    ['Organizador General — Liga F7 Caracas', 'admin@angelarena.com', passAdmin, 'admin'],
    ['Árbitro Oficial — Liga F7 Caracas', 'arbitro@ligaf7caracas.com', passRef, 'referee'],
    ['Árbitro Oficial — Liga F7 Caracas', 'ref@angelarena.com', passRef, 'referee']
  ];

  for (const [name, email, hash, role] of officialUsers) {
    await client.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role`,
      [name, email, hash, role]
    );
  }
}

async function initDatabase() {
  if (!pool) {
    console.log('ℹ️ Sin DATABASE_URL configurada: operando en modo autónomo.');
    return;
  }

  for (let attempt = 1; attempt <= 6; attempt++) {
    let client;
    try {
      client = await pool.connect();
      const schemaPath = path.join(__dirname, 'db', 'schema.sql');
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      await client.query(schemaSql);

      // Migraciones seguras por si las tablas ya existían de una versión previa
      await client.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS short_name VARCHAR(10) NOT NULL DEFAULT 'CLB'`);
      await client.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS logo_url TEXT`);
      await client.query(`ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_owner_id_key`);
      await client.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS parent_team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE`);
      await client.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS category_label VARCHAR(50) DEFAULT 'Categoría Libre'`);
      await client.query(`ALTER TABLE teams ALTER COLUMN pitch_mode TYPE VARCHAR(10)`);
      await client.query(`ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_pitch_mode_check`);
      await client.query(`ALTER TABLE teams ADD CONSTRAINT teams_pitch_mode_check CHECK (pitch_mode IN ('5v5', '7v7', '11v11'))`);
      await client.query(`ALTER TABLE tournaments ALTER COLUMN pitch_size TYPE VARCHAR(10)`);
      await client.query(`ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_pitch_size_check`);
      await client.query(`ALTER TABLE tournaments ADD CONSTRAINT tournaments_pitch_size_check CHECK (pitch_size IN ('5v5', '7v7', '11v11'))`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS first_name VARCHAR(80)`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS last_name VARCHAR(80)`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS birth_date VARCHAR(25)`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS id_number VARCHAR(30)`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS school_join_date VARCHAR(25)`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS rep_id_number VARCHAR(30)`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS has_special_condition BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS special_condition_detail TEXT`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS photo_url TEXT`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS birth_cert_doc TEXT`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS player_id_doc TEXT`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS rep_id_doc TEXT`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS special_condition_doc TEXT`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS doc_status VARCHAR(20) DEFAULT 'approved'`);
      await client.query(`ALTER TABLE players ALTER COLUMN coord_x DROP DEFAULT`);
      await client.query(`ALTER TABLE players ALTER COLUMN coord_y DROP DEFAULT`);
      await client.query(`ALTER TABLE tournaments ALTER COLUMN start_date TYPE VARCHAR(40) USING start_date::text`);
      await client.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS registration_fee VARCHAR(50) DEFAULT '$150 USD'`);
      await client.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS referee_fee VARCHAR(50) DEFAULT '$20 USD'`);
      await client.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS category_label VARCHAR(50) DEFAULT 'Categoría Libre'`);
      await client.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS mvp_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL`);
      await client.query(`ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_status_check`);
      await client.query(`ALTER TABLE matches ADD CONSTRAINT matches_status_check CHECK (status IN ('scheduled', 'live', 'finished', 'suspended'))`);
      await client.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS suspension_reason TEXT`);
      await client.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS forfeit_winner_id INTEGER REFERENCES teams(id) ON DELETE SET NULL`);
      await client.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS home_penalties INTEGER DEFAULT NULL`);
      await client.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS away_penalties INTEGER DEFAULT NULL`);
      await client.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS penalties_log TEXT`);
      await client.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS clock_running BOOLEAN DEFAULT FALSE`);
      await client.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS clock_started_at BIGINT DEFAULT NULL`);
      await client.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS clock_elapsed_sec INTEGER DEFAULT 0`);
      await client.query(`ALTER TABLE club_payments ADD COLUMN IF NOT EXISTS match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE`);
      await client.query(`ALTER TABLE club_payments ALTER COLUMN concept TYPE VARCHAR(160)`);
      await client.query(`ALTER TABLE club_payments ALTER COLUMN payment_date TYPE VARCHAR(40)`);
      await client.query(`ALTER TABLE club_payments DROP CONSTRAINT IF EXISTS club_payments_status_check`);
      await client.query(`ALTER TABLE club_payments ADD CONSTRAINT club_payments_status_check CHECK (status IN ('unpaid', 'pending', 'approved', 'rejected'))`);
      await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS goals_conceded INTEGER DEFAULT 0`);
      await client.query(`ALTER TABLE match_events ADD COLUMN IF NOT EXISTS conceded_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL`);

      await client.query('BEGIN');
      // Si existían los equipos de prueba de la versión demo previa, limpiarlos automáticamente para dejar la base oficial en limpio
      const demoCheck = await client.query(
        "SELECT COUNT(*) FROM teams WHERE name IN ('Atlético Central FC', 'Rayo Norte FC', 'Inter Urbano FC', 'Furia Roja FC')"
      );
      if (parseInt(demoCheck.rows[0].count, 10) > 0) {
        await client.query(`
          TRUNCATE TABLE match_events, matches, club_payments, club_staff, players, tournament_registrations, tournaments, teams, users, audit_logs
          RESTART IDENTITY CASCADE
        `);
        console.log('🧹 Datos demo previos eliminados para lanzamiento oficial en producción.');
      }

      await ensureOfficialAccounts(client);
      await client.query('COMMIT');
      console.log('✅ Base de datos PostgreSQL de Liga F7 Caracas lista en modo oficial de producción.');
      dbReady = true;
      return;
    } catch (err) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (_) {}
      }
      const msg = String(err.message || '');
      // Si el contenedor de Postgres en Coolify/Dokploy no usa SSL (o viceversa), ajusta automáticamente
      if (msg.includes('does not support SSL')) {
        pool = createDbPool(false);
        continue;
      }
      if (msg.includes('SSL/TLS required') || msg.includes('no pg_hba.conf entry')) {
        pool = createDbPool(true);
        continue;
      }
      console.warn(`⏳ Intento ${attempt}/6 conectando a PostgreSQL: ${msg}`);
      await new Promise((r) => setTimeout(r, 2500));
    } finally {
      if (client) client.release();
    }
  }
  console.error('⚠️ No se pudo inicializar PostgreSQL tras varios intentos.');
}

async function getFullState(clientOrPool = pool) {
  const [tournamentsRes, regRes, teamsRes, playersRes, staffRes, paymentsRes, matchesRes, eventsRes, refsRes] = await Promise.all([
    clientOrPool.query('SELECT * FROM tournaments ORDER BY id DESC'),
    clientOrPool.query("SELECT * FROM tournament_registrations WHERE status = 'approved' ORDER BY registered_at ASC"),
    clientOrPool.query('SELECT tm.*, u.email AS owner_email FROM teams tm LEFT JOIN users u ON tm.owner_id = u.id ORDER BY tm.id ASC'),
    clientOrPool.query(`
      SELECT id, team_id, full_name, first_name, last_name, birth_date, id_number, school_join_date, rep_id_number,
             has_special_condition, special_condition_detail, photo_url,
             (birth_cert_doc IS NOT NULL AND birth_cert_doc <> '') AS has_birth_cert,
             (player_id_doc IS NOT NULL AND player_id_doc <> '') AS has_player_id_doc,
             (rep_id_doc IS NOT NULL AND rep_id_doc <> '') AS has_rep_id_doc,
             (special_condition_doc IS NOT NULL AND special_condition_doc <> '') AS has_special_doc,
             doc_status, dorsal, position, status, is_starter, coord_x, coord_y, sort_order
      FROM players ORDER BY team_id ASC, sort_order ASC, id ASC
    `),
    clientOrPool.query(`
      SELECT id, team_id, first_name, last_name, role_title, id_number, birth_date, phone, join_date,
             (id_doc IS NOT NULL AND id_doc <> '') AS has_id_doc,
             (license_doc IS NOT NULL AND license_doc <> '') AS has_license_doc
      FROM club_staff ORDER BY team_id ASC, id ASC
    `),
    clientOrPool.query(`
      SELECT id, team_id, tournament_id, match_id, concept, amount, method, reference, payment_date, status,
             (receipt_doc IS NOT NULL AND receipt_doc <> '') AS has_receipt_doc
      FROM club_payments ORDER BY id DESC
    `),
    clientOrPool.query('SELECT * FROM matches ORDER BY id ASC'),
    clientOrPool.query('SELECT * FROM match_events ORDER BY id ASC'),
    clientOrPool.query("SELECT id, name, email FROM users WHERE role = 'referee' ORDER BY id ASC")
  ]);

  const regsByTourney = {};
  for (const r of regRes.rows) {
    const key = r.tournament_id;
    if (!regsByTourney[key]) regsByTourney[key] = [];
    regsByTourney[key].push('team-' + r.team_id);
  }

  return {
    referees: refsRes.rows.map((rf) => ({
      id: 'ref-' + rf.id,
      name: rf.name,
      email: rf.email
    })),
    tournaments: tournamentsRes.rows.map((t) => {
      let inferredCat = t.category_label;
      if (!inferredCat && t.format) {
        const mFmt = String(t.format).match(/\(([^)]+)\)/);
        if (mFmt) inferredCat = mFmt[1];
      }
      return {
        id: 'tour-' + t.id,
        name: t.name,
        pitchSize: t.pitch_size,
        category: inferredCat || 'Categoría Libre',
        format: t.format,
        maxTeams: t.max_teams,
        startDate: String(t.start_date),
        prize: t.prize || '',
        registrationFee: t.registration_fee || '$150 USD',
        refereeFee: t.referee_fee || '$20 USD',
        status: t.status,
        teamIds: regsByTourney[t.id] || []
      };
    }),
    teams: teamsRes.rows.map((tm) => ({
      id: 'team-' + tm.id,
      parentTeamId: tm.parent_team_id ? 'team-' + tm.parent_team_id : null,
      category: tm.category_label || 'Categoría Libre',
      name: tm.name,
      shortName: tm.short_name || tm.name.substring(0, 3).toUpperCase(),
      coach: tm.coach_name,
      email: tm.owner_email || '',
      color: tm.primary_color || '#10B981',
      logoUrl: tm.logo_url || null,
      pitchMode: tm.pitch_mode || '5v5',
      formation: tm.formation || (tm.pitch_mode === '11v11' ? '4-3-3' : tm.pitch_mode === '7v7' ? '2-3-1' : '1-2-1')
    })),
    players: playersRes.rows.map((p) => {
      const parts = (p.full_name || '').split(' ');
      return {
        id: 'p-' + p.id,
        teamId: 'team-' + p.team_id,
        number: p.dorsal,
        name: p.full_name,
        firstName: p.first_name || parts[0] || p.full_name,
        lastName: p.last_name || parts.slice(1).join(' ') || '',
        birthDate: p.birth_date || '2006-05-14',
        idNumber: p.id_number || '',
        schoolJoinDate: p.school_join_date || '2024-03-01',
        repIdNumber: p.rep_id_number || '',
        hasSpecialCondition: Boolean(p.has_special_condition),
        specialConditionDetail: p.special_condition_detail || '',
        photoUrl: p.photo_url || null,
        hasBirthCert: Boolean(p.has_birth_cert),
        hasPlayerIdDoc: Boolean(p.has_player_id_doc),
        hasRepIdDoc: Boolean(p.has_rep_id_doc),
        hasSpecialDoc: Boolean(p.has_special_doc),
        docStatus: p.doc_status || 'approved',
        pos: p.position,
        status: p.status,
        starter: p.is_starter,
        customX: p.coord_x !== null ? Number(p.coord_x) : null,
        customY: p.coord_y !== null ? Number(p.coord_y) : null
      };
    }),
    staff: staffRes.rows.map((s) => ({
      id: 'st-' + s.id,
      teamId: 'team-' + s.team_id,
      firstName: s.first_name,
      lastName: s.last_name,
      name: `${s.first_name} ${s.last_name}`.trim(),
      roleTitle: s.role_title,
      idNumber: s.id_number,
      birthDate: s.birth_date || '',
      phone: s.phone || '',
      joinDate: s.join_date || '',
      hasIdDoc: Boolean(s.has_id_doc),
      hasLicenseDoc: Boolean(s.has_license_doc)
    })),
    payments: paymentsRes.rows.map((py) => ({
      id: 'pay-' + py.id,
      teamId: 'team-' + py.team_id,
      tournamentId: py.tournament_id ? 'tour-' + py.tournament_id : 'tour-1',
      matchId: py.match_id ? 'm-' + py.match_id : null,
      concept: py.concept,
      amount: py.amount,
      method: py.method || 'Por pagar',
      reference: py.reference || 'Sin comprobante',
      date: py.payment_date,
      hasReceiptDoc: Boolean(py.has_receipt_doc),
      status: py.status || 'unpaid'
    })),
    matches: matchesRes.rows.map((m) => {
      let parsedPenLog = [];
      if (m.penalties_log) {
        try {
          parsedPenLog = JSON.parse(m.penalties_log);
        } catch (e) {
          parsedPenLog = [];
        }
      }
      return {
        id: 'm-' + m.id,
        tournamentId: 'tour-' + m.tournament_id,
        round: m.round_name,
        homeId: 'team-' + m.home_team_id,
        awayId: 'team-' + m.away_team_id,
        homeScore: m.home_score,
        awayScore: m.away_score,
        status: m.status,
        period: m.period || '1T',
        minute: m.current_minute || 0,
        clockRunning: Boolean(m.clock_running),
        clockStartedAt: m.clock_started_at ? Number(m.clock_started_at) : null,
        clockElapsedSec: m.clock_elapsed_sec ? Number(m.clock_elapsed_sec) : 0,
        date: m.match_date,
        pitch: m.pitch_name,
        mvpPlayerId: m.mvp_player_id ? 'p-' + m.mvp_player_id : null,
        suspensionReason: m.suspension_reason || null,
        forfeitWinnerId: m.forfeit_winner_id ? 'team-' + m.forfeit_winner_id : null,
        homePenalties: m.home_penalties !== null && m.home_penalties !== undefined ? Number(m.home_penalties) : null,
        awayPenalties: m.away_penalties !== null && m.away_penalties !== undefined ? Number(m.away_penalties) : null,
        penaltiesLog: Array.isArray(parsedPenLog) ? parsedPenLog : []
      };
    }),
    events: eventsRes.rows.map((ev) => ({
      id: 'ev-' + ev.id,
      matchId: 'm-' + ev.match_id,
      teamId: 'team-' + ev.team_id,
      playerId: 'p-' + ev.player_id,
      concededPlayerId: ev.conceded_player_id ? 'p-' + ev.conceded_player_id : null,
      type: ev.event_type,
      minute: ev.minute
    }))
  };
}

// Caché en RAM pre-serializada y pre-comprimida (Gzip) para soportar alta concurrencia sin saturar PostgreSQL
let stateCache = null;
let stateBuildPromise = null;
let stateVersionCounter = 1;

function buildStateCacheEntry(fullState) {
  const publicState = sanitizeStateForVisitor(fullState, null);
  const fullJson = JSON.stringify(fullState);
  const publicJson = JSON.stringify(publicState);
  const fullGzip = zlib.gzipSync(fullJson);
  const publicGzip = zlib.gzipSync(publicJson);
  stateVersionCounter += 1;
  const entry = {
    version: stateVersionCounter,
    fullState,
    publicState,
    fullJson,
    publicJson,
    fullGzip,
    publicGzip,
    fullEtag: `"f-${stateVersionCounter}"`,
    publicEtag: `"p-${stateVersionCounter}"`
  };
  stateCache = entry;
  return entry;
}

async function getCachedState(forceRefresh = false) {
  if (!forceRefresh && stateCache) return stateCache;
  if (!forceRefresh && stateBuildPromise) return stateBuildPromise;
  const promise = getFullState()
    .then((fullState) => buildStateCacheEntry(fullState))
    .finally(() => {
      if (stateBuildPromise === promise) stateBuildPromise = null;
    });
  stateBuildPromise = promise;
  return promise;
}

function sendCachedStateResponse(req, res, entry, isAuth) {
  const etag = isAuth ? entry.fullEtag : entry.publicEtag;
  res.setHeader('ETag', etag);
  res.setHeader('Vary', 'Accept-Encoding, Authorization');
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (acceptEncoding.includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    return res.end(isAuth ? entry.fullGzip : entry.publicGzip);
  }
  return res.end(isAuth ? entry.fullJson : entry.publicJson);
}

async function broadcastState() {
  if (!dbReady) return null;
  const entry = await getCachedState(true);
  io.to('room:auth').emit('state_sync', entry.fullState);
  io.to('room:public').emit('state_sync', entry.publicState);
  return entry.fullState;
}

// ==========================================
// MIDDLEWARES DE SEGURIDAD (JWT & RBAC)
// ==========================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Acceso denegado. Token requerido.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Sesión expirada o inválida.' });
    req.user = user; // { id, email, role, teamId }
    next();
  });
}

function authorizeRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'No tienes permisos para realizar esta acción.' });
    }
    next();
  };
}

// ==========================================
// 0. ESTADO GLOBAL, PRIVACIDAD Y SALUD DEL SERVIDOR
// ==========================================
function getOptionalUserFromReq(req) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function sanitizeStateForVisitor(fullState, user) {
  if (user && (user.role === 'admin' || user.role === 'referee' || user.role === 'club')) {
    return fullState;
  }
  // Visitante sin login (Portal En Vivo / Verificador QR): ocultar correos, cédulas, teléfonos y pagos privados
  return {
    ...fullState,
    referees: [],
    payments: [],
    teams: (fullState.teams || []).map((tm) => ({
      ...tm,
      email: ''
    })),
    players: (fullState.players || []).map((p) => ({
      ...p,
      idNumber: '',
      repIdNumber: '',
      specialConditionDetail: ''
    })),
    staff: (fullState.staff || []).map((s) => ({
      ...s,
      idNumber: '',
      phone: ''
    }))
  };
}

// Limitador anti-fuerza bruta para /api/auth/login (máx. 12 intentos fallidos por IP en 15 min)
const loginAttemptStore = new Map();
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const entry = loginAttemptStore.get(ip);
  if (!entry || now - entry.firstAt > windowMs) {
    return { blocked: false };
  }
  if (entry.count >= 12) {
    const minsLeft = Math.max(1, Math.ceil((windowMs - (now - entry.firstAt)) / 60000));
    return { blocked: true, minsLeft };
  }
  return { blocked: false };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  if (loginAttemptStore.size > 5000) {
    for (const [key, val] of loginAttemptStore.entries()) {
      if (now - val.firstAt > windowMs) loginAttemptStore.delete(key);
    }
    if (loginAttemptStore.size > 5000) loginAttemptStore.clear();
  }
  const entry = loginAttemptStore.get(ip);
  if (!entry || now - entry.firstAt > windowMs) {
    loginAttemptStore.set(ip, { count: 1, firstAt: now });
  } else {
    entry.count += 1;
  }
}

function clearLoginFailures(ip) {
  loginAttemptStore.delete(ip);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, dbReady });
});

app.get('/api/players/:playerId/docs', authenticateToken, authorizeRoles('admin', 'referee', 'club'), async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const playerId = parseId(req.params.playerId);
    const r = await pool.query(
      'SELECT team_id, birth_cert_doc, player_id_doc, rep_id_doc, special_condition_doc FROM players WHERE id = $1',
      [playerId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Jugador no encontrado' });
    const row = r.rows[0];
    if (req.user.role === 'club') {
      const authTeamId = await resolveAuthorizedTeamId(req, row.team_id);
      if (!authTeamId) return res.status(403).json({ error: 'No tienes permisos para ver documentos de otro club.' });
    }
    res.json({
      birthCertDoc: row.birth_cert_doc || null,
      playerIdDoc: row.player_id_doc || null,
      repIdDoc: row.rep_id_doc || null,
      specialConditionDoc: row.special_condition_doc || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/staff/:staffId/docs', authenticateToken, authorizeRoles('admin', 'club'), async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const staffId = parseId(req.params.staffId);
    const r = await pool.query('SELECT team_id, id_doc, license_doc FROM club_staff WHERE id = $1', [staffId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Integrante no encontrado' });
    if (req.user.role === 'club') {
      const authTeamId = await resolveAuthorizedTeamId(req, r.rows[0].team_id);
      if (!authTeamId) return res.status(403).json({ error: 'No tienes permisos para ver documentos de otro club.' });
    }
    res.json({
      idDoc: r.rows[0].id_doc || null,
      licenseDoc: r.rows[0].license_doc || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/payments/:paymentId/receipt', authenticateToken, authorizeRoles('admin', 'club'), async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const paymentId = parseId(req.params.paymentId);
    const r = await pool.query('SELECT team_id, receipt_doc FROM club_payments WHERE id = $1', [paymentId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Pago no encontrado' });
    if (req.user.role === 'club') {
      const authTeamId = await resolveAuthorizedTeamId(req, r.rows[0].team_id);
      if (!authTeamId) return res.status(403).json({ error: 'No tienes permisos para ver comprobantes de otro club.' });
    }
    res.json({ receiptDoc: r.rows[0].receipt_doc || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/state', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const user = getOptionalUserFromReq(req);
    const isAuth = Boolean(user && (user.role === 'admin' || user.role === 'referee' || user.role === 'club'));
    const entry = await getCachedState(false);
    return sendCachedStateResponse(req, res, entry, isAuth);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system/reset', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      TRUNCATE TABLE match_events, matches, club_payments, club_staff, players, tournament_registrations, tournaments, teams
      RESTART IDENTITY CASCADE
    `);
    await client.query("DELETE FROM users WHERE role = 'club'");
    await ensureOfficialAccounts(client);
    await client.query('COMMIT');
    const state = await broadcastState();
    res.json({ message: 'Todos los datos de prueba fueron eliminados. Sistema limpio en 0.', state });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 1. AUTENTICACIÓN (LOGIN Y REGISTRO DE CLUB)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const clientIp = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const rateCheck = checkLoginRateLimit(clientIp);
    if (rateCheck.blocked) {
      return res.status(429).json({
        error: `Demasiados intentos fallidos. Intenta de nuevo en ${rateCheck.minsLeft} minuto(s).`
      });
    }

    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Debes ingresar tu correo y contraseña.' });
    }
    const userRes = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [String(email).trim()]);
    if (userRes.rows.length === 0) {
      recordLoginFailure(clientIp);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const user = userRes.rows[0];
    const validPass = await bcrypt.compare(password, user.password_hash);
    if (!validPass) {
      recordLoginFailure(clientIp);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    clearLoginFailures(clientIp);

    // Si es dueño de equipo, buscamos su club principal asignado
    let numericTeamId = null;
    if (user.role === 'club') {
      const teamRes = await pool.query(
        'SELECT id FROM teams WHERE owner_id = $1 ORDER BY parent_team_id NULLS FIRST, id ASC LIMIT 1',
        [user.id]
      );
      if (teamRes.rows.length > 0) numericTeamId = teamRes.rows[0].id;
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role, teamId: numericTeamId },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    await pool.query(
      'INSERT INTO audit_logs (actor_email, actor_role, action_detail) VALUES ($1, $2, $3)',
      [user.email, user.role, 'Inicio de sesión exitoso']
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        teamId: numericTeamId ? 'team-' + numericTeamId : null
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/register-club', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const { clubName, shortName, coachName, pitchMode, primaryColor, email, password } = req.body;
  if (!clubName || !coachName || !email || !password) {
    return res.status(400).json({ error: 'Todos los campos del club (nombre, responsable, correo y contraseña) son obligatorios.' });
  }
  const client = await pool.connect();
  let numericTeamId = null;
  let newUser = null;
  try {
    await client.query('BEGIN');

    const hash = await bcrypt.hash(String(password).trim(), 10);
    const userIns = await client.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'club') RETURNING id, name, email, role`,
      [String(coachName).trim(), String(email).trim().toLowerCase(), hash]
    );
    newUser = userIns.rows[0];

    const mode = pitchMode === '11v11' ? '11v11' : pitchMode === '7v7' ? '7v7' : '5v5';
    const defaultFormation = mode === '11v11' ? '4-3-3' : mode === '7v7' ? '2-3-1' : '1-2-1';
    const cleanShort = (shortName || String(clubName).substring(0, 3) || 'CLB').toUpperCase().substring(0, 5);

    const teamIns = await client.query(
      `INSERT INTO teams (name, short_name, coach_name, owner_id, primary_color, pitch_mode, formation)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [String(clubName).trim(), cleanShort, String(coachName).trim(), newUser.id, primaryColor || '#10B981', mode, defaultFormation]
    );
    numericTeamId = teamIns.rows[0].id;

    await client.query(
      'INSERT INTO audit_logs (actor_email, actor_role, action_detail) VALUES ($1, $2, $3)',
      [req.user.email, 'admin', `Alta oficial de nuevo club: ${clubName} (${newUser.email})`]
    );

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Error en /api/auth/register-club:', err.message);
    if (err.code === '23505') {
      const detail = String(err.constraint || err.detail || '').toLowerCase();
      if (detail.includes('email')) {
        return res.status(400).json({ error: 'Ese correo de acceso ya está registrado en el sistema.' });
      }
      return res.status(400).json({ error: 'Ya existe un club registrado con ese mismo nombre.' });
    }
    return res.status(400).json({ error: err.message || 'No se pudo registrar el club.' });
  } finally {
    client.release();
  }

  try {
    const state = await broadcastState();
    return res.status(201).json({
      message: 'Club registrado oficialmente por el administrador',
      teamId: 'team-' + numericTeamId,
      clubCredentials: {
        clubName,
        coachName,
        email: newUser.email
      },
      state
    });
  } catch (err) {
    console.error('Error refrescando estado tras register-club:', err.message);
    return res.status(201).json({
      message: 'Club registrado oficialmente por el administrador',
      teamId: 'team-' + numericTeamId,
      clubCredentials: {
        clubName,
        coachName,
        email: newUser.email
      }
    });
  }
});

// ==========================================
// HELPER: VERIFICAR PROPIEDAD DE CLUB / SUB-EQUIPO Y RANGO DE EDAD POR CATEGORÍA
// ==========================================
async function resolveAuthorizedTeamId(req, requestedTeamId, clientOrPool = pool) {
  const rootTeamId = parseId(req.user.teamId);
  if (!requestedTeamId) return rootTeamId;
  const targetId = parseId(requestedTeamId);
  if (!targetId || targetId === rootTeamId) return rootTeamId;

  const check = await clientOrPool.query(
    'SELECT id FROM teams WHERE id = $1 AND (id = $2 OR parent_team_id = $2 OR owner_id = $3)',
    [targetId, rootTeamId, req.user.id]
  );
  if (check.rows.length === 0) return null;
  return targetId;
}

function getCategoryAgeBounds(categoryLabel) {
  const cat = String(categoryLabel || '').toLowerCase();
  const subMatch = cat.match(/sub[-\s]?(\d{1,2})/);
  if (subMatch) {
    const maxAge = Number(subMatch[1]);
    const minAge = Math.max(4, maxAge - 4);
    return { minAge, maxAge, label: `Sub-${maxAge}` };
  }
  if (cat.includes('libre') || cat.includes('adult') || cat.includes('femenino')) {
    return { minAge: 15, maxAge: 40, label: categoryLabel || 'Categoría Libre' };
  }
  return { minAge: 4, maxAge: 40, label: categoryLabel || 'General' };
}

// ==========================================
// 1.5 SUB-EQUIPOS / CATEGORÍAS DENTRO DE UN MISMO CLUB
// ==========================================
app.post('/api/teams/subteams', authenticateToken, authorizeRoles('club'), async (req, res) => {
  try {
    const parentTeamId = parseId(req.user.teamId);
    const { name, shortName, category, pitchMode, color } = req.body;
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'El nombre del sub-equipo / categoría es obligatorio.' });
    }

    const parentRes = await pool.query('SELECT * FROM teams WHERE id = $1', [parentTeamId]);
    if (parentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Club principal no encontrado.' });
    }
    const parent = parentRes.rows[0];
    const mode = pitchMode === '11v11' ? '11v11' : pitchMode === '7v7' ? '7v7' : '5v5';
    const defaultForm = mode === '11v11' ? '4-3-3' : mode === '7v7' ? '2-3-1' : '1-2-1';
    const cleanShort = (shortName || parent.short_name || cleanName.substring(0, 3) || 'SUB').toUpperCase().substring(0, 5);
    const cleanCat = String(category || 'Categoría Libre').trim();

    const ins = await pool.query(
      `INSERT INTO teams (name, short_name, coach_name, owner_id, parent_team_id, category_label, primary_color, logo_url, pitch_mode, formation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        cleanName,
        cleanShort,
        parent.coach_name,
        parent.owner_id,
        parentTeamId,
        cleanCat,
        color || parent.primary_color || '#10B981',
        parent.logo_url || null,
        mode,
        defaultForm
      ]
    );
    const state = await broadcastState();
    res.status(201).json({
      message: `Sub-equipo "${cleanName}" creado exitosamente.`,
      teamId: 'team-' + ins.rows[0].id,
      state
    });
  } catch (err) {
    console.error('Error en /api/teams/subteams:', err.message);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Ya existe un equipo o categoría con ese mismo nombre.' });
    }
    res.status(400).json({ error: err.message || 'No se pudo crear el sub-equipo.' });
  }
});

app.delete('/api/teams/subteams/:subTeamId', authenticateToken, authorizeRoles('club', 'admin'), async (req, res) => {
  try {
    const subTeamId = parseId(req.params.subTeamId);
    if (req.user.role === 'admin') {
      await pool.query('DELETE FROM teams WHERE id = $1 AND parent_team_id IS NOT NULL', [subTeamId]);
    } else {
      const parentTeamId = parseId(req.user.teamId);
      const del = await pool.query(
        'DELETE FROM teams WHERE id = $1 AND parent_team_id = $2 RETURNING id',
        [subTeamId, parentTeamId]
      );
      if (del.rows.length === 0) {
        return res.status(403).json({ error: 'No puedes eliminar el club principal ni sub-equipos de otro club.' });
      }
    }
    const state = await broadcastState();
    res.json({ message: 'Sub-equipo / categoría eliminado correctamente.', state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. GESTIÓN TÁCTICA Y LÍMITE ESTRICTO 5v5 / 7v7
// ==========================================
app.put('/api/teams/my-tactics', authenticateToken, authorizeRoles('club'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { teamId: reqTeamId, pitchMode, formation, resetPositions, logoUrl, color, shortName, name, category } = req.body;
    const teamId = await resolveAuthorizedTeamId(req, reqTeamId, client);
    if (!teamId) return res.status(403).json({ error: 'No tienes permisos sobre este sub-equipo.' });

    await client.query('BEGIN');

    if (logoUrl !== undefined || color || shortName || name || category) {
      await client.query(
        `UPDATE teams SET
          logo_url = COALESCE($1, logo_url),
          primary_color = COALESCE($2, primary_color),
          short_name = COALESCE($3, short_name),
          name = COALESCE($4, name),
          category_label = COALESCE($5, category_label)
         WHERE id = $6`,
        [logoUrl !== undefined ? logoUrl : null, color || null, shortName || null, name || null, category || null, teamId]
      );
      // Si se actualiza el logo del club principal, propagarlo a sub-equipos que no tengan logo propio
      const rootTeamId = parseId(req.user.teamId);
      if (teamId === rootTeamId && logoUrl) {
        await client.query('UPDATE teams SET logo_url = $1 WHERE parent_team_id = $2', [logoUrl, rootTeamId]);
      }
    }

    if (pitchMode) {
      const mode = pitchMode === '11v11' ? '11v11' : pitchMode === '7v7' ? '7v7' : '5v5';
      const defaultForm = formation || (mode === '11v11' ? '4-3-3' : mode === '7v7' ? '2-3-1' : '1-2-1');
      const maxSt = mode === '11v11' ? 11 : mode === '7v7' ? 7 : 5;

      await client.query('UPDATE teams SET pitch_mode = $1, formation = $2 WHERE id = $3', [mode, defaultForm, teamId]);
      await client.query('UPDATE players SET coord_x = NULL, coord_y = NULL WHERE team_id = $1', [teamId]);

      const startersRes = await client.query(
        'SELECT id FROM players WHERE team_id = $1 AND is_starter = TRUE ORDER BY sort_order ASC, id ASC',
        [teamId]
      );
      if (startersRes.rows.length > maxSt) {
        const overflowIds = startersRes.rows.slice(maxSt).map((r) => r.id);
        await client.query('UPDATE players SET is_starter = FALSE WHERE id = ANY($1::int[])', [overflowIds]);
      }
    } else if (formation) {
      await client.query('UPDATE teams SET formation = $1 WHERE id = $2', [formation, teamId]);
      await client.query('UPDATE players SET coord_x = NULL, coord_y = NULL WHERE team_id = $1', [teamId]);
    } else if (resetPositions) {
      await client.query('UPDATE players SET coord_x = NULL, coord_y = NULL WHERE team_id = $1', [teamId]);
    }

    await client.query('COMMIT');
    const state = await broadcastState();
    res.json({ message: 'Pizarra táctica actualizada.', state });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/players/:playerId/position', authenticateToken, authorizeRoles('club'), async (req, res) => {
  const client = await pool.connect();
  try {
    const playerId = parseId(req.params.playerId);
    const { customX, customY, swapWithPlayerId, teamId: reqTeamId } = req.body;

    await client.query('BEGIN');

    const pLookup = await client.query('SELECT * FROM players WHERE id = $1', [playerId]);
    if (pLookup.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Jugador no encontrado.' });
    }
    const teamId = await resolveAuthorizedTeamId(req, reqTeamId || pLookup.rows[0].team_id, client);
    if (!teamId || pLookup.rows[0].team_id !== teamId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Jugador no pertenece a tu club ni a sus categorías.' });
    }
    const pRes = pLookup;

    if (swapWithPlayerId) {
      const otherId = parseId(swapWithPlayerId);
      const otherRes = await client.query('SELECT * FROM players WHERE id = $1 AND team_id = $2', [otherId, teamId]);
      if (otherRes.rows.length > 0) {
        const pA = pRes.rows[0];
        const pB = otherRes.rows[0];
        await client.query(
          'UPDATE players SET coord_x = $1, coord_y = $2, sort_order = $3 WHERE id = $4',
          [pB.coord_x, pB.coord_y, pB.sort_order, pA.id]
        );
        await client.query(
          'UPDATE players SET coord_x = $1, coord_y = $2, sort_order = $3 WHERE id = $4',
          [pA.coord_x, pA.coord_y, pA.sort_order, pB.id]
        );
      }
    } else {
      await client.query(
        'UPDATE players SET coord_x = $1, coord_y = $2 WHERE id = $3 AND team_id = $4',
        [customX, customY, playerId, teamId]
      );
    }

    await client.query('COMMIT');
    const state = await broadcastState();
    res.json({ message: 'Posición actualizada en pizarra 2D.', state });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/players/:playerId/toggle-starter', authenticateToken, authorizeRoles('club'), async (req, res) => {
  const client = await pool.connect();
  try {
    const playerId = parseId(req.params.playerId);
    const replacePlayerId = req.body.replacePlayerId ? parseId(req.body.replacePlayerId) : null;

    // Verificar que el jugador pertenezca al club del DT autenticado o a uno de sus sub-equipos
    const pRes = await client.query('SELECT * FROM players WHERE id = $1', [playerId]);
    if (pRes.rows.length === 0) return res.status(404).json({ error: 'Jugador no encontrado.' });
    const teamId = await resolveAuthorizedTeamId(req, pRes.rows[0].team_id, client);
    if (!teamId) return res.status(403).json({ error: 'No puedes modificar jugadores de otro club.' });

    const player = pRes.rows[0];
    if (player.status !== 'Disponible' && !player.is_starter) {
      return res.status(400).json({ error: 'Jugador lesionado o suspendido no puede ser titular.' });
    }

    // Si ya es titular, lo pasamos a suplente directamente
    if (player.is_starter) {
      await client.query('UPDATE players SET is_starter = FALSE, coord_x = NULL, coord_y = NULL WHERE id = $1', [player.id]);
      const state = await broadcastState();
      return res.json({ message: 'Jugador enviado al banquillo.', state });
    }

    // Consultar límite de cancha del equipo (5v5 -> 5, 7v7 -> 7, 11v11 -> 11 titulares)
    const teamRes = await client.query('SELECT pitch_mode FROM teams WHERE id = $1', [teamId]);
    const pMode = teamRes.rows[0].pitch_mode;
    const limit = pMode === '11v11' ? 11 : pMode === '7v7' ? 7 : 5;

    const countRes = await client.query(
      'SELECT COUNT(*) FROM players WHERE team_id = $1 AND is_starter = TRUE',
      [teamId]
    );
    const currentStarters = parseInt(countRes.rows[0].count, 10);

    await client.query('BEGIN');

    if (currentStarters >= limit) {
      if (!replacePlayerId) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Formación completa (${limit}/${limit}). Debes indicar a qué titular reemplazar.`,
          code: 'FORMATION_FULL'
        });
      }
      // Intercambiar coordenadas y orden con el titular saliente
      const outRes = await client.query(
        'SELECT coord_x, coord_y, sort_order FROM players WHERE id = $1 AND team_id = $2 AND is_starter = TRUE',
        [replacePlayerId, teamId]
      );
      if (outRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'El jugador a reemplazar no es un titular válido.' });
      }
      const { coord_x, coord_y, sort_order } = outRes.rows[0];
      await client.query(
        'UPDATE players SET is_starter = FALSE, coord_x = NULL, coord_y = NULL, sort_order = $1 WHERE id = $2',
        [player.sort_order, replacePlayerId]
      );
      await client.query(
        'UPDATE players SET is_starter = TRUE, coord_x = $1, coord_y = $2, sort_order = $3 WHERE id = $4',
        [coord_x, coord_y, sort_order, player.id]
      );
    } else {
      await client.query('UPDATE players SET is_starter = TRUE, coord_x = NULL, coord_y = NULL WHERE id = $1', [player.id]);
    }

    await client.query('COMMIT');
    const state = await broadcastState();
    res.json({ message: 'Alineación titular actualizada.', state });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/players', authenticateToken, authorizeRoles('club'), async (req, res) => {
  try {
    const teamId = await resolveAuthorizedTeamId(req, req.body.teamId);
    if (!teamId) {
      return res.status(403).json({ error: 'No tienes permisos para inscribir jugadores en este equipo.' });
    }
    const {
      firstName,
      lastName,
      name,
      number,
      pos,
      birthDate,
      idNumber,
      schoolJoinDate,
      repIdNumber,
      hasSpecialCondition,
      specialConditionDetail,
      photoUrl,
      birthCertDoc,
      playerIdDoc,
      repIdDoc,
      specialConditionDoc
    } = req.body;

    const dorsal = Number(number);
    if (!dorsal || dorsal < 1 || dorsal > 99) {
      return res.status(400).json({ error: 'El dorsal debe estar entre 1 y 99.' });
    }

    // Verificar que el dorsal no esté ocupado en el mismo equipo/categoría
    const dupCheck = await pool.query(
      'SELECT id, full_name FROM players WHERE team_id = $1 AND dorsal = $2',
      [teamId, dorsal]
    );
    if (dupCheck.rows.length > 0) {
      return res.status(409).json({
        error: `El dorsal #${dorsal} ya está ocupado en esta categoría por ${dupCheck.rows[0].full_name}.`
      });
    }

    const cleanFirst = (firstName || '').trim();
    const cleanLast = (lastName || '').trim();
    const fullName = (name || `${cleanFirst} ${cleanLast}`).trim();

    if (!fullName || !birthDate || !schoolJoinDate || !birthCertDoc) {
      return res.status(400).json({
        error: 'Nombres, apellidos, fecha de nacimiento, fecha de ingreso a la escuela y partida de nacimiento son obligatorios.'
      });
    }

    // Validar edad dinámica según la categoría del equipo / sub-equipo
    const teamCatRes = await pool.query('SELECT category_label FROM teams WHERE id = $1', [teamId]);
    const ageBounds = getCategoryAgeBounds(teamCatRes.rows[0]?.category_label);
    const bParts = String(birthDate).split('-');
    if (bParts.length === 3) {
      const bDateObj = new Date(Number(bParts[0]), Number(bParts[1]) - 1, Number(bParts[2]));
      const now = new Date();
      let ageYears = now.getFullYear() - bDateObj.getFullYear();
      const mDiff = now.getMonth() - bDateObj.getMonth();
      if (mDiff < 0 || (mDiff === 0 && now.getDate() < bDateObj.getDate())) {
        ageYears--;
      }
      if (ageYears < ageBounds.minAge || ageYears > ageBounds.maxAge) {
        return res.status(400).json({
          error: `La edad del jugador (${ageYears} años) no corresponde a la categoría ${ageBounds.label} (permitido: ${ageBounds.minAge} a ${ageBounds.maxAge} años).`
        });
      }
    }

    if (req.body.hasIdCard && (!idNumber || !playerIdDoc)) {
      return res.status(400).json({
        error: 'Si el jugador posee Cédula de Identidad, debes indicar el número y subir obligatoriamente la foto de su identificación.'
      });
    }

    if (hasSpecialCondition && (!specialConditionDetail || !specialConditionDoc)) {
      return res.status(400).json({
        error: 'Debes especificar cuál es la condición especial y adjuntar el documento de soporte.'
      });
    }

    const maxOrderRes = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM players WHERE team_id = $1', [teamId]);
    const nextOrder = Number(maxOrderRes.rows[0].max_order) + 1;

    await pool.query(
      `INSERT INTO players (
        team_id, full_name, first_name, last_name, birth_date, id_number, school_join_date, rep_id_number,
        has_special_condition, special_condition_detail, photo_url, birth_cert_doc, player_id_doc, rep_id_doc, special_condition_doc,
        dorsal, position, status, is_starter, coord_x, coord_y, sort_order
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'Disponible',FALSE,NULL,NULL,$18)`,
      [
        teamId,
        fullName,
        cleanFirst || fullName,
        cleanLast,
        birthDate,
        idNumber || null,
        schoolJoinDate,
        repIdNumber || null,
        Boolean(hasSpecialCondition),
        hasSpecialCondition ? specialConditionDetail : null,
        photoUrl || null,
        birthCertDoc,
        playerIdDoc || null,
        repIdDoc || null,
        hasSpecialCondition ? specialConditionDoc : null,
        dorsal,
        pos || 'MED',
        nextOrder
      ]
    );

    const state = await broadcastState();
    res.status(201).json({ message: 'Jugador fichado exitosamente con expediente completo.', state });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/players/:playerId/photo', authenticateToken, authorizeRoles('club', 'admin'), async (req, res) => {
  try {
    const playerId = parseId(req.params.playerId);
    const { photoUrl, docStatus, status, clearSuspension } = req.body;
    if (photoUrl !== undefined) {
      await pool.query('UPDATE players SET photo_url = $1 WHERE id = $2', [photoUrl || null, playerId]);
    }
    if (docStatus) {
      await pool.query('UPDATE players SET doc_status = $1 WHERE id = $2', [docStatus, playerId]);
    }
    if (clearSuspension && req.user.role === 'admin') {
      await pool.query(
        "UPDATE players SET status = 'Disponible', yellow_cards = 0, red_cards = 0 WHERE id = $1",
        [playerId]
      );
      await pool.query(
        "DELETE FROM match_events WHERE player_id = $1 AND event_type IN ('yellow', 'red')",
        [playerId]
      );
    } else if (status) {
      await pool.query('UPDATE players SET status = $1 WHERE id = $2', [status, playerId]);
    }
    const state = await broadcastState();
    res.json({ message: 'Datos del jugador actualizados.', state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/players/:playerId', authenticateToken, authorizeRoles('club', 'admin'), async (req, res) => {
  try {
    const playerId = parseId(req.params.playerId);
    if (req.user.role === 'admin') {
      await pool.query('DELETE FROM players WHERE id = $1', [playerId]);
    } else {
      const pCheck = await pool.query('SELECT team_id FROM players WHERE id = $1', [playerId]);
      if (pCheck.rows.length === 0) return res.status(404).json({ error: 'Jugador no encontrado.' });
      const authTeamId = await resolveAuthorizedTeamId(req, pCheck.rows[0].team_id);
      if (!authTeamId) return res.status(403).json({ error: 'No puedes eliminar jugadores de otro club.' });
      await pool.query('DELETE FROM players WHERE id = $1 AND team_id = $2', [playerId, authTeamId]);
    }
    const state = await broadcastState();
    res.json({ message: 'Jugador dado de baja del plantel.', state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/clubs/:teamId/password', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const teamId = parseId(req.params.teamId);
    const { password, email } = req.body;
    if (!password || String(password).trim().length < 4) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 4 caracteres.' });
    }
    const tmRes = await pool.query('SELECT owner_id, name FROM teams WHERE id = $1', [teamId]);
    if (tmRes.rows.length === 0) return res.status(404).json({ error: 'Club no encontrado.' });
    const ownerId = tmRes.rows[0].owner_id;
    const hash = await bcrypt.hash(String(password).trim(), 10);
    if (email && String(email).trim()) {
      await pool.query('UPDATE users SET password_hash = $1, email = $2 WHERE id = $3', [hash, String(email).trim().toLowerCase(), ownerId]);
    } else {
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, ownerId]);
    }
    const state = await broadcastState();
    res.json({ message: 'Credenciales del club actualizadas.', state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/clubs/:teamId', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const teamId = parseId(req.params.teamId);
    await client.query('BEGIN');
    const tmRes = await client.query('SELECT owner_id FROM teams WHERE id = $1', [teamId]);
    const ownerId = tmRes.rows[0]?.owner_id;
    await client.query('DELETE FROM teams WHERE id = $1', [teamId]);
    if (ownerId) {
      await client.query("DELETE FROM users WHERE id = $1 AND role = 'club'", [ownerId]);
    }
    await client.query('COMMIT');
    const state = await broadcastState();
    res.json({ message: 'Club eliminado del sistema.', state });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/admin/referees', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nombre, correo y contraseña del árbitro son obligatorios.' });
    }
    const hash = await bcrypt.hash(String(password).trim(), 10);
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'referee')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, role = 'referee'`,
      [String(name).trim(), String(email).trim().toLowerCase(), hash]
    );
    const state = await broadcastState();
    res.status(201).json({ message: 'Árbitro oficial acreditado.', state });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/referees/:refId', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const refId = parseId(req.params.refId);
    await pool.query("DELETE FROM users WHERE id = $1 AND role = 'referee'", [refId]);
    const state = await broadcastState();
    res.json({ message: 'Árbitro retirado del sistema.', state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/my-password', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || String(password).trim().length < 4) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres.' });
    }
    const hash = await bcrypt.hash(String(password).trim(), 10);
    await pool.query("UPDATE users SET password_hash = $1 WHERE role = 'admin'", [hash]);
    res.json({ message: 'Contraseña de administrador actualizada en PostgreSQL.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/matches', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { tournamentId, round, homeId, awayId, date, pitch } = req.body;
    const tId = parseId(tournamentId);
    const hId = parseId(homeId);
    const aId = parseId(awayId);
    if (!tId || !hId || !aId || hId === aId) {
      return res.status(400).json({ error: 'Debes elegir dos clubes distintos para programar el partido.' });
    }
    const insMatch = await pool.query(
      `INSERT INTO matches (tournament_id, round_name, match_date, pitch_name, home_team_id, away_team_id, home_score, away_score, status, period, current_minute)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 'scheduled', '1T', 0) RETURNING id`,
      [tId, round || 'Jornada Especial', date || 'Por definir', pitch || 'Cancha Principal', hId, aId]
    );
    const newMatchId = insMatch.rows[0].id;
    const tInfo = await pool.query('SELECT referee_fee FROM tournaments WHERE id = $1', [tId]);
    const refFee = tInfo.rows[0]?.referee_fee || '$20 USD';
    const mDateLabel = date || 'Por definir';
    const mRoundLabel = round || 'Jornada Especial';
    await pool.query(
      `INSERT INTO club_payments (team_id, tournament_id, match_id, concept, amount, method, reference, payment_date, status)
       VALUES ($1, $2, $3, $4, $5, 'Por pagar', 'Sin comprobante', $6, 'unpaid'),
              ($7, $2, $3, $4, $5, 'Por pagar', 'Sin comprobante', $6, 'unpaid')`,
      [hId, tId, newMatchId, `Arbitraje — ${mRoundLabel}`, refFee, mDateLabel, aId]
    );
    const state = await broadcastState();
    res.status(201).json({ message: 'Partido programado y deuda de arbitraje generada.', state });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/matches/:matchId', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const matchId = parseId(req.params.matchId);
    await pool.query("DELETE FROM club_payments WHERE match_id = $1 AND status = 'unpaid'", [matchId]);
    await pool.query('DELETE FROM matches WHERE id = $1', [matchId]);
    const state = await broadcastState();
    res.json({ message: 'Partido eliminado del calendario.', state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2.4 CONTROL DE PAGOS Y SOLVENCIA DEL CLUB
// ==========================================
app.post('/api/payments', authenticateToken, authorizeRoles('club'), async (req, res) => {
  try {
    const { teamId: reqTeamId, tournamentId, concept, amount, method, reference, date, receiptDoc } = req.body;
    const teamId = await resolveAuthorizedTeamId(req, reqTeamId);
    if (!teamId) return res.status(403).json({ error: 'No tienes permisos sobre este equipo.' });
    const tId = tournamentId ? parseId(tournamentId) : 1;

    await pool.query(
      `INSERT INTO club_payments (team_id, tournament_id, concept, amount, method, reference, payment_date, receipt_doc, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
      [teamId, tId, concept, amount, method, reference, date || 'Hoy', receiptDoc || null]
    );
    const state = await broadcastState();
    res.status(201).json({ message: 'Pago reportado correctamente.', state });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/payments/:paymentId/receipt', authenticateToken, authorizeRoles('club'), async (req, res) => {
  try {
    const paymentId = parseId(req.params.paymentId);
    const { method, reference, receiptDoc, date } = req.body;
    const payCheck = await pool.query('SELECT team_id FROM club_payments WHERE id = $1', [paymentId]);
    if (payCheck.rows.length === 0) return res.status(404).json({ error: 'Registro de pago no encontrado.' });
    const authTeamId = await resolveAuthorizedTeamId(req, payCheck.rows[0].team_id);
    if (!authTeamId) return res.status(403).json({ error: 'No tienes permisos sobre este pago.' });

    await pool.query(
      `UPDATE club_payments SET
        method = COALESCE($1, method),
        reference = COALESCE($2, reference),
        receipt_doc = COALESCE($3, receipt_doc),
        payment_date = COALESCE($4, payment_date),
        status = 'pending'
       WHERE id = $5`,
      [method || 'Pago Móvil', reference || 'Comprobante', receiptDoc || null, date || null, paymentId]
    );
    const state = await broadcastState();
    res.json({ message: 'Comprobante subido. En espera de verificación del organizador.', state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/payments/:paymentId/status', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const paymentId = parseId(req.params.paymentId);
    const { status } = req.body;
    await pool.query('UPDATE club_payments SET status = $1 WHERE id = $2', [status, paymentId]);
    const state = await broadcastState();
    res.json({ message: 'Estado de pago actualizado.', state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2.5 GESTIÓN DE CUERPO TÉCNICO DEL CLUB (CON DOCUMENTOS)
// ==========================================
app.post('/api/staff', authenticateToken, authorizeRoles('club'), async (req, res) => {
  try {
    const teamId = parseId(req.user.teamId);
    const { firstName, lastName, roleTitle, idNumber, birthDate, phone, joinDate, idDoc, licenseDoc } = req.body;

    if (!firstName || !lastName || !roleTitle || !idNumber || !idDoc || !licenseDoc) {
      return res.status(400).json({
        error: 'Nombres, apellidos, cargo, cédula y las imágenes de los documentos del cuerpo técnico son obligatorios.'
      });
    }

    await pool.query(
      `INSERT INTO club_staff (team_id, first_name, last_name, role_title, id_number, birth_date, phone, join_date, id_doc, license_doc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [teamId, firstName.trim(), lastName.trim(), roleTitle, idNumber.trim(), birthDate || null, phone || null, joinDate || null, idDoc, licenseDoc]
    );

    const state = await broadcastState();
    res.status(201).json({ message: 'Integrante del cuerpo técnico registrado.', state });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/staff/:staffId', authenticateToken, authorizeRoles('club'), async (req, res) => {
  try {
    const teamId = parseId(req.user.teamId);
    const staffId = parseId(req.params.staffId);
    await pool.query('DELETE FROM club_staff WHERE id = $1 AND team_id = $2', [staffId, teamId]);
    const state = await broadcastState();
    res.json({ message: 'Integrante del cuerpo técnico eliminado.', state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. TORNEOS, INSCRIPCIONES Y FIXTURE
// ==========================================
app.post('/api/tournaments', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  const client = await pool.connect();
  let newTourneyId = null;
  try {
    const { name, pitchSize, category, maxTeams, startDate, prize, registrationFee, refereeFee } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'El nombre del torneo es obligatorio.' });
    }
    const cleanSize = pitchSize === '11v11' ? '11v11' : pitchSize === '7v7' ? '7v7' : '5v5';
    const formatText = category ? `Liga + Playoffs (${category})` : 'Liga + Playoffs';
    const limitTeams = Number(maxTeams) || 8;
    const regFeeText = (registrationFee && String(registrationFee).trim()) || '$150 USD';
    const refFeeText = (refereeFee && String(refereeFee).trim()) || '$20 USD';

    const cleanCategory = (category && String(category).trim()) || 'Categoría Libre';
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO tournaments (name, format, category_label, pitch_size, max_teams, start_date, prize, registration_fee, referee_fee, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open') RETURNING id`,
      [String(name).trim(), formatText, cleanCategory, cleanSize, limitTeams, startDate || 'Por definir', prize || '', regFeeText, refFeeText]
    );
    newTourneyId = ins.rows[0].id;
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }

  try {
    const state = await broadcastState();
    return res.status(201).json({
      message: 'Torneo creado y publicado sin equipos pre-inscritos.',
      tournamentId: 'tour-' + newTourneyId,
      state
    });
  } catch (err) {
    return res.status(201).json({
      message: 'Torneo creado y publicado sin equipos pre-inscritos.',
      tournamentId: 'tour-' + newTourneyId
    });
  }
});

app.delete('/api/tournaments/:tournamentId', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const tournamentId = parseId(req.params.tournamentId);
    await pool.query('DELETE FROM tournaments WHERE id = $1', [tournamentId]);
    const state = await broadcastState();
    res.json({ message: 'Torneo eliminado oficialmente.', state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/matches/:matchId/schedule', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const matchId = parseId(req.params.matchId);
    const { round, date, pitch, reactivateIfSuspended } = req.body;
    const current = await pool.query('SELECT status FROM matches WHERE id = $1', [matchId]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Partido no encontrado.' });
    if (current.rows[0].status === 'finished') {
      return res.status(400).json({ error: 'No se puede editar un partido que ya fue finalizado por el árbitro.' });
    }
    await pool.query(
      `UPDATE matches SET
        round_name = COALESCE($1, round_name),
        match_date = COALESCE($2, match_date),
        pitch_name = COALESCE($3, pitch_name),
        status = CASE WHEN $5 = TRUE AND status = 'suspended' THEN 'scheduled' ELSE status END,
        suspension_reason = CASE WHEN $5 = TRUE AND status = 'suspended' THEN NULL ELSE suspension_reason END
       WHERE id = $4`,
      [round || null, date || null, pitch || null, matchId, reactivateIfSuspended !== false]
    );
    if (date) {
      await pool.query(
        "UPDATE club_payments SET payment_date = $1 WHERE match_id = $2 AND status = 'unpaid'",
        [date, matchId]
      );
    }
    const state = await broadcastState();
    res.json({ message: 'Horario y cancha del partido actualizados.', state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tournaments/:tournamentId/toggle-enrollment', authenticateToken, authorizeRoles('club', 'admin'), async (req, res) => {
  try {
    const tournamentId = parseId(req.params.tournamentId);
    let teamId = null;
    if (req.user.role === 'admin' && req.body.teamId) {
      teamId = parseId(req.body.teamId);
    } else {
      teamId = await resolveAuthorizedTeamId(req, req.body.teamId);
    }
    if (!teamId) return res.status(403).json({ error: 'No tienes permisos sobre este equipo/categoría.' });

    const existing = await pool.query(
      'SELECT * FROM tournament_registrations WHERE tournament_id = $1 AND team_id = $2',
      [tournamentId, teamId]
    );
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM tournament_registrations WHERE tournament_id = $1 AND team_id = $2', [tournamentId, teamId]);
      await pool.query(
        "DELETE FROM club_payments WHERE tournament_id = $1 AND team_id = $2 AND match_id IS NULL AND status = 'unpaid'",
        [tournamentId, teamId]
      );
    } else {
      await pool.query(
        "INSERT INTO tournament_registrations (tournament_id, team_id, status) VALUES ($1, $2, 'approved')",
        [tournamentId, teamId]
      );
      const tInfo = await pool.query('SELECT name, registration_fee, start_date FROM tournaments WHERE id = $1', [tournamentId]);
      const tRow = tInfo.rows[0];
      const existingDebt = await pool.query(
        "SELECT id FROM club_payments WHERE tournament_id = $1 AND team_id = $2 AND match_id IS NULL AND concept LIKE 'Inscripción%'",
        [tournamentId, teamId]
      );
      if (tRow && existingDebt.rows.length === 0) {
        await pool.query(
          `INSERT INTO club_payments (team_id, tournament_id, match_id, concept, amount, method, reference, payment_date, status)
           VALUES ($1, $2, NULL, $3, $4, 'Por pagar', 'Sin comprobante', $5, 'unpaid')`,
          [teamId, tournamentId, `Inscripción Oficial — ${tRow.name}`, tRow.registration_fee || '$150 USD', tRow.start_date || 'Por pagar']
        );
      }
    }

    const state = await broadcastState();
    res.json({ message: 'Inscripción actualizada.', state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tournaments/:tournamentId/playoffs', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const tournamentId = parseId(req.params.tournamentId);
    const { stage, matches } = req.body;
    if (!Array.isArray(matches) || matches.length === 0) {
      return res.status(400).json({ error: 'No se recibieron cruces de playoffs.' });
    }

    await client.query('BEGIN');
    if (stage === 'semifinals') {
      await client.query(
        "DELETE FROM matches WHERE tournament_id = $1 AND round_name IN ('Semifinal 1', 'Semifinal 2') AND status = 'scheduled'",
        [tournamentId]
      );
    } else if (stage === 'final') {
      await client.query(
        "DELETE FROM matches WHERE tournament_id = $1 AND round_name = '🏆 GRAN FINAL' AND status = 'scheduled'",
        [tournamentId]
      );
    }

    for (const m of matches) {
      const hId = parseId(m.homeId);
      const aId = parseId(m.awayId);
      if (hId && aId) {
        await client.query(
          `INSERT INTO matches (tournament_id, round_name, match_date, pitch_name, home_team_id, away_team_id, home_score, away_score, status, period, current_minute)
           VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 'scheduled', '1T', 0)`,
          [tournamentId, m.round, m.date || 'Playoffs • 20:00', m.pitch || 'Cancha Principal', hId, aId]
        );
      }
    }

    await client.query('COMMIT');
    const state = await broadcastState();
    res.status(201).json({ message: 'Fase eliminatoria guardada en PostgreSQL.', state });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/tournaments/:tournamentId/generate-fixture', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const tournamentId = parseId(req.params.tournamentId);
    const tRes = await client.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
    if (tRes.rows.length === 0) return res.status(404).json({ error: 'Torneo no encontrado.' });
    const t = tRes.rows[0];

    await client.query('BEGIN');

    let regRes = await client.query(
      "SELECT team_id FROM tournament_registrations WHERE tournament_id = $1 AND status = 'approved' ORDER BY registered_at ASC",
      [tournamentId]
    );

    const list = regRes.rows.map((r) => r.team_id);
    if (list.length < 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Debes seleccionar al menos 2 clubes participantes en este torneo antes de generar el calendario.' });
    }

    // Eliminar partidos programados previos de este torneo para regenerar limpio
    await client.query("DELETE FROM matches WHERE tournament_id = $1 AND status = 'scheduled'", [tournamentId]);

    if (list.length % 2 !== 0) list.push('BYE');
    const rounds = list.length - 1;
    const half = list.length / 2;
    const timeSlots = ['19:00', '20:15', '21:30', '22:30'];
    let created = 0;

    // PRIMERA VUELTA (IDA) + Deuda de Arbitraje por jornada
    const refFeeAmount = t.referee_fee || '$20 USD';
    const firstLegRounds = [];
    for (let r = 0; r < rounds; r++) {
      let slotIdx = 0;
      const roundMatches = [];
      for (let i = 0; i < half; i++) {
        const h = list[i];
        const a = list[list.length - 1 - i];
        if (h !== 'BYE' && a !== 'BYE') {
          created++;
          const matchHour = timeSlots[slotIdx % timeSlots.length];
          const pitchNum = (slotIdx % 2) + 1;
          slotIdx++;
          const roundLabel = `Jornada ${r + 1} (Ida)`;
          const matchDateStr = `${t.start_date} • ${matchHour}`;
          roundMatches.push({ h, a, matchHour, pitchNum });
          const mIns = await client.query(
            `INSERT INTO matches (tournament_id, round_name, match_date, pitch_name, home_team_id, away_team_id, home_score, away_score, status, period, current_minute)
             VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 'scheduled', '1T', 0) RETURNING id`,
            [tournamentId, roundLabel, matchDateStr, `Cancha ${pitchNum} (${t.pitch_size})`, h, a]
          );
          const mId = mIns.rows[0].id;
          await client.query(
            `INSERT INTO club_payments (team_id, tournament_id, match_id, concept, amount, method, reference, payment_date, status)
             VALUES ($1, $2, $3, $4, $5, 'Por pagar', 'Sin comprobante', $6, 'unpaid'),
                    ($7, $2, $3, $4, $5, 'Por pagar', 'Sin comprobante', $6, 'unpaid')`,
            [h, tournamentId, mId, `Arbitraje — ${roundLabel}`, refFeeAmount, matchDateStr, a]
          );
        }
      }
      firstLegRounds.push(roundMatches);
      list.splice(1, 0, list.pop());
    }

    // SEGUNDA VUELTA (VUELTA — Localía invertida) + Deuda de Arbitraje por jornada
    for (let r = 0; r < firstLegRounds.length; r++) {
      const roundMatches = firstLegRounds[r];
      for (const rm of roundMatches) {
        created++;
        const roundLabel2 = `Jornada ${rounds + r + 1} (Vuelta)`;
        const matchDateStr2 = `${t.start_date} • ${rm.matchHour}`;
        const mIns2 = await client.query(
          `INSERT INTO matches (tournament_id, round_name, match_date, pitch_name, home_team_id, away_team_id, home_score, away_score, status, period, current_minute)
           VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 'scheduled', '1T', 0) RETURNING id`,
          [tournamentId, roundLabel2, matchDateStr2, `Cancha ${rm.pitchNum} (${t.pitch_size})`, rm.a, rm.h]
        );
        const mId2 = mIns2.rows[0].id;
        await client.query(
          `INSERT INTO club_payments (team_id, tournament_id, match_id, concept, amount, method, reference, payment_date, status)
           VALUES ($1, $2, $3, $4, $5, 'Por pagar', 'Sin comprobante', $6, 'unpaid'),
                  ($7, $2, $3, $4, $5, 'Por pagar', 'Sin comprobante', $6, 'unpaid')`,
          [rm.a, tournamentId, mId2, `Arbitraje — ${roundLabel2}`, refFeeAmount, matchDateStr2, rm.h]
        );
      }
    }

    await client.query("UPDATE tournaments SET status = 'active' WHERE id = $1", [tournamentId]);
    await client.query('COMMIT');

    const state = await broadcastState();
    res.json({ message: `Se generaron ${created} partidos.`, created, state });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 4. CONSOLA ÁRBITRO Y TIEMPO REAL (SOCKET.IO)
// ==========================================
async function autoAdvanceFinalIfReady(clientOrPool, matchId) {
  const mRes = await clientOrPool.query('SELECT * FROM matches WHERE id = $1', [matchId]);
  if (mRes.rows.length === 0) return;
  const currentMatch = mRes.rows[0];
  if (currentMatch.round_name !== 'Semifinal 1' && currentMatch.round_name !== 'Semifinal 2') return;

  const tourneyId = currentMatch.tournament_id;
  const semisRes = await clientOrPool.query(
    "SELECT * FROM matches WHERE tournament_id = $1 AND round_name IN ('Semifinal 1', 'Semifinal 2') ORDER BY id ASC",
    [tourneyId]
  );
  let sf1 = null;
  let sf2 = null;
  for (const r of semisRes.rows) {
    if (r.round_name === 'Semifinal 1') sf1 = r;
    if (r.round_name === 'Semifinal 2') sf2 = r;
  }
  if (!sf1 || !sf2 || sf1.status !== 'finished' || sf2.status !== 'finished') return;

  function resolveMatchWinnerId(mRow) {
    if (mRow.forfeit_winner_id) return mRow.forfeit_winner_id;
    if (mRow.home_score > mRow.away_score) return mRow.home_team_id;
    if (mRow.away_score > mRow.home_score) return mRow.away_team_id;
    if (mRow.home_penalties !== null && mRow.away_penalties !== null && mRow.home_penalties !== mRow.away_penalties) {
      return mRow.home_penalties > mRow.away_penalties ? mRow.home_team_id : mRow.away_team_id;
    }
    return mRow.home_team_id;
  }

  const finalistA = resolveMatchWinnerId(sf1);
  const finalistB = resolveMatchWinnerId(sf2);
  if (!finalistA || !finalistB) return;

  const tRes = await clientOrPool.query('SELECT pitch_size FROM tournaments WHERE id = $1', [tourneyId]);
  const pitchSize = tRes.rows[0]?.pitch_size || '7v7';

  const existingFinal = await clientOrPool.query(
    "SELECT id, status FROM matches WHERE tournament_id = $1 AND round_name = '🏆 GRAN FINAL' ORDER BY id DESC LIMIT 1",
    [tourneyId]
  );

  if (existingFinal.rows.length > 0) {
    if (existingFinal.rows[0].status === 'scheduled') {
      await clientOrPool.query(
        'UPDATE matches SET home_team_id = $1, away_team_id = $2 WHERE id = $3',
        [finalistA, finalistB, existingFinal.rows[0].id]
      );
    }
  } else {
    await clientOrPool.query(
      `INSERT INTO matches (tournament_id, round_name, match_date, pitch_name, home_team_id, away_team_id, home_score, away_score, status, period, current_minute)
       VALUES ($1, '🏆 GRAN FINAL', 'Gran Final • 21:00', $2, $3, $4, 0, 0, 'scheduled', '1T', 0)`,
      [tourneyId, `Estadio Principal (${pitchSize})`, finalistA, finalistB]
    );
  }
}

app.put('/api/matches/:matchId/state', authenticateToken, authorizeRoles('referee', 'admin'), async (req, res) => {
  try {
    const matchId = parseId(req.params.matchId);
    const {
      status,
      minute,
      period,
      mvpPlayerId,
      tickOnly,
      suspensionReason,
      forfeitWinnerId,
      homeScore,
      awayScore,
      homePenalties,
      awayPenalties,
      penaltiesLog,
      clockRunning,
      clockStartedAt,
      clockElapsedSec
    } = req.body;

    if (status && minute !== undefined) {
      await pool.query('UPDATE matches SET status = $1, current_minute = $2 WHERE id = $3', [status, minute, matchId]);
    } else if (status) {
      await pool.query('UPDATE matches SET status = $1 WHERE id = $2', [status, matchId]);
    } else if (minute !== undefined) {
      await pool.query('UPDATE matches SET current_minute = $1 WHERE id = $2', [minute, matchId]);
    }
    if (clockRunning !== undefined || clockStartedAt !== undefined || clockElapsedSec !== undefined) {
      const cRun = clockRunning !== undefined ? Boolean(clockRunning) : null;
      const cStart = clockStartedAt !== undefined ? (clockStartedAt ? Number(clockStartedAt) : null) : undefined;
      const cElap = clockElapsedSec !== undefined ? Number(clockElapsedSec) || 0 : null;
      await pool.query(
        `UPDATE matches SET
          clock_running = COALESCE($1, clock_running),
          clock_started_at = CASE WHEN $2::boolean THEN $3::bigint ELSE clock_started_at END,
          clock_elapsed_sec = COALESCE($4, clock_elapsed_sec)
         WHERE id = $5`,
        [cRun, clockStartedAt !== undefined, cStart !== undefined ? cStart : null, cElap, matchId]
      );
    }
    // Si se finaliza o suspende el partido, congelar el cronómetro en PostgreSQL
    if (status === 'finished' || status === 'suspended') {
      await pool.query(
        `UPDATE matches SET
          clock_elapsed_sec = CASE WHEN clock_running AND clock_started_at IS NOT NULL
            THEN COALESCE(clock_elapsed_sec, 0) + GREATEST(0, FLOOR((EXTRACT(EPOCH FROM NOW()) * 1000 - clock_started_at) / 1000)::int)
            ELSE COALESCE(clock_elapsed_sec, 0) END,
          clock_running = FALSE,
          clock_started_at = NULL
         WHERE id = $1`,
        [matchId]
      );
    }
    if (period) {
      await pool.query('UPDATE matches SET period = $1 WHERE id = $2', [period, matchId]);
    }
    if (mvpPlayerId !== undefined) {
      const mvpIdNum = mvpPlayerId ? parseId(mvpPlayerId) : null;
      await pool.query('UPDATE matches SET mvp_player_id = $1 WHERE id = $2', [mvpIdNum, matchId]);
    }
    if (suspensionReason !== undefined) {
      await pool.query('UPDATE matches SET suspension_reason = $1 WHERE id = $2', [suspensionReason || null, matchId]);
    }
    if (forfeitWinnerId !== undefined) {
      const ffIdNum = forfeitWinnerId ? parseId(forfeitWinnerId) : null;
      await pool.query('UPDATE matches SET forfeit_winner_id = $1 WHERE id = $2', [ffIdNum, matchId]);
    }
    if (homeScore !== undefined && awayScore !== undefined) {
      await pool.query('UPDATE matches SET home_score = $1, away_score = $2 WHERE id = $3', [Number(homeScore) || 0, Number(awayScore) || 0, matchId]);
    }
    if (homePenalties !== undefined || awayPenalties !== undefined || penaltiesLog !== undefined) {
      const hPen = homePenalties === null || homePenalties === undefined ? null : Number(homePenalties);
      const aPen = awayPenalties === null || awayPenalties === undefined ? null : Number(awayPenalties);
      const pLogStr = Array.isArray(penaltiesLog) ? JSON.stringify(penaltiesLog) : (penaltiesLog || null);
      await pool.query(
        'UPDATE matches SET home_penalties = $1, away_penalties = $2, penalties_log = $3 WHERE id = $4',
        [hPen, aPen, pLogStr, matchId]
      );
    }

    if (status === 'finished') {
      await autoAdvanceFinalIfReady(pool, matchId);
    }

    // Si es solo un avance automático del minutero sin cambio de estado, no recargar toda la base sino emitir evento ligero
    if (
      tickOnly &&
      !status &&
      !period &&
      mvpPlayerId === undefined &&
      suspensionReason === undefined &&
      forfeitWinnerId === undefined &&
      homePenalties === undefined
    ) {
      io.emit('live_clock_sync', { matchId: 'm-' + matchId, minute: minute || 0, seconds: 0 });
      return res.json({ message: 'Minuto actualizado.' });
    }

    const state = await broadcastState();
    res.json({ message: 'Estado del partido actualizado.', state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/matches/:matchId/events', authenticateToken, authorizeRoles('referee', 'admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const matchId = parseId(req.params.matchId);
    const teamId = parseId(req.body.teamId);
    const playerId = parseId(req.body.playerId);
    const assistPlayerId = req.body.assistPlayerId ? parseId(req.body.assistPlayerId) : null;
    let concededPlayerId = req.body.concededPlayerId ? parseId(req.body.concededPlayerId) : null;
    const { eventType, minute, period } = req.body;

    await client.query('BEGIN');

    // Verificar que el jugador no esté suspendido
    const playerCheck = await client.query('SELECT status, yellow_cards FROM players WHERE id = $1', [playerId]);
    if (playerCheck.rows[0]?.status === 'Suspendido') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Jugador inhabilitado por sanción disciplinaria.' });
    }

    // Si es un gol y no se envió explícitamente el portero rival, detectar el portero titular del equipo contrario
    let isHome = false;
    if (eventType === 'goal') {
      const mRes = await client.query('SELECT home_team_id, away_team_id FROM matches WHERE id = $1', [matchId]);
      if (mRes.rows.length > 0) {
        isHome = mRes.rows[0].home_team_id === Number(teamId);
        const oppTeamId = isHome ? mRes.rows[0].away_team_id : mRes.rows[0].home_team_id;
        if (!concededPlayerId && oppTeamId) {
          const gkRes = await client.query(
            "SELECT id FROM players WHERE team_id = $1 AND position = 'POR' ORDER BY is_starter DESC, sort_order ASC, id ASC LIMIT 1",
            [oppTeamId]
          );
          if (gkRes.rows.length > 0) concededPlayerId = gkRes.rows[0].id;
        }
      }
    }

    // Insertar evento
    await client.query(
      `INSERT INTO match_events (match_id, team_id, player_id, assist_player_id, conceded_player_id, event_type, minute, period)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [matchId, teamId, playerId, assistPlayerId, concededPlayerId, eventType, minute || 1, period || '1T']
    );

    // Actualizar marcador y estadísticas según el tipo de evento
    if (eventType === 'goal') {
      await client.query(
        `UPDATE matches SET ${isHome ? 'home_score = home_score + 1' : 'away_score = away_score + 1'}, current_minute = $1 WHERE id = $2`,
        [minute || 1, matchId]
      );
      await client.query('UPDATE players SET goals = goals + 1 WHERE id = $1', [playerId]);
      if (concededPlayerId) {
        await client.query('UPDATE players SET goals_conceded = COALESCE(goals_conceded, 0) + 1 WHERE id = $1', [concededPlayerId]);
      }
      if (assistPlayerId) {
        await client.query('UPDATE players SET assists = assists + 1 WHERE id = $1', [assistPlayerId]);
      }
    } else if (eventType === 'yellow') {
      const newYellows = (playerCheck.rows[0].yellow_cards || 0) + 1;
      const newStatus = newYellows % 3 === 0 ? 'Suspendido' : 'Disponible';
      await client.query('UPDATE players SET yellow_cards = $1, status = $2 WHERE id = $3', [newYellows, newStatus, playerId]);
    } else if (eventType === 'red') {
      await client.query(`UPDATE players SET red_cards = red_cards + 1, status = 'Suspendido' WHERE id = $1`, [playerId]);
    }

    await client.query('COMMIT');

    // Emitir actualización en vivo a todos los dispositivos conectados
    const state = await broadcastState();
    io.emit('match_updated', { matchId: 'm-' + matchId, eventType, minute });

    res.json({ message: 'Evento oficial registrado y transmitido en vivo.', state });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// WebSockets con salas separadas (autenticados vs público) y sincronización de cronómetro en vivo
function assignSocketRoom(socket, rawToken) {
  let isAuth = false;
  if (rawToken) {
    try {
      const decoded = jwt.verify(String(rawToken), JWT_SECRET);
      if (decoded && (decoded.role === 'admin' || decoded.role === 'referee' || decoded.role === 'club')) {
        isAuth = true;
      }
    } catch (e) {
      isAuth = false;
    }
  }
  socket.leave('room:auth');
  socket.leave('room:public');
  socket.join(isAuth ? 'room:auth' : 'room:public');
}

io.on('connection', (socket) => {
  const initialToken = socket.handshake && socket.handshake.auth ? socket.handshake.auth.token : '';
  assignSocketRoom(socket, initialToken);

  socket.on('auth_sync', (payload) => {
    assignSocketRoom(socket, payload && payload.token ? payload.token : '');
  });

  socket.on('referee_clock_tick', (data) => {
    socket.broadcast.emit('live_clock_sync', data);
  });
});

// Enrutamiento de Vistas Web (SPA History API): permite abrir o recargar cualquier ruta directamente en el navegador
app.get('*/styles.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'styles.css'));
});

app.get('*/logo-liga-f7-caracas.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'logo-liga-f7-caracas.jpg'));
});

app.get(['/login', '/en-vivo', '/verificar/*', '/arbitro', '/arbitro/*', '/admin', '/admin/*', '/club', '/club/*'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
initDatabase().finally(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Servidor Liga F7 Caracas activo en puerto ${PORT}`);
  });
});
