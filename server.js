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

app.use(express.static('public'));

const game = new Game();
game.setIO(io);

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-this-secret-key';

const adminSessions = new Map();

function generateSessionToken() {
    return require('crypto').randomBytes(32).toString('hex');
}

io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);
    
    let playerInitialized = false;
    
    function initializePlayer() {
        if (playerInitialized) return;
        playerInitialized = true;
        
        const playerData = game.addPlayer(socket.id);
        
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
    
    socket.on('requestChunks', (data) => {
        initializePlayer();
        const chunks = game.getChunks(data.chunkKeys);
        socket.emit('chunks', chunks);
    });
    
    socket.on('move', (data) => {
        initializePlayer();
        const result = game.handleMove(socket.id, data);
        if (result.success) {
            io.emit('gameUpdate', result.update);
        } else {
            socket.emit('error', result.error);
        }
    });
    
    socket.on('flag', (data) => {
        initializePlayer();
        const result = game.handleFlag(socket.id, data);
        if (result.success) {
            io.emit('gameUpdate', result.update);
        }
    });
    
    socket.on('chord', (data) => {
        initializePlayer();
        const result = game.handleChord(socket.id, data);
        if (result.success) {
            io.emit('gameUpdate', result.update);
        }
    });
    
    socket.on('disconnect', (reason) => {
        console.log(`Socket disconnected: ${socket.id}, reason: ${reason}`);
        
        if (playerInitialized) {
            const cellsCleared = game.removePlayer(socket.id);
            
            socket.broadcast.emit('playerLeft', socket.id);
            
            if (cellsCleared && cellsCleared.length > 0) {
                io.emit('cellsCleared', { cells: cellsCleared });
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
            playerCount: game.players.size
        });
    });
});

setInterval(() => {
    const updates = game.update();
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
