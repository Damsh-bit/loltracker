const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const RIOT_API_KEY = 'RGAPI-737ca089-8c17-4524-a3f2-8c01ce04f833';

// ─────────────────────────────────────────────
// CACHE EN MEMORIA
// ─────────────────────────────────────────────
const CACHE_TTL = {
  summoner: 10 * 60 * 1000,  // 10 min
  activity: 30 * 60 * 1000,  // 30 min
  matches:   5 * 60 * 1000,  //  5 min
};

const cache = {};

function cacheGet(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) { delete cache[key]; return null; }
  console.log('✓ CACHE HIT:', key);
  return entry.data;
}

function cacheSet(key, data, ttl) {
  cache[key] = { data, ts: Date.now(), ttl };
}

// ─────────────────────────────────────────────
// COLA GLOBAL DE REQUESTS — serializa todas las
// llamadas a Riot para nunca exceder el rate limit
// sin importar cuántos amigos se carguen a la vez
// ─────────────────────────────────────────────
const REQUEST_DELAY = 60; // ms entre requests (safe: 16/seg vs límite 20/seg)
let requestQueue = Promise.resolve();

function riotFetch(url) {
  // Encolar: cada request espera a que termine la anterior
  requestQueue = requestQueue.then(() => _doFetch(url));
  return requestQueue;
}

