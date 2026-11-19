require('dotenv').config();
const fs = require('fs');
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const app = express();
// Necesario detrás de Cloudflare y el proxy inverso (Traefik/Caddy) de Coolify o Dokploy
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
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

  return new Pool({
    connectionString: url,
    ssl: useSsl ? { rejectUnauthorized: false } : false
  });
}

let pool = createDbPool();

let dbReady = false;
const JWT_SECRET = process.env.JWT_SECRET || 'clave_secreta_super_segura_cambiar_en_railway';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '25mb' }));
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
      await client.query(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS mvp_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL`);
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
    clientOrPool.query('SELECT * FROM players ORDER BY team_id ASC, sort_order ASC, id ASC'),
    clientOrPool.query('SELECT * FROM club_staff ORDER BY team_id ASC, id ASC'),
    clientOrPool.query('SELECT * FROM club_payments ORDER BY id DESC'),
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
    tournaments: tournamentsRes.rows.map((t) => ({
      id: 'tour-' + t.id,
      name: t.name,
      pitchSize: t.pitch_size,
      format: t.format,
      maxTeams: t.max_teams,
      startDate: String(t.start_date),
      prize: t.prize || '',
      status: t.status,
      teamIds: regsByTourney[t.id] || []
    })),
    teams: teamsRes.rows.map((tm) => ({
      id: 'team-' + tm.id,
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
        birthCertDoc: p.birth_cert_doc || null,
        playerIdDoc: p.player_id_doc || null,
        repIdDoc: p.rep_id_doc || null,
        specialConditionDoc: p.special_condition_doc || null,
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
      idDoc: s.id_doc || null,
      licenseDoc: s.license_doc || null
    })),
    payments: paymentsRes.rows.map((py) => ({
      id: 'pay-' + py.id,
      teamId: 'team-' + py.team_id,
      tournamentId: py.tournament_id ? 'tour-' + py.tournament_id : 'tour-1',
      concept: py.concept,
      amount: py.amount,
      method: py.method,
      reference: py.reference,
      date: py.payment_date,
      receiptDoc: py.receipt_doc || null,
      status: py.status || 'pending'
    })),
    matches: matchesRes.rows.map((m) => ({
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
      date: m.match_date,
      pitch: m.pitch_name,
      mvpPlayerId: m.mvp_player_id ? 'p-' + m.mvp_player_id : null
    })),
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

async function broadcastState() {
  if (!dbReady) return null;
  const state = await getFullState();
  io.emit('state_sync', state);
  return state;
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
// 0. ESTADO GLOBAL Y SALUD DEL SERVIDOR
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({ ok: true, dbReady });
});

app.get('/api/state', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const state = await getFullState();
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system/reset', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureOfficialAccounts(client);
    await client.query('COMMIT');
    const state = await broadcastState();
    res.json({ message: 'Cuentas oficiales verificadas en PostgreSQL.', state });
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
    const { email, password } = req.body;
    const userRes = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (userRes.rows.length === 0) return res.status(401).json({ error: 'Credenciales inválidas' });

    const user = userRes.rows[0];
    const validPass = await bcrypt.compare(password, user.password_hash);
    if (!validPass) return res.status(401).json({ error: 'Credenciales inválidas' });

    // Si es dueño de equipo, buscamos su club asignado
    let numericTeamId = null;
    if (user.role === 'club') {
      const teamRes = await pool.query('SELECT id FROM teams WHERE owner_id = $1', [user.id]);
      if (teamRes.rows.length > 0) numericTeamId = teamRes.rows[0].id;
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role, teamId: numericTeamId },
      JWT_SECRET,
      { expiresIn: '12h' }
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
  const client = await pool.connect();
  try {
    const { clubName, shortName, coachName, pitchMode, primaryColor, email, password } = req.body;
    await client.query('BEGIN');

    const hash = await bcrypt.hash(password, 10);
    const userIns = await client.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'club') RETURNING id, name, email, role`,
      [coachName, email.trim().toLowerCase(), hash]
    );
    const newUser = userIns.rows[0];

    const mode = pitchMode === '11v11' ? '11v11' : pitchMode === '7v7' ? '7v7' : '5v5';
    const defaultFormation = mode === '11v11' ? '4-3-3' : mode === '7v7' ? '2-3-1' : '1-2-1';
    const cleanShort = (shortName || clubName.substring(0, 3) || 'CLB').toUpperCase().substring(0, 5);

    const teamIns = await client.query(
      `INSERT INTO teams (name, short_name, coach_name, owner_id, primary_color, pitch_mode, formation)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [clubName, cleanShort, coachName, newUser.id, primaryColor || '#10B981', mode, defaultFormation]
    );
    const numericTeamId = teamIns.rows[0].id;

    await client.query(
      'INSERT INTO audit_logs (actor_email, actor_role, action_detail) VALUES ($1, $2, $3)',
      [req.user.email, 'admin', `Alta oficial de nuevo club: ${clubName} (${newUser.email})`]
    );

    await client.query('COMMIT');

    const state = await broadcastState();
    res.status(201).json({
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
    await client.query('ROLLBACK');
    res.status(400).json({ error: 'El correo o nombre del club ya está registrado.' });
  } finally {
    client.release();
  }
});

// ==========================================
// 2. GESTIÓN TÁCTICA Y LÍMITE ESTRICTO 5v5 / 7v7
// ==========================================
app.put('/api/teams/my-tactics', authenticateToken, authorizeRoles('club'), async (req, res) => {
  const client = await pool.connect();
  try {
    const teamId = parseId(req.user.teamId);
    const { pitchMode, formation, resetPositions, logoUrl, color, shortName, name } = req.body;

    await client.query('BEGIN');

    if (logoUrl !== undefined || color || shortName || name) {
      await client.query(
        `UPDATE teams SET
          logo_url = COALESCE($1, logo_url),
          primary_color = COALESCE($2, primary_color),
          short_name = COALESCE($3, short_name),
          name = COALESCE($4, name)
         WHERE id = $5`,
        [logoUrl !== undefined ? logoUrl : null, color || null, shortName || null, name || null, teamId]
      );
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
    const teamId = parseId(req.user.teamId);
    const playerId = parseId(req.params.playerId);
    const { customX, customY, swapWithPlayerId } = req.body;

    await client.query('BEGIN');

    const pRes = await client.query('SELECT * FROM players WHERE id = $1 AND team_id = $2', [playerId, teamId]);
    if (pRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Jugador no pertenece a tu club.' });
    }

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
    const teamId = parseId(req.user.teamId);
    const playerId = parseId(req.params.playerId);
    const replacePlayerId = req.body.replacePlayerId ? parseId(req.body.replacePlayerId) : null;

    // Verificar que el jugador pertenezca al club del DT autenticado
    const pRes = await client.query('SELECT * FROM players WHERE id = $1 AND team_id = $2', [playerId, teamId]);
    if (pRes.rows.length === 0) return res.status(403).json({ error: 'No puedes modificar jugadores de otro club.' });

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
    const teamId = parseId(req.user.teamId);
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

    // Verificar que el dorsal no esté ocupado en el mismo club
    const dupCheck = await pool.query(
      'SELECT id, full_name FROM players WHERE team_id = $1 AND dorsal = $2',
      [teamId, dorsal]
    );
    if (dupCheck.rows.length > 0) {
      return res.status(409).json({
        error: `El dorsal #${dorsal} ya está ocupado en tu club por ${dupCheck.rows[0].full_name}.`
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
      const teamId = parseId(req.user.teamId);
      await pool.query('DELETE FROM players WHERE id = $1 AND team_id = $2', [playerId, teamId]);
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
    await pool.query(
      `INSERT INTO matches (tournament_id, round_name, match_date, pitch_name, home_team_id, away_team_id, home_score, away_score, status, period, current_minute)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 'scheduled', '1T', 0)`,
      [tId, round || 'Jornada Especial', date || 'Por definir', pitch || 'Cancha Principal', hId, aId]
    );
    const state = await broadcastState();
    res.status(201).json({ message: 'Partido programado manualmente.', state });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/matches/:matchId', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const matchId = parseId(req.params.matchId);
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
    const teamId = parseId(req.user.teamId);
    const { tournamentId, concept, amount, method, reference, date, receiptDoc } = req.body;
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
  try {
    const { name, pitchSize, category, maxTeams, startDate, prize } = req.body;
    const cleanSize = pitchSize === '11v11' ? '11v11' : pitchSize === '7v7' ? '7v7' : '5v5';
    const formatText = category ? `Liga + Playoffs (${category})` : 'Liga + Playoffs';
    const limitTeams = Number(maxTeams) || 8;

    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO tournaments (name, format, pitch_size, max_teams, start_date, prize, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'open') RETURNING id`,
      [name, formatText, cleanSize, limitTeams, startDate, prize]
    );
    const newTourneyId = ins.rows[0].id;

    // Inscribir automáticamente a todos los clubes existentes (hasta el cupo máximo)
    const teamsRes = await client.query('SELECT id FROM teams ORDER BY id ASC LIMIT $1', [limitTeams]);
    for (const tm of teamsRes.rows) {
      await client.query(
        "INSERT INTO tournament_registrations (tournament_id, team_id, status) VALUES ($1, $2, 'approved') ON CONFLICT DO NOTHING",
        [newTourneyId, tm.id]
      );
    }
    await client.query('COMMIT');

    const state = await broadcastState();
    res.status(201).json({
      message: 'Torneo creado y publicado.',
      tournamentId: 'tour-' + newTourneyId,
      state
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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
    const { round, date, pitch } = req.body;
    await pool.query(
      `UPDATE matches SET
        round_name = COALESCE($1, round_name),
        match_date = COALESCE($2, match_date),
        pitch_name = COALESCE($3, pitch_name)
       WHERE id = $4`,
      [round || null, date || null, pitch || null, matchId]
    );
    const state = await broadcastState();
    res.json({ message: 'Horario y cancha del partido actualizados.', state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tournaments/:tournamentId/toggle-enrollment', authenticateToken, authorizeRoles('club', 'admin'), async (req, res) => {
  try {
    const tournamentId = parseId(req.params.tournamentId);
    const teamId = req.user.role === 'admin' && req.body.teamId ? parseId(req.body.teamId) : parseId(req.user.teamId);

    const existing = await pool.query(
      'SELECT * FROM tournament_registrations WHERE tournament_id = $1 AND team_id = $2',
      [tournamentId, teamId]
    );
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM tournament_registrations WHERE tournament_id = $1 AND team_id = $2', [tournamentId, teamId]);
    } else {
      await pool.query(
        "INSERT INTO tournament_registrations (tournament_id, team_id, status) VALUES ($1, $2, 'approved')",
        [tournamentId, teamId]
      );
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

    // Si hay menos de 2 clubes inscritos, incluir todos los clubes existentes automáticamente
    if (regRes.rows.length < 2) {
      const allTeams = await client.query('SELECT id FROM teams ORDER BY id ASC LIMIT $1', [t.max_teams || 8]);
      for (const tm of allTeams.rows) {
        await client.query(
          "INSERT INTO tournament_registrations (tournament_id, team_id, status) VALUES ($1, $2, 'approved') ON CONFLICT DO NOTHING",
          [tournamentId, tm.id]
        );
      }
      regRes = await client.query(
        "SELECT team_id FROM tournament_registrations WHERE tournament_id = $1 AND status = 'approved' ORDER BY registered_at ASC",
        [tournamentId]
      );
    }

    const list = regRes.rows.map((r) => r.team_id);
    if (list.length < 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Se necesitan al menos 2 clubes en el sistema para generar el calendario.' });
    }

    // Eliminar partidos programados previos de este torneo para regenerar limpio
    await client.query("DELETE FROM matches WHERE tournament_id = $1 AND status = 'scheduled'", [tournamentId]);

    if (list.length % 2 !== 0) list.push('BYE');
    const rounds = list.length - 1;
    const half = list.length / 2;
    const timeSlots = ['19:00', '20:15', '21:30', '22:30'];
    let created = 0;

    for (let r = 0; r < rounds; r++) {
      let slotIdx = 0;
      for (let i = 0; i < half; i++) {
        const h = list[i];
        const a = list[list.length - 1 - i];
        if (h !== 'BYE' && a !== 'BYE') {
          created++;
          const matchHour = timeSlots[slotIdx % timeSlots.length];
          const pitchNum = (slotIdx % 2) + 1;
          slotIdx++;
          await client.query(
            `INSERT INTO matches (tournament_id, round_name, match_date, pitch_name, home_team_id, away_team_id, home_score, away_score, status, period, current_minute)
             VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 'scheduled', '1T', 0)`,
            [tournamentId, `Jornada ${r + 1}`, `${t.start_date} • ${matchHour}`, `Cancha ${pitchNum} (${t.pitch_size})`, h, a]
          );
        }
      }
      list.splice(1, 0, list.pop());
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
app.put('/api/matches/:matchId/state', authenticateToken, authorizeRoles('referee', 'admin'), async (req, res) => {
  try {
    const matchId = parseId(req.params.matchId);
    const { status, minute, period, mvpPlayerId } = req.body;

    if (status && minute !== undefined) {
      await pool.query('UPDATE matches SET status = $1, current_minute = $2 WHERE id = $3', [status, minute, matchId]);
    } else if (status) {
      await pool.query(
        'UPDATE matches SET status = $1, current_minute = CASE WHEN $1 = \'live\' AND current_minute = 0 THEN 1 ELSE current_minute END WHERE id = $2',
        [status, matchId]
      );
    } else if (minute !== undefined) {
      await pool.query('UPDATE matches SET current_minute = $1 WHERE id = $2', [minute, matchId]);
    }
    if (period) {
      await pool.query('UPDATE matches SET period = $1 WHERE id = $2', [period, matchId]);
    }
    if (mvpPlayerId !== undefined) {
      const mvpIdNum = mvpPlayerId ? parseId(mvpPlayerId) : null;
      await pool.query('UPDATE matches SET mvp_player_id = $1 WHERE id = $2', [mvpIdNum, matchId]);
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

// WebSockets para sincronizar el cronómetro en vivo
io.on('connection', (socket) => {
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
