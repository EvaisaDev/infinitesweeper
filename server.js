const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
require('dotenv').config();

const Game = require('./game/Game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingTimeout: 5000,
    pingInterval: 2000,
    upgradeTimeout: 3000,
    maxHttpBufferSize: 1e6
});

const game = new Game();
game.setIO(io);

const debugPlayers = new Set();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-this-secret-key';
const AI_PLAYER_COUNT = Math.max(0, parseInt(process.env.AI_PLAYER_COUNT || '0', 10) || 0);

const adminSessions = new Map();

if (AI_PLAYER_COUNT > 0) {
    const aiPlayers = game.addAIPlayers(AI_PLAYER_COUNT);
    for (const ai of aiPlayers) {
        io.emit('playerJoined', ai.player);
        if (ai.uncoveredCells && ai.uncoveredCells.length > 0) {
            io.emit('gameUpdate', {
                type: 'spawn',
                playerId: ai.id,
                uncoveredCells: ai.uncoveredCells
            });
        }
    }
}

function generateSessionToken() {
    return require('crypto').randomBytes(32).toString('hex');
}

function isValidAdminToken(token) {
    if (!token) return false;
    const session = adminSessions.get(token);
    if (!session) return false;
    if (session.expiresAt < Date.now()) {
        adminSessions.delete(token);
        return false;
    }
    return true;
}

app.use(express.static('public'));

app.get('/debug', (req, res) => {
    const token = req.query.token;
    if (!isValidAdminToken(token)) {
        res.redirect('/admin.html');
        return;
    }
    res.sendFile(path.join(__dirname, 'debug.html'));
});