async function _doFetch(url, retries = 3) {
  await new Promise(r => setTimeout(r, REQUEST_DELAY));
  console.log('→', url.replace('https://', '').substring(0, 80));

  const res = await fetch(url, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
  const json = await res.json();

  if (res.status === 429 && retries > 0) {
    const wait = parseInt(res.headers.get('Retry-After') || '2') * 1000;
    console.log('⚠ Rate limit 429 — esperando', wait, 'ms, reintentos:', retries);
    await new Promise(r => setTimeout(r, wait));
    return _doFetch(url, retries - 1);
  }

  if (!res.ok) {
    const err = new Error(json && json.status ? json.status.message : 'HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ─────────────────────────────────────────────
// HOSTS
// ─────────────────────────────────────────────
const PLATFORM_HOSTS = {
  LAS: 'la2.api.riotgames.com', LAN: 'la1.api.riotgames.com',
  BR:  'br1.api.riotgames.com', NA:  'na1.api.riotgames.com',
  EUW: 'euw1.api.riotgames.com',EUNE:'eun1.api.riotgames.com',
  KR:  'kr.api.riotgames.com',  JP:  'jp1.api.riotgames.com',
  OCE: 'oc1.api.riotgames.com', TR:  'tr1.api.riotgames.com',
  RU:  'ru.api.riotgames.com',
};
const REGIONAL_HOSTS = {
  LAS: 'americas.api.riotgames.com', LAN: 'americas.api.riotgames.com',
  BR:  'americas.api.riotgames.com', NA:  'americas.api.riotgames.com',
  EUW: 'europe.api.riotgames.com',  EUNE:'europe.api.riotgames.com',
  TR:  'europe.api.riotgames.com',  RU:  'europe.api.riotgames.com',
  KR:  'asia.api.riotgames.com',    JP:  'asia.api.riotgames.com',
  OCE: 'sea.api.riotgames.com',
};

// ─────────────────────────────────────────────
// GET /api/summoner/:server/:name
// ─────────────────────────────────────────────
app.get('/api/summoner/:server/:name', async (req, res) => {
  const server   = req.params.server.toUpperCase();
  const name     = decodeURIComponent(req.params.name);
  const platform = PLATFORM_HOSTS[server];
  const regional = REGIONAL_HOSTS[server];
  if (!platform) return res.status(400).json({ error: 'Servidor invalido' });

  const cacheKey = 'summoner:' + server + ':' + name.toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    let gameName, tagLine;
    if (name.includes('#')) {
      const parts = name.split('#');
      gameName = parts[0].trim();
      tagLine  = parts[1].trim().toUpperCase();
    } else {
      gameName = name.trim();
      tagLine  = server;
    }

    const account = await riotFetch(
      'https://' + regional + '/riot/account/v1/accounts/by-riot-id/' +
      encodeURIComponent(gameName) + '/' + encodeURIComponent(tagLine)
    );

    const summoner = await riotFetch(
      'https://' + platform + '/lol/summoner/v4/summoners/by-puuid/' + account.puuid
    );

    const ranked = await riotFetch(
      'https://' + platform + '/lol/league/v4/entries/by-puuid/' + account.puuid
    );

    const soloQ = ranked.find(r => r.queueType === 'RANKED_SOLO_5x5') || null;
    const flexQ = ranked.find(r => r.queueType === 'RANKED_FLEX_SR')  || null;

    const result = {
      summoner: {
        puuid:         account.puuid,
        summonerLevel: summoner.summonerLevel,
        profileIconId: summoner.profileIconId,
        gameName:      account.gameName,
        tagLine:       account.tagLine,
      },
      soloQ, flexQ,
    };

    cacheSet(cacheKey, result, CACHE_TTL.summoner);
    res.json(result);
  } catch (err) {
    console.error('ERROR summoner:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/activity/:server/:puuid
//
// ESTRATEGIA OPTIMIZADA:
// En vez de traer cada partida individualmente,
// traemos páginas de 100 IDs (que incluyen el
// matchId con timestamp embebido) y calculamos
// actividad por día SIN hacer 100 requests.
//
// Los match IDs de Riot tienen el formato:
//   LA2_1569878212  — el número es unix timestamp
// Con eso armamos el heatmap con 1-3 requests
// en vez de 100.
// ─────────────────────────────────────────────
app.get('/api/activity/:server/:puuid', async (req, res) => {
  const server   = req.params.server.toUpperCase();
  const puuid    = req.params.puuid;
  const regional = REGIONAL_HOSTS[server];
  if (!regional) return res.status(400).json({ error: 'Servidor invalido' });

  const cacheKey = 'activity:' + server + ':' + puuid;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  const startTime = Math.floor((Date.now() / 1000) - 30 * 24 * 3600);

  try {
    // 1 sola request para los IDs del último mes
    const allIds = await riotFetch(
      'https://' + regional + '/lol/match/v5/matches/by-puuid/' + puuid +
      '/ids?start=0&count=100&startTime=' + startTime
    );

    console.log('Total IDs obtenidos:', allIds.length, '(sin requests individuales)');

    // Extraer fecha del match ID (ej: "LA2_1569878212" → timestamp 1569878212)
    // El número al final ES el unix timestamp de inicio de la partida
    const activityMap = {};
    allIds.forEach(matchId => {
      const parts = matchId.split('_');
      if (parts.length < 2) return;
      const ts = parseInt(parts[parts.length - 1]);
      if (isNaN(ts) || ts < 1000000000) return; // sanity check
      const dateStr = new Date(ts * 1000).toISOString().split('T')[0];
      if (!activityMap[dateStr]) activityMap[dateStr] = { date: dateStr, games: 0 };
      activityMap[dateStr].games++;
    });

    // Últimos 10 días para el gráfico
    const last10Days = [];
    for (let j = 9; j >= 0; j--) {
      const d = new Date();
      d.setDate(d.getDate() - j);
      const dateStr = d.toISOString().split('T')[0];
      const day = activityMap[dateStr] || { games: 0 };
      last10Days.push({ date: dateStr, games: day.games });
    }

    const result = { activityMap, last10Days, totalMatches: allIds.length };
    cacheSet(cacheKey, result, CACHE_TTL.activity);
    res.json(result);
  } catch (err) {
    console.error('ERROR activity:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/matches/:server/:puuid?count=5
// Solo para las últimas N partidas con detalle
// ─────────────────────────────────────────────
app.get('/api/matches/:server/:puuid', async (req, res) => {
  const server   = req.params.server.toUpperCase();
  const puuid    = req.params.puuid;
  const regional = REGIONAL_HOSTS[server];
  if (!regional) return res.status(400).json({ error: 'Servidor invalido' });

  const count    = Math.min(parseInt(req.query.count) || 20, 20);
  const cacheKey = 'matches:' + server + ':' + puuid + ':' + count;
  const cached   = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  const startTime = Math.floor((Date.now() / 1000) - 365 * 24 * 3600);

  try {
    const matchIds = await riotFetch(
      'https://' + regional + '/lol/match/v5/matches/by-puuid/' + puuid +
      '/ids?start=0&count=' + count + '&startTime=' + startTime
    );

    const matches = [];
    for (const id of matchIds) {
      try {
        const match = await riotFetch('https://' + regional + '/lol/match/v5/matches/' + id);
        matches.push(match);
      } catch(e) {
        console.error('Skipping match ' + id + ':', e.message);
      }
    }

    const result = { matches, total: matchIds.length };
    cacheSet(cacheKey, result, CACHE_TTL.matches);
    res.json(result);
  } catch (err) {
    console.error('ERROR matches:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// UTILIDADES DE CACHE
// ─────────────────────────────────────────────
app.get('/api/cache/clear', (req, res) => {
  const count = Object.keys(cache).length;
  Object.keys(cache).forEach(k => delete cache[k]);
  console.log('Cache limpiado:', count, 'entradas');
  res.json({ cleared: count });
});

app.get('/api/cache/status', (req, res) => {
  const entries = Object.keys(cache).map(k => ({
    key: k,
    age: Math.round((Date.now() - cache[k].ts) / 1000) + 's',
    expira_en: Math.round((cache[k].ttl - (Date.now() - cache[k].ts)) / 1000) + 's',
  }));
  res.json({ entries, total: entries.length });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log('✅ LoL Tracker backend en http://localhost:' + PORT);
  console.log('   API Key: ' + RIOT_API_KEY.substring(0, 12) + '...');
  console.log('   Modo: cola serializada (sin rate limit)');
});
