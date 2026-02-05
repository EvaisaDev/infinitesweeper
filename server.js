const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const Game = require('./game/Game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const game = new Game();
game.setIO(io);

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);
    
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
    
    socket.on('move', (data) => {
        const result = game.handleMove(socket.id, data);
        if (result.success) {
            io.emit('gameUpdate', result.update);
        } else {
            socket.emit('error', result.error);
        }
    });
    
    socket.on('flag', (data) => {
        const result = game.handleFlag(socket.id, data);
        if (result.success) {
            io.emit('gameUpdate', result.update);
        }
    });
    
    socket.on('requestChunks', (data) => {
        const chunks = game.getChunks(data.chunkKeys);
        socket.emit('chunks', chunks);
    });
    
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        const cellsCleared = game.removePlayer(socket.id);
        
        socket.broadcast.emit('playerLeft', socket.id);
        
        if (cellsCleared && cellsCleared.length > 0) {
            io.emit('cellsCleared', { cells: cellsCleared });
        }
    });
});

setInterval(() => {
    const updates = game.update();
    if (updates.length > 0) {
        io.emit('gameUpdate', { updates });
    }
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
