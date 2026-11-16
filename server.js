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
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Conexión a PostgreSQL (Railway inyecta DATABASE_URL automáticamente)
const isLocalDb =
  !process.env.DATABASE_URL ||
  process.env.DATABASE_URL.includes('localhost') ||
  process.env.DATABASE_URL.includes('127.0.0.1');

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: isLocalDb ? false : { rejectUnauthorized: false }
    })
  : null;

let dbReady = false;
const JWT_SECRET = process.env.JWT_SECRET || 'clave_secreta_super_segura_cambiar_en_railway';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Extrae el ID numérico tanto de 'team-1' / 'p-5' como de '1' / 1
function parseId(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/^[a-z]+-/i, '');
  const num = parseInt(cleaned, 10);
  return Number.isNaN(num) ? null : num;
}

// ==========================================
// INICIALIZACIÓN AUTOMÁTICA Y SEED DE POSTGRESQL
// ==========================================
async function seedDemoData(client) {
  await client.query(`
    TRUNCATE TABLE match_events, matches, players, tournament_registrations, tournaments, teams, users, audit_logs
    RESTART IDENTITY CASCADE
  `);

  const passAdmin = await bcrypt.hash('admin123', 10);
  const passRef = await bcrypt.hash('ref123', 10);
  const passCentral = await bcrypt.hash('central123', 10);
  const passRayo = await bcrypt.hash('rayo123', 10);
  const passInter = await bcrypt.hash('inter123', 10);
  const passFuria = await bcrypt.hash('furia123', 10);

  // 1. Usuarios (IDs 1..6)
  await client.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES
      ('Ángel (Organizador General)', 'admin@angelarena.com', $1, 'admin'),
      ('Carlos Pitana (Árbitro Oficial)', 'ref@angelarena.com', $2, 'referee'),
      ('DT. Ricardo Gareca', 'dt.central@angelarena.com', $3, 'club'),
      ('DT. Marcelo Bielsa', 'dt.rayo@angelarena.com', $4, 'club'),
      ('DT. Diego Simeone', 'dt.inter@angelarena.com', $5, 'club'),
      ('DT. Luis Enrique', 'dt.furia@angelarena.com', $6, 'club')`,
    [passAdmin, passRef, passCentral, passRayo, passInter, passFuria]
  );

  // 2. Equipos (IDs 1..4)
  await client.query(`
    INSERT INTO teams (name, short_name, coach_name, owner_id, primary_color, pitch_mode, formation) VALUES
      ('Atlético Central FC', 'ATC', 'DT. Ricardo Gareca', 3, '#10B981', '5v5', '1-2-1'),
      ('Rayo Norte FC',       'RYN', 'DT. Marcelo Bielsa', 4, '#06B6D4', '5v5', '2-2'),
      ('Inter Urbano FC',     'ITU', 'DT. Diego Simeone',  5, '#F59E0B', '7v7', '2-3-1'),
      ('Furia Roja FC',       'FRJ', 'DT. Luis Enrique',   6, '#F43F5E', '7v7', '3-2-1')
  `);

  // 3. Torneos (IDs 1..2)
  await client.query(`
    INSERT INTO tournaments (name, format, pitch_size, max_teams, start_date, prize, status) VALUES
      ('Copa Nocturna Ángel Arena (5v5)', 'Liga + Playoffs',    '5v5', 8, '18 Nov 2026', '$3,500 USD + Trofeo',   'active'),
      ('Superliga Sintética Pro (7v7)',   'Todos contra Todos', '7v7', 8, '05 Dic 2026', '$5,000 USD + Medallas', 'open')
  `);

  // 4. Inscripciones a Torneos
  await client.query(`
    INSERT INTO tournament_registrations (tournament_id, team_id, status) VALUES
      (1, 1, 'approved'), (1, 2, 'approved'), (1, 3, 'approved'), (1, 4, 'approved'),
      (2, 2, 'approved'), (2, 3, 'approved')
  `);

  // 5. Jugadores (IDs 1..32)
  const initialPlayers = [
    // Team 1: Atlético Central FC (IDs 1..8)
    [1, 'Lucas Cavallini', 1, 'POR', true, 0, 1],
    [1, 'Carlos Zambrano', 4, 'DEF', true, 0, 2],
    [1, 'Mateo Torres', 8, 'MED', true, 2, 3],
    [1, 'Yeferson Soteldo', 11, 'MED', true, 0, 4],
    [1, 'Andrés Vega', 10, 'DEL', true, 3, 5],
    [1, 'Tomás Rincón', 6, 'MED', false, 0, 6],
    [1, 'Salomón Rondón', 23, 'DEL', false, 0, 7],
    [1, 'Alexander Callens', 2, 'DEF', false, 0, 8],
    // Team 2: Rayo Norte FC (IDs 9..15)
    [2, 'Pedro Gallese', 1, 'POR', true, 0, 1],
    [2, 'Rodrigo Tapia', 5, 'DEF', true, 0, 2],
    [2, 'Yoshimar Yotún', 14, 'MED', true, 0, 3],
    [2, 'Kevin Quevedo', 11, 'MED', true, 0, 4],
    [2, 'Diego Silva', 7, 'DEL', true, 1, 5],
    [2, 'Darwin Núñez', 9, 'DEL', false, 0, 6],
    [2, 'Ronald Araújo', 4, 'DEF', false, 0, 7],
    // Team 3: Inter Urbano FC (IDs 16..24)
    [3, 'Franco Armani', 1, 'POR', true, 0, 1],
    [3, 'Gonzalo Montiel', 2, 'DEF', true, 0, 2],
    [3, 'Cristian Romero', 6, 'DEF', true, 0, 3],
    [3, 'Carlos Mendoza', 10, 'MED', true, 0, 4],
    [3, 'Enzo Fernández', 5, 'MED', true, 0, 5],
    [3, 'Alexis Mac Allister', 8, 'MED', true, 0, 6],
    [3, 'Lautaro Díaz', 9, 'DEL', true, 1, 7],
    [3, 'Rodrigo De Paul', 19, 'MED', false, 0, 8],
    [3, 'Julián Álvarez', 22, 'DEL', false, 0, 9],
    // Team 4: Furia Roja FC (IDs 25..32)
    [4, 'Unai Simón', 1, 'POR', true, 0, 1],
    [4, 'Pau Cubarsí', 4, 'DEF', true, 0, 2],
    [4, 'Dani Carvajal', 3, 'DEF', true, 0, 3],
    [4, 'Rodri Hernández', 16, 'MED', true, 0, 4],
    [4, 'Pedri González', 8, 'MED', true, 0, 5],
    [4, 'Nico Williams', 7, 'DEL', true, 0, 6],
    [4, 'Álvaro Morata', 9, 'DEL', true, 0, 7],
    [4, 'Lamine Yamal', 19, 'DEL', false, 0, 8]
  ];

  for (const [teamId, fullName, dorsal, pos, isStarter, goals, sortOrder] of initialPlayers) {
    await client.query(
      `INSERT INTO players (team_id, full_name, dorsal, position, status, is_starter, coord_x, coord_y, goals, sort_order)
       VALUES ($1, $2, $3, $4, 'Disponible', $5, NULL, NULL, $6, $7)`,
      [teamId, fullName, dorsal, pos, isStarter, goals, sortOrder]
    );
  }

  // 6. Partidos (IDs 1..5)
  await client.query(`
    INSERT INTO matches (tournament_id, round_name, match_date, pitch_name, home_team_id, away_team_id, home_score, away_score, status, period, current_minute) VALUES
      (1, 'Jornada 1', 'Viernes • 20:00', 'Cancha 1 (Domo)',  1, 3, 3, 1, 'finished',  'FINAL', 40),
      (1, 'Jornada 1', 'Viernes • 21:00', 'Cancha 2 (Norte)', 2, 4, 2, 2, 'finished',  'FINAL', 40),
      (1, 'Jornada 2', 'Hoy • 20:00',     'Cancha 1 (Domo)',  1, 2, 2, 1, 'live',      '2T',    28),
      (1, 'Jornada 2', 'Hoy • 21:15',     'Cancha 1 (Domo)',  3, 4, 0, 0, 'scheduled', '1T',    0),
      (1, 'Jornada 3', 'Próximo Viernes', 'Cancha 1 (Domo)',  4, 1, 0, 0, 'scheduled', '1T',    0)
  `);

  // 7. Eventos de Partidos (Andrés Vega=5, Mateo Torres=3, Diego Silva=13, Lautaro Díaz=22)
  await client.query(`
    INSERT INTO match_events (match_id, team_id, player_id, event_type, minute, period) VALUES
      (1, 1, 5,  'goal', 10, '1T'),
      (1, 3, 22, 'goal', 18, '1T'),
      (1, 1, 3,  'goal', 26, '2T'),
      (1, 1, 5,  'goal', 35, '2T'),
      (3, 1, 5,  'goal', 9,  '1T'),
      (3, 2, 13, 'goal', 17, '1T'),
      (3, 1, 3,  'goal', 24, '2T')
  `);
}

async function initDatabase() {
  if (!pool) {
    console.log('ℹ️ Sin DATABASE_URL configurada: operando en modo autónomo.');
    return;
  }
  const client = await pool.connect();
  try {
    const schemaPath = path.join(__dirname, 'db', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await client.query(schemaSql);

    // Migraciones seguras por si las tablas ya existían de una versión previa
    await client.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS short_name VARCHAR(10) NOT NULL DEFAULT 'CLB'`);
    await client.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE players ALTER COLUMN coord_x DROP DEFAULT`);
    await client.query(`ALTER TABLE players ALTER COLUMN coord_y DROP DEFAULT`);
    await client.query(`ALTER TABLE tournaments ALTER COLUMN start_date TYPE VARCHAR(40) USING start_date::text`);

    const countRes = await client.query('SELECT COUNT(*) FROM users');
    if (parseInt(countRes.rows[0].count, 10) === 0) {
      await client.query('BEGIN');
      await seedDemoData(client);
      await client.query('COMMIT');
      console.log('✅ Base de datos PostgreSQL inicializada con datos demo de Ángel Arena.');
    } else {
      console.log('✅ Base de datos PostgreSQL conectada y lista.');
    }
    dbReady = true;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('⚠️ Error inicializando PostgreSQL:', err.message);
  } finally {
    client.release();
  }
}

async function getFullState(clientOrPool = pool) {
  const [tournamentsRes, regRes, teamsRes, playersRes, matchesRes, eventsRes] = await Promise.all([
    clientOrPool.query('SELECT * FROM tournaments ORDER BY id DESC'),
    clientOrPool.query("SELECT * FROM tournament_registrations WHERE status = 'approved' ORDER BY registered_at ASC"),
    clientOrPool.query('SELECT * FROM teams ORDER BY id ASC'),
    clientOrPool.query('SELECT * FROM players ORDER BY team_id ASC, sort_order ASC, id ASC'),
    clientOrPool.query('SELECT * FROM matches ORDER BY id ASC'),
    clientOrPool.query('SELECT * FROM match_events ORDER BY id ASC')
  ]);

  const regsByTourney = {};
  for (const r of regRes.rows) {
    const key = r.tournament_id;
    if (!regsByTourney[key]) regsByTourney[key] = [];
    regsByTourney[key].push('team-' + r.team_id);
  }

  return {
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
      color: tm.primary_color || '#10B981',
      pitchMode: tm.pitch_mode || '5v5',
      formation: tm.formation || (tm.pitch_mode === '7v7' ? '2-3-1' : '1-2-1')
    })),
    players: playersRes.rows.map((p) => ({
      id: 'p-' + p.id,
      teamId: 'team-' + p.team_id,
      number: p.dorsal,
      name: p.full_name,
      pos: p.position,
      status: p.status,
      starter: p.is_starter,
      customX: p.coord_x !== null ? Number(p.coord_x) : null,
      customY: p.coord_y !== null ? Number(p.coord_y) : null
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
      pitch: m.pitch_name
    })),
    events: eventsRes.rows.map((ev) => ({
      id: 'ev-' + ev.id,
      matchId: 'm-' + ev.match_id,
      teamId: 'team-' + ev.team_id,
      playerId: 'p-' + ev.player_id,
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

app.post('/api/system/reset', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedDemoData(client);
    await client.query('COMMIT');
    const state = await broadcastState();
    res.json({ message: 'Datos demo restaurados en PostgreSQL.', state });
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

app.post('/api/auth/register-club', async (req, res) => {
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

    const mode = pitchMode === '7v7' ? '7v7' : '5v5';
    const defaultFormation = mode === '7v7' ? '2-3-1' : '1-2-1';
    const cleanShort = (shortName || clubName.substring(0, 3) || 'CLB').toUpperCase().substring(0, 5);

    const teamIns = await client.query(
      `INSERT INTO teams (name, short_name, coach_name, owner_id, primary_color, pitch_mode, formation)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [clubName, cleanShort, coachName, newUser.id, primaryColor || '#10B981', mode, defaultFormation]
    );
    const numericTeamId = teamIns.rows[0].id;

    // Crear 9 jugadores iniciales para la plantilla del nuevo club
    const maxSt = mode === '7v7' ? 7 : 5;
    const sampleRoles = ['POR', 'DEF', 'DEF', 'MED', 'MED', 'DEL', 'DEL', 'MED', 'DEL'];
    for (let i = 0; i < 9; i++) {
      await client.query(
        `INSERT INTO players (team_id, full_name, dorsal, position, status, is_starter, coord_x, coord_y, sort_order)
         VALUES ($1, $2, $3, $4, 'Disponible', $5, NULL, NULL, $6)`,
        [numericTeamId, `Jugador ${i + 1} ${cleanShort}`, i === 0 ? 1 : i + 3, sampleRoles[i], i < maxSt, i + 1]
      );
    }

    await client.query(
      'INSERT INTO audit_logs (actor_email, actor_role, action_detail) VALUES ($1, $2, $3)',
      [newUser.email, 'club', `Registro de nuevo club: ${clubName}`]
    );

    await client.query('COMMIT');

    const token = jwt.sign(
      { id: newUser.id, name: newUser.name, email: newUser.email, role: 'club', teamId: numericTeamId },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    const state = await broadcastState();
    res.status(201).json({
      message: 'Club registrado exitosamente',
      token,
      teamId: 'team-' + numericTeamId,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: 'club',
        teamId: 'team-' + numericTeamId
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
    const { pitchMode, formation, resetPositions } = req.body;

    await client.query('BEGIN');

    if (pitchMode) {
      const mode = pitchMode === '7v7' ? '7v7' : '5v5';
      const defaultForm = formation || (mode === '7v7' ? '2-3-1' : '1-2-1');
      const maxSt = mode === '7v7' ? 7 : 5;

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

    // Consultar límite de cancha del equipo (5v5 -> 5 titulares, 7v7 -> 7 titulares)
    const teamRes = await client.query('SELECT pitch_mode FROM teams WHERE id = $1', [teamId]);
    const limit = teamRes.rows[0].pitch_mode === '7v7' ? 7 : 5;

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
    const { name, number, pos } = req.body;
    const maxOrderRes = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM players WHERE team_id = $1', [teamId]);
    const nextOrder = Number(maxOrderRes.rows[0].max_order) + 1;

    await pool.query(
      `INSERT INTO players (team_id, full_name, dorsal, position, status, is_starter, coord_x, coord_y, sort_order)
       VALUES ($1, $2, $3, $4, 'Disponible', FALSE, NULL, NULL, $5)`,
      [teamId, name, Number(number) || 10, pos || 'MED', nextOrder]
    );

    const state = await broadcastState();
    res.status(201).json({ message: 'Jugador fichado exitosamente.', state });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// 3. TORNEOS, INSCRIPCIONES Y FIXTURE
// ==========================================
app.post('/api/tournaments', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { name, pitchSize, maxTeams, startDate, prize } = req.body;
    const ins = await pool.query(
      `INSERT INTO tournaments (name, format, pitch_size, max_teams, start_date, prize, status)
       VALUES ($1, 'Liga + Playoffs', $2, $3, $4, $5, 'open') RETURNING id`,
      [name, pitchSize === '7v7' ? '7v7' : '5v5', Number(maxTeams) || 8, startDate, prize]
    );
    const state = await broadcastState();
    res.status(201).json({
      message: 'Torneo creado y publicado.',
      tournamentId: 'tour-' + ins.rows[0].id,
      state
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tournaments/:tournamentId/toggle-enrollment', authenticateToken, authorizeRoles('club'), async (req, res) => {
  try {
    const tournamentId = parseId(req.params.tournamentId);
    const teamId = parseId(req.user.teamId);

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

app.post('/api/tournaments/:tournamentId/generate-fixture', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const tournamentId = parseId(req.params.tournamentId);
    const tRes = await client.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
    if (tRes.rows.length === 0) return res.status(404).json({ error: 'Torneo no encontrado.' });
    const t = tRes.rows[0];

    const regRes = await client.query(
      "SELECT team_id FROM tournament_registrations WHERE tournament_id = $1 AND status = 'approved' ORDER BY registered_at ASC",
      [tournamentId]
    );
    const list = regRes.rows.map((r) => r.team_id);
    if (list.length < 2) {
      return res.status(400).json({ error: 'Se necesitan al menos 2 clubes inscritos para generar el calendario.' });
    }

    if (list.length % 2 !== 0) list.push('BYE');
    const rounds = list.length - 1;
    const half = list.length / 2;
    let created = 0;

    await client.query('BEGIN');
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < half; i++) {
        const h = list[i];
        const a = list[list.length - 1 - i];
        if (h !== 'BYE' && a !== 'BYE') {
          created++;
          await client.query(
            `INSERT INTO matches (tournament_id, round_name, match_date, pitch_name, home_team_id, away_team_id, home_score, away_score, status, period, current_minute)
             VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 'scheduled', '1T', 0)`,
            [tournamentId, `Jornada ${r + 1}`, `${t.start_date} • 20:00`, `Cancha 1 (${t.pitch_size})`, h, a]
          );
        }
      }
      list.splice(1, 0, list.pop());
    }
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
    const { status, minute } = req.body;

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
    const { eventType, minute, period } = req.body;

    await client.query('BEGIN');

    // Verificar que el jugador no esté suspendido
    const playerCheck = await client.query('SELECT status, yellow_cards FROM players WHERE id = $1', [playerId]);
    if (playerCheck.rows[0]?.status === 'Suspendido') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Jugador inhabilitado por sanción disciplinaria.' });
    }

    // Insertar evento
    await client.query(
      `INSERT INTO match_events (match_id, team_id, player_id, assist_player_id, event_type, minute, period)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [matchId, teamId, playerId, assistPlayerId, eventType, minute || 1, period || '1T']
    );

    // Actualizar marcador y estadísticas según el tipo de evento
    if (eventType === 'goal') {
      const mRes = await client.query('SELECT home_team_id FROM matches WHERE id = $1', [matchId]);
      const isHome = mRes.rows[0].home_team_id === Number(teamId);
      await client.query(
        `UPDATE matches SET ${isHome ? 'home_score = home_score + 1' : 'away_score = away_score + 1'}, current_minute = $1 WHERE id = $2`,
        [minute || 1, matchId]
      );
      await client.query('UPDATE players SET goals = goals + 1 WHERE id = $1', [playerId]);
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

const PORT = process.env.PORT || 3000;
initDatabase().finally(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Servidor Ángel Arena activo en puerto ${PORT}`);
  });
});
