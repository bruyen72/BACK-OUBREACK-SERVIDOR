const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const WORLD_SIZE = 3000;
const FPS = 30;
const TICK_RATE = 1000 / FPS;
const FOOD_COUNT = 300;
const ONLINE_BOT_COUNT = 24;
const FOOD_MASS_GAIN_BASE = 0.12;
const FOOD_MASS_GAIN_MIN = 0.01;
const FOOD_MASS_GAIN_MASS_FACTOR = 0.06;
const PLAYER_ABSORB_MULT = 0.35;
const BOT_ABSORB_MULT = 0.3;
const TURBO_DRAIN_MIN_PER_SEC = 1.2;
const TURBO_DRAIN_RATIO_PER_SEC = 0.05;
const TURBO_DRAIN_MAX_PER_SEC = 20000;
const TURBO_SCORE_DRAIN_PER_MASS = 120;

const PLAY_MODES = {
  ONLINE: 'online',
  ONLINE_BOTS: 'online_bots',
};

const PLAYER_SKINS = [
  { c1: [0, 255, 179], c2: [0, 171, 255] },
  { c1: [255, 204, 0], c2: [255, 102, 0] },
  { c1: [255, 51, 0], c2: [204, 0, 0] },
  { c1: [0, 204, 255], c2: [0, 102, 204] },
  { c1: [153, 0, 255], c2: [77, 0, 153] },
  { c1: [108, 184, 255], c2: [45, 78, 176] },
  { c1: [93, 255, 188], c2: [12, 110, 95] },
  { c1: [255, 145, 62], c2: [170, 36, 12] },
  { c1: [190, 216, 255], c2: [86, 122, 192] },
];

const BOT_NAMES = ['Relampago', 'Sombra', 'Fenix', 'Fantasma', 'Tornado', 'Estrela', 'Trovoada', 'Aguia'];
const BOT_COLORS = [
  [[255, 51, 102], [255, 102, 153]],
  [[255, 120, 0], [255, 199, 51]],
  [[255, 219, 0], [255, 255, 102]],
  [[51, 255, 153], [0, 204, 102]],
  [[0, 199, 255], [0, 102, 255]],
  [[199, 0, 255], [255, 0, 199]],
  [[255, 0, 153], [255, 102, 204]],
  [[153, 255, 0], [102, 199, 0]],
];

const FOOD_COLORS = [
  [255, 51, 102], [255, 120, 0], [255, 219, 0], [51, 255, 153], [0, 199, 255],
  [199, 0, 255], [0, 255, 199], [255, 0, 153], [153, 255, 0], [0, 153, 255],
];

