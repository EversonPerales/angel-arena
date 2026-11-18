-- Extensión opcional por si deseas usar UUIDs en el futuro
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Tabla de Usuarios (RBAC: admin, referee, club)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'referee', 'club')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Tabla de Equipos (Clubes)
CREATE TABLE IF NOT EXISTS teams (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    short_name VARCHAR(10) NOT NULL DEFAULT 'CLB',
    coach_name VARCHAR(120) NOT NULL,
    owner_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    primary_color VARCHAR(15) DEFAULT '#10b981',
    logo_url TEXT,
    pitch_mode VARCHAR(10) DEFAULT '5v5' CHECK (pitch_mode IN ('5v5', '7v7', '11v11')),
    formation VARCHAR(15) DEFAULT '1-2-1',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Tabla de Torneos
CREATE TABLE IF NOT EXISTS tournaments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    format VARCHAR(50) NOT NULL DEFAULT 'Liga Regular',
    pitch_size VARCHAR(10) NOT NULL DEFAULT '5v5' CHECK (pitch_size IN ('5v5', '7v7', '11v11')),
    max_teams INTEGER NOT NULL DEFAULT 8,
    start_date VARCHAR(40) NOT NULL,
    prize VARCHAR(120),
    status VARCHAR(25) DEFAULT 'open' CHECK (status IN ('open', 'active', 'finished')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Inscripciones de Equipos en Torneos (Tabla Pivote)
CREATE TABLE IF NOT EXISTS tournament_registrations (
    tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected')),
    registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tournament_id, team_id)
);

-- 5. Tabla de Jugadores (Plantilla + Expediente Documental + Pizarra Táctica 2D + Estadísticas)
CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    full_name VARCHAR(120) NOT NULL,
    first_name VARCHAR(80),
    last_name VARCHAR(80),
    birth_date VARCHAR(25),
    id_number VARCHAR(30),
    school_join_date VARCHAR(25),
    rep_id_number VARCHAR(30),
    has_special_condition BOOLEAN DEFAULT FALSE,
    special_condition_detail TEXT,
    photo_url TEXT,
    birth_cert_doc TEXT,
    player_id_doc TEXT,
    rep_id_doc TEXT,
    special_condition_doc TEXT,
    doc_status VARCHAR(20) DEFAULT 'approved',
    dorsal INTEGER NOT NULL CHECK (dorsal BETWEEN 1 AND 99),
    position VARCHAR(5) NOT NULL CHECK (position IN ('POR', 'DEF', 'MED', 'DEL')),
    status VARCHAR(20) DEFAULT 'Disponible' CHECK (status IN ('Disponible', 'Lesionado', 'Suspendido')),
    is_starter BOOLEAN DEFAULT FALSE,
    coord_x NUMERIC(5,2) DEFAULT NULL,
    coord_y NUMERIC(5,2) DEFAULT NULL,
    goals INTEGER DEFAULT 0,
    assists INTEGER DEFAULT 0,
    yellow_cards INTEGER DEFAULT 0,
    red_cards INTEGER DEFAULT 0,
    mvp_awards INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    UNIQUE (team_id, dorsal)
);

-- 6. Tabla de Cuerpo Técnico por Club (Con Documentos de Respaldo)
CREATE TABLE IF NOT EXISTS club_staff (
    id SERIAL PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    first_name VARCHAR(80) NOT NULL,
    last_name VARCHAR(80) NOT NULL,
    role_title VARCHAR(60) NOT NULL,
    id_number VARCHAR(30) NOT NULL,
    birth_date VARCHAR(25),
    phone VARCHAR(30),
    join_date VARCHAR(25),
    id_doc TEXT NOT NULL,
    license_doc TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Tabla de Partidos (Calendario / Fixture)
CREATE TABLE IF NOT EXISTS matches (
    id SERIAL PRIMARY KEY,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    round_name VARCHAR(40) NOT NULL,
    match_date VARCHAR(40) NOT NULL,
    pitch_name VARCHAR(60) DEFAULT 'Cancha Principal',
    home_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    away_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    home_score INTEGER DEFAULT 0,
    away_score INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'finished')),
    period VARCHAR(10) DEFAULT '1T',
    current_minute INTEGER DEFAULT 0,
    mvp_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL
);

-- 8. Eventos del Partido (Goles, Asistencias, Tarjetas, Cambios)
CREATE TABLE IF NOT EXISTS match_events (
    id SERIAL PRIMARY KEY,
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    assist_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
    event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('goal', 'yellow', 'red', 'sub')),
    minute INTEGER NOT NULL,
    period VARCHAR(10) DEFAULT '1T',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 9. Tabla de Pagos y Solvencia de Clubes (Inscripción y Arbitraje)
CREATE TABLE IF NOT EXISTS club_payments (
    id SERIAL PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    tournament_id INTEGER REFERENCES tournaments(id) ON DELETE SET NULL,
    concept VARCHAR(120) NOT NULL,
    amount VARCHAR(40) NOT NULL,
    method VARCHAR(40) NOT NULL,
    reference VARCHAR(60) NOT NULL,
    payment_date VARCHAR(30) NOT NULL,
    receipt_doc TEXT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 10. Bitácora de Auditoría de Seguridad
CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    actor_email VARCHAR(150) NOT NULL,
    actor_role VARCHAR(30) NOT NULL,
    action_detail TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