io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);
    
    let playerInitialized = false;
    const connectionTime = Date.now();
    const isAdmin = socket.handshake.auth && socket.handshake.auth.role === 'admin';
    const debugToken = socket.handshake.auth && socket.handshake.auth.debugToken;
    const isDebug = debugToken && isValidAdminToken(debugToken);
    if (isDebug) {
        debugPlayers.add(socket.id);
    }
    if (debugToken && !isDebug) {
        socket.emit('debugInvalid');
        socket.disconnect(true);
        return;
    }

    function emitPlayerInit(playerData) {
        socket.emit('init', {
            playerId: socket.id,
            player: playerData.player,
            activePlayers: game.getActivePlayers()
        });
        
        if (playerData.uncoveredCells && playerData.uncoveredCells.length > 0) {
            io.emit('gameUpdate', {
                type: 'spawn',
                playerId: socket.id,
                uncoveredCells: playerData.uncoveredCells
            });
        }
        
        socket.broadcast.emit('playerJoined', playerData.player);
    }
    
    function initializePlayer() {
        if (playerInitialized) return;
        playerInitialized = true;
        
        const playerData = game.addPlayer(socket.id);
        const initDelayMs = Date.now() - connectionTime;
        console.log(`Player initialized: ${socket.id} after ${initDelayMs}ms`);
        emitPlayerInit(playerData);
    }

    function initializePlayerAt(x, y) {
        if (playerInitialized) return;
        playerInitialized = true;
        
        const playerData = game.addPlayerAt(socket.id, x, y);
        const initDelayMs = Date.now() - connectionTime;
        console.log(`Player initialized: ${socket.id} after ${initDelayMs}ms`);
        emitPlayerInit(playerData);
    }

    function ensurePlayerInitialized() {
        if (playerInitialized) return true;
        if (isDebug) return false;
        initializePlayer();
        return true;
    }

    socket.on('initGame', () => {
        if (isAdmin) return;
        if (isDebug) return;
        initializePlayer();
    });
    
    socket.on('requestChunks', (data) => {
        if (isAdmin) return;
        if (!isDebug && !ensurePlayerInitialized()) return;
        const reqToken = (data && data.debugToken) || debugToken;
        const hasDebugFlag = data && data.debug === true;
        const tokenValid = reqToken && isValidAdminToken(reqToken);
        const includeMines = hasDebugFlag && tokenValid;
        console.log('requestChunks - isDebug:', isDebug, 'hasDebugFlag:', hasDebugFlag, 'reqToken:', !!reqToken, 'tokenValid:', tokenValid, 'includeMines:', includeMines);
        const chunks = game.getChunks(data.chunkKeys, includeMines ? { includeMines: true } : null);
        socket.emit('chunks', chunks);
    });

    socket.on('requestActivePlayers', () => {
        if (isAdmin) return;
        socket.emit('activePlayers', { activePlayers: game.getActivePlayers() });
    });
    
    socket.on('move', (data) => {
        if (isAdmin) return;
        if (!ensurePlayerInitialized()) return;
        const result = game.handleMove(socket.id, data);
        if (result.success) {
            io.emit('gameUpdate', result.update);
        } else {
            socket.emit('error', result.error);
        }
    });
    
    socket.on('flag', (data) => {
        if (isAdmin) return;
        if (!ensurePlayerInitialized()) return;
        const result = game.handleFlag(socket.id, data);
        if (result.success) {
            io.emit('gameUpdate', result.update);
        }
    });
    
    socket.on('chord', (data) => {
        if (isAdmin) return;
        if (!ensurePlayerInitialized()) return;
        const result = game.handleChord(socket.id, data);
        if (result.success) {
            io.emit('gameUpdate', result.update);
        }
    });

    socket.on('debugSpawn', (data) => {
        console.log('debugSpawn received:', 'isDebug:', isDebug, 'playerInitialized:', playerInitialized, 'data:', data);
        if (!isDebug) return;
        if (!data || data.x === undefined || data.y === undefined) return;
        
        if (!playerInitialized) {
            initializePlayerAt(data.x, data.y);
        } else {
            const player = game.players.get(socket.id);
            if (player && !player.alive) {
                game.grid.clearPlayerCells(socket.id);
                player.respawn(data.x, data.y);
                game.updateSafeZones();
                if (!game.grid.hasOtherPlayerNearby(data.x, data.y, socket.id, game.safeRadius)) {
                    game.grid.reserveSafeZone(data.x, data.y, game.safeRadius, socket.id);
                }
                
                const uncoverResult = game.grid.uncoverCell(data.x, data.y, socket.id);
                if (uncoverResult.success && !uncoverResult.isMine) {
                    player.addScore(uncoverResult.uncoveredCells.length);
                }
                
                io.emit('gameUpdate', {
                    type: 'respawn',
                    playerId: socket.id,
                    x: data.x,
                    y: data.y,
                    uncoveredCells: uncoverResult.uncoveredCells
                });
                
                game.deadPlayers.delete(socket.id);
            }
        }
    });
    
    socket.on('disconnect', (reason) => {
        console.log(`Socket disconnected: ${socket.id}, reason: ${reason}`);
        
        debugPlayers.delete(socket.id);
        
        if (playerInitialized) {
            const cellsCleared = game.removePlayer(socket.id);
            
            socket.broadcast.emit('playerLeft', socket.id);
            
            if (cellsCleared && cellsCleared.length > 0) {
                io.emit('cellsCleared', { playerId: socket.id, cells: cellsCleared });
            }
        }
        
        for (const [token, session] of adminSessions.entries()) {
            if (session.socketId === socket.id) {
                adminSessions.delete(token);
            }
        }
    });
    
    socket.on('adminLogin', (data) => {
        const success = data.username === ADMIN_USERNAME && data.password === ADMIN_PASSWORD;
        if (success) {
            const token = generateSessionToken();
            const expiresAt = Date.now() + 3600000;
            adminSessions.set(token, { socketId: socket.id, expiresAt });
            console.log('Admin logged in:', socket.id);
            socket.emit('adminLoginResult', { success: true, token });
        } else {
            socket.emit('adminLoginResult', { success: false });
        }
    });
    
    socket.on('adminBroadcast', (data) => {
        if (!data || !data.token) {
            socket.emit('adminBroadcastResult', { success: false, error: 'Unauthorized' });
            return;
        }
        
        const token = data.token;
        const session = adminSessions.get(token);
        
        if (!session || session.socketId !== socket.id || session.expiresAt < Date.now()) {
            socket.emit('adminBroadcastResult', { success: false, error: 'Unauthorized' });
            return;
        }
        
        console.log('Admin broadcast:', data);
        io.emit('adminMessage', {
            title: data.title || 'Server Message',
            text: data.text
        });
        socket.emit('adminBroadcastResult', { success: true });
    });

    socket.on('adminSetAIPlayers', (data) => {
        if (!data || !data.token) {
            socket.emit('adminSetAIPlayersResult', { success: false, error: 'Unauthorized' });
            return;
        }
        const token = data.token;
        const session = adminSessions.get(token);
        if (!session || session.socketId !== socket.id || session.expiresAt < Date.now()) {
            socket.emit('adminSetAIPlayersResult', { success: false, error: 'Unauthorized' });
            return;
        }
        const target = Math.max(0, parseInt(data.count || '0', 10) || 0);
        const result = game.setAIPlayerCount(target);
        for (const ai of result.added) {
            io.emit('playerJoined', ai.player);
            if (ai.uncoveredCells && ai.uncoveredCells.length > 0) {
                io.emit('gameUpdate', {
                    type: 'spawn',
                    playerId: ai.id,
                    uncoveredCells: ai.uncoveredCells
                });
            }
        }
        for (const removed of result.removed) {
            io.emit('playerLeft', removed.id);
            if (removed.cellsCleared && removed.cellsCleared.length > 0) {
                io.emit('cellsCleared', { playerId: removed.id, cells: removed.cellsCleared });
            }
        }
        socket.emit('adminSetAIPlayersResult', { success: true, count: target });
    });
    
    socket.on('requestAdminStats', (data) => {
        if (!data || !data.token) {
            return;
        }
        
        const token = data.token;
        const session = adminSessions.get(token);
        
        if (!session || session.socketId !== socket.id || session.expiresAt < Date.now()) {
            return;
        }
        
        socket.emit('adminStats', {
            playerCount: game.players.size,
            aiCount: game.aiPlayers ? game.aiPlayers.size : 0
        });
    });
});

setInterval(() => {
    const updates = game.update(debugPlayers);
    if (updates.length > 0) {
        io.emit('gameUpdate', { updates });
    }
    
    const leaderboard = game.getLeaderboard();
    io.emit('leaderboard', leaderboard);
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