const socketMode = new Map();

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function randomInt(min, max) {
  return Math.floor(randomFloat(min, max + 1));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function massToRadius(mass) {
  return 35 * Math.pow(mass, 0.55);
}

function radiusToMass(radius) {
  return Math.pow(Math.max(1, radius) / 35, 1 / 0.55);
}

const WORLD_EDGE_MARGIN = 20;
const MAX_CELL_RADIUS = WORLD_SIZE * 0.5 - WORLD_EDGE_MARGIN;
const MAX_CELL_MASS = radiusToMass(MAX_CELL_RADIUS);

function clampCellMass(mass) {
  return clamp(Number.isFinite(mass) ? mass : 1, 1, MAX_CELL_MASS);
}

function computeFoodMassGain(mass) {
  const safeMass = Math.max(1, Number.isFinite(mass) ? mass : 1);
  const scaledGain = FOOD_MASS_GAIN_BASE / (1 + safeMass * FOOD_MASS_GAIN_MASS_FACTOR);
  return Math.max(FOOD_MASS_GAIN_MIN, scaledGain);
}

function computeTurboMassDrainPerSec(mass) {
  const safeMass = Math.max(1, Number.isFinite(mass) ? mass : 1);
  const scaled = safeMass * TURBO_DRAIN_RATIO_PER_SEC;
  return clamp(scaled, TURBO_DRAIN_MIN_PER_SEC, TURBO_DRAIN_MAX_PER_SEC);
}

function setEntityMass(entity, nextMass) {
  entity.mass = clampCellMass(nextMass);
  entity.r = Math.min(MAX_CELL_RADIUS, massToRadius(entity.mass));
}

function getEntityWallRadius(entity) {
  return Math.min(Number.isFinite(entity?.r) ? entity.r : massToRadius(1), MAX_CELL_RADIUS);
}

function makeFood() {
  return {
    id: Math.random().toString(36).slice(2, 11),
    x: randomFloat(50, WORLD_SIZE - 50),
    y: randomFloat(50, WORLD_SIZE - 50),
    r: randomFloat(5, 10),
    color: FOOD_COLORS[randomInt(0, FOOD_COLORS.length - 1)],
    pulse: randomFloat(0, Math.PI * 2),
  };
}

function makePlayer(id, rawName, rawSkinId) {
  const skinId = clamp(Number(rawSkinId) || 0, 0, PLAYER_SKINS.length - 1);
  const skin = PLAYER_SKINS[skinId];
  const name = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim().slice(0, 16) : 'Player';
  return {
    id,
    isBot: false,
    name,
    skinId,
    color1: skin.c1,
    color2: skin.c2,
    x: randomFloat(100, WORLD_SIZE - 100),
    y: randomFloat(100, WORLD_SIZE - 100),
    mass: 1,
    r: massToRadius(1),
    score: 0,
    pulse: randomFloat(0, Math.PI * 2),
    targetX: WORLD_SIZE / 2,
    targetY: WORLD_SIZE / 2,
    vx: 0,
    vy: 0,
    turbo: false,
  };
}

function makeBot(index) {
  const [c1, c2] = BOT_COLORS[index % BOT_COLORS.length];
  const skinId = randomInt(0, PLAYER_SKINS.length - 1);
  return {
    id: `bot_${index}`,
    isBot: true,
    name: BOT_NAMES[index % BOT_NAMES.length],
    skinId,
    color1: c1,
    color2: c2,
    x: randomFloat(100, WORLD_SIZE - 100),
    y: randomFloat(100, WORLD_SIZE - 100),
    mass: 1,
    r: massToRadius(1),
    score: 0,
    pulse: randomFloat(0, Math.PI * 2),
    targetX: randomFloat(100, WORLD_SIZE - 100),
    targetY: randomFloat(100, WORLD_SIZE - 100),
    vx: 0,
    vy: 0,
    turbo: false,
    retarget: 0,
  };
}

function createWorld(mode) {
  const foods = Array.from({ length: FOOD_COUNT }, () => makeFood());
  const bots = mode === PLAY_MODES.ONLINE_BOTS
    ? Array.from({ length: ONLINE_BOT_COUNT }, (_, i) => makeBot(i))
    : [];
  return {
    mode,
    players: {},
    foods,
    bots,
  };
}

const worlds = {
  [PLAY_MODES.ONLINE]: createWorld(PLAY_MODES.ONLINE),
  [PLAY_MODES.ONLINE_BOTS]: createWorld(PLAY_MODES.ONLINE_BOTS),
};

function normalizeMode(mode) {
  return mode === PLAY_MODES.ONLINE_BOTS ? PLAY_MODES.ONLINE_BOTS : PLAY_MODES.ONLINE;
}

function serializeEntity(entity) {
  return {
    id: entity.id,
    isBot: !!entity.isBot,
    name: entity.name,
    skinId: entity.skinId,
    type: entity.skinId,
    color1: entity.color1,
    color2: entity.color2,
    x: entity.x,
    y: entity.y,
    mass: entity.mass,
    r: entity.r,
    pulse: entity.pulse,
    score: entity.score,
    turbo: !!entity.turbo,
  };
}

function broadcastState(mode) {
  const world = worlds[mode];
  io.to(mode).emit('state_update', {
    players: Object.values(world.players).map(serializeEntity),
    bots: world.bots.map(serializeEntity),
    foods: world.foods,
  });
}

function updatePlayerMovement(entity, dtSeconds) {
  const dx = entity.targetX - entity.x;
  const dy = entity.targetY - entity.y;
  const d = Math.hypot(dx, dy) + 0.001;

  let speed = 4.5 / Math.max(1, Math.pow(entity.r / 25, 0.4));
  if (entity.turbo && entity.mass > 1.05) {
    speed *= 2.3;
    const massBeforeTurbo = entity.mass;
    const turboDrain = computeTurboMassDrainPerSec(entity.mass) * dtSeconds;
    setEntityMass(entity, entity.mass - turboDrain);
    const massLostTurbo = Math.max(0, massBeforeTurbo - entity.mass);
    if (massLostTurbo > 0) {
      entity.score = Math.max(0, entity.score - massLostTurbo * TURBO_SCORE_DRAIN_PER_MASS);
    }
  }

  if (d > entity.r * 0.3) {
    entity.vx += (dx / d) * speed * 0.25;
    entity.vy += (dy / d) * speed * 0.25;
  }

  entity.vx *= 0.84;
  entity.vy *= 0.84;
  const wallR = getEntityWallRadius(entity);
  entity.x = clamp(entity.x + entity.vx, wallR, WORLD_SIZE - wallR);
  entity.y = clamp(entity.y + entity.vy, wallR, WORLD_SIZE - wallR);
}

function updateBotTarget(bot, world) {
  bot.retarget -= 1;
  if (bot.retarget > 0) return;

  bot.retarget = randomInt(15, 30);
  const players = Object.values(world.players);
  const threats = [];
  const preys = [];

  for (const p of players) {
    const d = distance(bot.x, bot.y, p.x, p.y);
    if (d < 1000) {
      if (p.mass > bot.mass * 1.1) threats.push(p);
      else if (bot.mass > p.mass * 1.1) preys.push(p);
    }
  }

  for (const other of world.bots) {
    if (other.id === bot.id) continue;
    const d = distance(bot.x, bot.y, other.x, other.y);
    if (d < 1000) {
      if (other.mass > bot.mass * 1.1) threats.push(other);
      else if (bot.mass > other.mass * 1.1) preys.push(other);
    }
  }

  if (threats.length > 0) {
    let nearest = threats[0];
    let best = distance(bot.x, bot.y, nearest.x, nearest.y);
    for (let i = 1; i < threats.length; i += 1) {
      const d = distance(bot.x, bot.y, threats[i].x, threats[i].y);
      if (d < best) {
        best = d;
        nearest = threats[i];
      }
    }
    const angle = Math.atan2(bot.y - nearest.y, bot.x - nearest.x);
    bot.targetX = bot.x + Math.cos(angle) * 1000;
    bot.targetY = bot.y + Math.sin(angle) * 1000;
  } else if (preys.length > 0) {
    let nearest = preys[0];
    let best = distance(bot.x, bot.y, nearest.x, nearest.y);
    for (let i = 1; i < preys.length; i += 1) {
      const d = distance(bot.x, bot.y, preys[i].x, preys[i].y);
      if (d < best) {
        best = d;
        nearest = preys[i];
      }
    }
    bot.targetX = nearest.x;
    bot.targetY = nearest.y;
  } else {
    let targetFood = null;
    let bestFoodDist = Number.POSITIVE_INFINITY;
    for (const f of world.foods) {
      const d = distance(bot.x, bot.y, f.x, f.y);
      if (d < bestFoodDist) {
        bestFoodDist = d;
        targetFood = f;
      }
    }
    if (targetFood && bestFoodDist < 1500) {
      bot.targetX = targetFood.x;
      bot.targetY = targetFood.y;
    } else {
      bot.targetX = randomFloat(100, WORLD_SIZE - 100);
      bot.targetY = randomFloat(100, WORLD_SIZE - 100);
    }
  }

  bot.targetX = clamp(bot.targetX, 50, WORLD_SIZE - 50);
  bot.targetY = clamp(bot.targetY, 50, WORLD_SIZE - 50);
}

function updateBotMovement(bot) {
  const dx = bot.targetX - bot.x;
  const dy = bot.targetY - bot.y;
  const d = Math.hypot(dx, dy) + 0.001;
  const speed = 3.5 / Math.max(1, Math.pow(bot.r / 25, 0.5));

  bot.vx += (dx / d) * speed * 0.25;
  bot.vy += (dy / d) * speed * 0.25;
  bot.vx *= 0.85;
  bot.vy *= 0.85;
  const wallR = getEntityWallRadius(bot);

  let nx = bot.x + bot.vx;
  let ny = bot.y + bot.vy;
  let hitWall = false;

  if (nx <= wallR) {
    nx = wallR;
    bot.vx *= -1;
    hitWall = true;
  } else if (nx >= WORLD_SIZE - wallR) {
    nx = WORLD_SIZE - wallR;
    bot.vx *= -1;
    hitWall = true;
  }

  if (ny <= wallR) {
    ny = wallR;
    bot.vy *= -1;
    hitWall = true;
  } else if (ny >= WORLD_SIZE - wallR) {
    ny = WORLD_SIZE - wallR;
    bot.vy *= -1;
    hitWall = true;
  }

  if (hitWall) {
    bot.targetX = WORLD_SIZE / 2 + randomFloat(-500, 500);
    bot.targetY = WORLD_SIZE / 2 + randomFloat(-500, 500);
    bot.retarget = 15;
  }

  bot.x = nx;
  bot.y = ny;
}

function applyFoodCollisions(world) {
  const eaters = [...Object.values(world.players), ...world.bots];
  for (const eater of eaters) {
    for (let i = world.foods.length - 1; i >= 0; i -= 1) {
      const food = world.foods[i];
      if (distance(food.x, food.y, eater.x, eater.y) < eater.r) {
        setEntityMass(eater, eater.mass + computeFoodMassGain(eater.mass));
        eater.score += 10;
        world.foods.splice(i, 1);
        world.foods.push(makeFood());
      }
    }
  }
}

function resolveWorldCollisions(world, mode) {
  const removedPlayers = new Set();
  const players = Object.values(world.players);

  for (let i = 0; i < players.length; i += 1) {
    const p1 = players[i];
    if (removedPlayers.has(p1.id)) continue;
    for (let j = i + 1; j < players.length; j += 1) {
      const p2 = players[j];
      if (removedPlayers.has(p2.id)) continue;
      const d = distance(p1.x, p1.y, p2.x, p2.y);
      if (d < p1.r - p2.r * 0.3 && p1.mass > p2.mass * 1.1) {
        setEntityMass(p1, p1.mass + p2.mass * PLAYER_ABSORB_MULT);
        p1.score += p2.score + 50;
        removedPlayers.add(p2.id);
        io.to(p2.id).emit('death', { killer: p1.name });
      } else if (d < p2.r - p1.r * 0.3 && p2.mass > p1.mass * 1.1) {
        setEntityMass(p2, p2.mass + p1.mass * PLAYER_ABSORB_MULT);
        p2.score += p1.score + 50;
        removedPlayers.add(p1.id);
        io.to(p1.id).emit('death', { killer: p2.name });
      }
    }
  }

  if (mode === PLAY_MODES.ONLINE_BOTS) {
    const removedBots = new Set();
    for (const p of players) {
      if (removedPlayers.has(p.id)) continue;
      for (const bot of world.bots) {
        if (removedBots.has(bot.id)) continue;
        const d = distance(p.x, p.y, bot.x, bot.y);
        if (d < p.r - bot.r * 0.3 && p.mass > bot.mass * 1.1) {
          setEntityMass(p, p.mass + bot.mass * PLAYER_ABSORB_MULT);
          p.score += bot.score + 40;
          removedBots.add(bot.id);
        } else if (d < bot.r - p.r * 0.3 && bot.mass > p.mass * 1.1) {
          const defeatedMass = p.mass;
          const defeatedScore = p.score;
          removedPlayers.add(p.id);
          setEntityMass(bot, bot.mass + defeatedMass * BOT_ABSORB_MULT);
          bot.score += defeatedScore + 40;
          io.to(p.id).emit('death', { killer: bot.name });
          break;
        }
      }
    }

    for (let i = 0; i < world.bots.length; i += 1) {
      const b1 = world.bots[i];
      if (removedBots.has(b1.id)) continue;
      for (let j = i + 1; j < world.bots.length; j += 1) {
        const b2 = world.bots[j];
        if (removedBots.has(b2.id)) continue;
        const d = distance(b1.x, b1.y, b2.x, b2.y);
        if (d < b1.r - b2.r * 0.3 && b1.mass > b2.mass * 1.1) {
          setEntityMass(b1, b1.mass + b2.mass * BOT_ABSORB_MULT);
          b1.score += Math.floor(b2.score / 2);
          removedBots.add(b2.id);
        } else if (d < b2.r - b1.r * 0.3 && b2.mass > b1.mass * 1.1) {
          setEntityMass(b2, b2.mass + b1.mass * BOT_ABSORB_MULT);
          b2.score += Math.floor(b1.score / 2);
          removedBots.add(b1.id);
          break;
        }
      }
    }

    if (removedBots.size > 0) {
      world.bots = world.bots.filter((bot) => !removedBots.has(bot.id));
    }
  }

  for (const playerId of removedPlayers) {
    delete world.players[playerId];
    const sock = io.sockets.sockets.get(playerId);
    if (sock) {
      sock.leave(mode);
      socketMode.delete(playerId);
    }
  }
}

function tickWorld(mode, dtSeconds) {
  const world = worlds[mode];
  const players = Object.values(world.players);
  for (const player of players) {
    updatePlayerMovement(player, dtSeconds);
    player.pulse += 0.05;
  }

  if (mode === PLAY_MODES.ONLINE_BOTS) {
    for (const bot of world.bots) {
      updateBotTarget(bot, world);
      updateBotMovement(bot);
      bot.pulse += 0.04;
    }
  }

  for (const food of world.foods) {
    food.pulse += 0.05;
  }

  applyFoodCollisions(world);
  resolveWorldCollisions(world, mode);
}

io.on('connection', (socket) => {
  socket.on('join_game', (payload = {}) => {
    const nextMode = normalizeMode(payload.mode);
    const prevMode = socketMode.get(socket.id);

    if (prevMode && worlds[prevMode]) {
      delete worlds[prevMode].players[socket.id];
      socket.leave(prevMode);
      broadcastState(prevMode);
    }

    const world = worlds[nextMode];
    world.players[socket.id] = makePlayer(socket.id, payload.name, payload.skinId);
    socketMode.set(socket.id, nextMode);
    socket.join(nextMode);

    socket.emit('game_init', {
      id: socket.id,
      world: WORLD_SIZE,
      mode: nextMode,
      foods: world.foods,
    });

    broadcastState(nextMode);
  });

  socket.on('player_input', (input = {}) => {
    const mode = socketMode.get(socket.id);
    if (!mode) return;
    const world = worlds[mode];
    const player = world.players[socket.id];
    if (!player) return;
    player.targetX = Number.isFinite(input.mouseX) ? input.mouseX : player.targetX;
    player.targetY = Number.isFinite(input.mouseY) ? input.mouseY : player.targetY;
    player.turbo = Boolean(input.turbo);
  });

  socket.on('disconnect', () => {
    const mode = socketMode.get(socket.id);
    if (!mode) return;
    const world = worlds[mode];
    delete world.players[socket.id];
    socketMode.delete(socket.id);
    broadcastState(mode);
  });
});

setInterval(() => {
  const dtSeconds = TICK_RATE / 1000;
  for (const mode of Object.values(PLAY_MODES)) {
    tickWorld(mode, dtSeconds);
    broadcastState(mode);
  }
}, TICK_RATE);

app.get('/', (_req, res) => {
  res.send('Servidor OutBreak online');
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, modes: Object.keys(worlds), world: WORLD_SIZE, fps: FPS });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[SERVER] running on port ${PORT}`);
});

