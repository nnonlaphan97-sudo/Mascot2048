
export async function onRequest({ request, env }) {
  const reply = (data, status = 200) =>
    Response.json(data, {
      status,
      headers: {
        "Cache-Control": "no-store"
      }
    });

  if (request.method !== "POST") {
    return reply({ error: "method" }, 405);
  }

  try {
    const b = await request.json();

    // ตรวจสอบรหัสผ่านเจ้าของเกม
    if (
      !env.ADMIN_PASSWORD ||
      typeof b.password !== "string" ||
      b.password !== env.ADMIN_PASSWORD
    ) {
      return reply({ error: "unauthorized" }, 401);
    }

    const db = env.DB;
    const now = Date.now();
    const onlineTime = now - 120000;

    // จำนวนผู้เข้าชม
    const visitors = await db.prepare(`
      SELECT COUNT(*) AS total
      FROM player_activity
    `).first();

    // จำนวนผู้ลงทะเบียน
    const players = await db.prepare(`
      SELECT COUNT(*) AS total
      FROM players
    `).first();

    // จำนวนผู้ที่ออนไลน์ใน 2 นาทีล่าสุด
    const online = await db.prepare(`
      SELECT COUNT(*) AS total
      FROM player_activity
      WHERE last_seen >= ?
    `).bind(onlineTime).first();

    // จำนวนรอบที่เล่นทั้งหมด
    const games = await db.prepare(`
      SELECT COALESCE(SUM(games_played), 0) AS total
      FROM player_activity
    `).first();

    // รายชื่อผู้เล่นและคะแนน
    const { results: playerList } = await db.prepare(`
      SELECT
        p.id,
        p.playerName,
        p.playerTitle,
        p.avatarMascot,
        COALESCE(MAX(s.score), 0) AS bestScore,
        (
          SELECT MAX(a.last_seen)
          FROM player_activity a
          WHERE a.player_id = p.id
        ) AS lastSeen,
        (
          SELECT COALESCE(SUM(a.games_played), 0)
          FROM player_activity a
          WHERE a.player_id = p.id
        ) AS gamesPlayed
      FROM players p
      LEFT JOIN scores s ON s.playerId = p.id
      GROUP BY p.id
      ORDER BY lastSeen DESC, bestScore DESC
    `).all();

    // กิจกรรมล่าสุด
    const { results: recent } = await db.prepare(`
      SELECT
        a.mascot_id,
        a.first_seen,
        a.last_seen,
        a.visit_count,
        a.games_played,
        p.playerName,
        p.playerTitle,
        p.avatarMascot
      FROM player_activity a
      LEFT JOIN players p ON p.id = a.player_id
      ORDER BY a.last_seen DESC
      LIMIT 100
    `).all();

    // สถิติหลานจากผู้เล่นที่มีคะแนน
    const { results: popularity } = await db.prepare(`
      SELECT
        mascotId,
        COUNT(DISTINCT playerId) AS totalPlayers,
        MAX(score) AS bestScore
      FROM scores
      GROUP BY mascotId
      ORDER BY totalPlayers DESC, bestScore DESC
    `).all();

    return reply({
      ok: true,
      stats: {
        visitors: visitors.total,
        players: players.total,
        online: online.total,
        games: games.total
      },
      playerList,
      recent,
      popularity,
      updatedAt: now
    });

  } catch (e) {
    return reply({ error: "server" }, 500);
  }
}

