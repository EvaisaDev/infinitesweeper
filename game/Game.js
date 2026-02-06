const Grid = require('./Grid');
const Player = require('./Player');

const COLORS = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
    '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B739', '#52B788',
    '#E63946', '#F77F00', '#06FFA5', '#118AB2', '#EF476F'
];

class Game {
    constructor() {
        this.grid = new Grid();
        this.players = new Map();
        this.deadPlayers = new Map();
        this.colorIndex = 0;
        this.io = null;
        console.log('Game initialized - player count:', this.players.size);
    }
    
    setIO(io) {
        this.io = io;
    }
    
    getNextColor() {
        const color = COLORS[this.colorIndex % COLORS.length];
        this.colorIndex++;
        return color;
    }
    
    findSpawnLocation() {
        const activePlayers = Array.from(this.players.values()).filter(p => p.alive);
        
        let attempts = 0;
        const maxAttempts = 100;
        
        while (attempts < maxAttempts) {
            let x, y;
            
            if (activePlayers.length === 0) {
                x = Math.floor(Math.random() * 1000 - 500);
                y = Math.floor(Math.random() * 1000 - 500);
            } else {
                const targetPlayer = activePlayers[Math.floor(Math.random() * activePlayers.length)];
                const offset = Math.floor(Math.random() * 100 - 50);
                const angle = Math.random() * Math.PI * 2;
                
                x = Math.floor(targetPlayer.x + Math.cos(angle) * offset);
                y = Math.floor(targetPlayer.y + Math.sin(angle) * offset);
            }
            
            if (!this.grid.isMine(x, y) && this.grid.countAdjacentMines(x, y) === 0) {
                let areaIsClear = true;
                
                for (let dx = -10; dx <= 10; dx++) {
                    for (let dy = -10; dy <= 10; dy++) {
                        const checkCell = this.grid.getCell(x + dx, y + dy);
                        if (checkCell.state === 'uncovered' && checkCell.owner) {
                            areaIsClear = false;
                            break;
                        }
                    }
                    if (!areaIsClear) break;
                }
                
                if (areaIsClear && this.hasGuaranteedSolveAfterSpawn(x, y)) {
                    return { x, y };
                }
            }
            
            attempts++;
        }
        
        return {
            x: Math.floor(Math.random() * 1000 - 500),
            y: Math.floor(Math.random() * 1000 - 500)
        };
    }

    simulateUncoverCells(x, y) {
        const startCell = this.grid.getCell(x, y);
        if (startCell.state === 'uncovered' || startCell.flag || startCell.isMine) {
            return [];
        }
        
        const uncovered = new Map();
        const processed = new Set();
        const toProcess = [{ x, y }];
        processed.add(`${x},${y}`);
        
        while (toProcess.length > 0) {
            const current = toProcess.shift();
            const currentKey = `${current.x},${current.y}`;
            const adjMines = this.grid.countAdjacentMines(current.x, current.y);
            uncovered.set(currentKey, { x: current.x, y: current.y, adjacentMines: adjMines });
            
            if (adjMines !== 0) continue;
            
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = current.x + dx;
                    const ny = current.y + dy;
                    const nKey = `${nx},${ny}`;
                    if (processed.has(nKey)) continue;
                    processed.add(nKey);
                    const nCell = this.grid.getCell(nx, ny);
                    if (nCell.state === 'uncovered') continue;
                    if (nCell.flag) continue;
                    if (nCell.isMine) continue;
                    toProcess.push({ x: nx, y: ny });
                }
            }
        }
        
        return Array.from(uncovered.values());
    }
    
    hasGuaranteedSolveAfterSpawn(x, y) {
        const uncoveredCells = this.simulateUncoverCells(x, y);
        if (uncoveredCells.length === 0) return false;
        
        const uncoveredSet = new Set(uncoveredCells.map(c => `${c.x},${c.y}`));
        
        for (const cell of uncoveredCells) {
            if (cell.adjacentMines !== 1) continue;
            
            let coveredCount = 0;
            
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = cell.x + dx;
                    const ny = cell.y + dy;
                    const nKey = `${nx},${ny}`;
                    if (uncoveredSet.has(nKey)) continue;
                    const nCell = this.grid.getCell(nx, ny);
                    if (nCell.state === 'uncovered') continue;
                    if (nCell.flag) continue;
                    coveredCount++;
                    if (coveredCount > 1) break;
                }
                if (coveredCount > 1) break;
            }
            
            if (coveredCount === 1) {
                return true;
            }
        }
        
        return false;
    }
    
    addPlayer(id) {
        const spawn = this.findSpawnLocation();
        const color = this.getNextColor();
        const player = new Player(id, spawn.x, spawn.y, color);
        
        this.players.set(id, player);
        
        const uncoverResult = this.grid.uncoverCell(spawn.x, spawn.y, id);
        if (uncoverResult.success && !uncoverResult.isMine) {
            player.addScore(uncoverResult.uncoveredCells.length);
        }
        
        return {
            player: player.toJSON(),
            uncoveredCells: uncoverResult.success ? uncoverResult.uncoveredCells : []
        };
    }
    
    removePlayer(id) {
        const clearResult = this.grid.clearPlayerCells(id);
        
        for (const cell of clearResult.cellsToReset) {
            this.grid.recoverCell(cell.x, cell.y);
        }
        
        this.players.delete(id);
        this.deadPlayers.delete(id);
        
        return clearResult.cellsToReset;
    }
    
    startCellRecovery(playerId) {
        const playerCells = this.grid.getPlayerCells(playerId);
        if (playerCells.length === 0) return;
        
        let index = 0;
        const interval = setInterval(() => {
            if (index >= playerCells.length) {
                clearInterval(interval);
                return;
            }
            
            const cell = playerCells[index];
            this.grid.recoverCell(cell.x, cell.y);
            
            return {
                playerId: playerId,
                cell: cell
            };
        }, 50);
        
        return interval;
    }
    
    getActivePlayers() {
        return Array.from(this.players.values()).map(p => p.toJSON());
    }
    
    getLeaderboard() {
        const players = Array.from(this.players.values())
            .map(p => ({ id: p.id, score: p.score }))
            .sort((a, b) => b.score - a.score);
        return players;
    }
    
    isAdjacentToPlayerCell(playerId, x, y) {
        const player = this.players.get(playerId);
        if (!player || !player.alive) return false;
        
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                
                const cell = this.grid.getCell(x + dx, y + dy);
                if (cell.owner === playerId && cell.state === 'uncovered') {
                    return true;
                }
            }
        }
        
        return false;
    }
    
    hasValidMoves(playerId) {
        const playerCells = this.grid.getPlayerCells(playerId);
        
        for (const cell of playerCells) {
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    
                    const adjCell = this.grid.getCell(cell.x + dx, cell.y + dy);
                    if (adjCell.state === 'covered' && !adjCell.isMine) {
                        return true;
                    }
                }
            }
        }
        
        return false;
    }
    
    handleChord(playerId, data) {
        const { x, y } = data;
        const player = this.players.get(playerId);
        
        if (!player || !player.alive) {
            return { success: false, error: 'Player not alive' };
        }
        
        const cell = this.grid.getCell(x, y);
        
        if (cell.state !== 'uncovered' || cell.owner !== playerId) {
            return { success: false, error: 'Can only chord on your uncovered cells' };
        }
        
        if (cell.adjacentMines === 0) {
            return { success: false, error: 'No adjacent mines to chord' };
        }
        
        let flagCount = 0;
        const adjacentCells = [];
        
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const adjCell = this.grid.getCell(x + dx, y + dy);
                adjacentCells.push({ x: x + dx, y: y + dy, cell: adjCell });
                if (adjCell.flag) {
                    flagCount++;
                }
            }
        }
        
        if (flagCount !== cell.adjacentMines) {
            const coveredUnflagged = [];
            for (const { x: ax, y: ay, cell: adjCell } of adjacentCells) {
                if (adjCell.state === 'covered' && !adjCell.flag) {
                    coveredUnflagged.push({ x: ax, y: ay });
                }
            }
            if (coveredUnflagged.length > 0 && flagCount + coveredUnflagged.length === cell.adjacentMines) {
                for (const pos of coveredUnflagged) {
                    if (!this.grid.isMine(pos.x, pos.y)) {
                        return { success: false, error: 'Flag count does not match number' };
                    }
                }
                const flags = [];
                for (const pos of coveredUnflagged) {
                    const flagResult = this.grid.toggleFlag(pos.x, pos.y, playerId);
                    if (flagResult.success && flagResult.flagged) {
                        flags.push({ x: pos.x, y: pos.y, flagged: true });
                    }
                }
                return {
                    success: true,
                    update: {
                        type: 'autoFlag',
                        playerId: playerId,
                        flags: flags
                    }
                };
            }
            return { success: false, error: 'Flag count does not match number' };
        }
        
        let allUncoveredCells = [];
        let hitMine = false;
        let mineCell = null;
        
        for (const { x: ax, y: ay, cell: adjCell } of adjacentCells) {
            if (adjCell.state === 'covered' && !adjCell.flag) {
                const result = this.grid.uncoverCell(ax, ay, playerId);
                
                if (result.success) {
                    if (result.isMine) {
                        hitMine = true;
                        mineCell = { x: ax, y: ay };
                    }
                    allUncoveredCells = allUncoveredCells.concat(result.uncoveredCells);
                }
            }
        }
        
        if (hitMine) {
            const finalScore = player.score;
            player.die();
            player.score = 0;
            this.deadPlayers.set(playerId, Date.now());
            
            const clearResult = this.grid.clearPlayerCells(playerId);
            const playerCells = clearResult.cellsToReset;
            
            if (clearResult.flagsToRemove.length > 0 && this.io) {
                this.io.emit('flagsRemoved', { 
                    playerId: playerId,
                    flags: clearResult.flagsToRemove 
                });
            }
            
            setTimeout(() => {
                this.recoverPlayerCells(playerId, playerCells);
            }, 2000);
            
            return {
                success: true,
                update: {
                    type: 'death',
                    playerId: playerId,
                    mineCell: mineCell,
                    playerCells: playerCells,
                    uncoveredCells: allUncoveredCells,
                    score: player.score,
                    finalScore: finalScore
                }
            };
        }
        
        player.score += allUncoveredCells.length;
        
        if (!this.hasValidMoves(playerId)) {
            const finalScore = player.score;
            player.die();
            player.score = 0;
            this.deadPlayers.set(playerId, Date.now());
            
            const clearResult = this.grid.clearPlayerCells(playerId);
            const playerCells = clearResult.cellsToReset;
            
            setTimeout(() => {
                this.recoverPlayerCells(playerId, playerCells);
            }, 2000);
            
            return {
                success: true,
                update: {
                    type: 'noMoves',
                    playerId: playerId,
                    playerCells: playerCells,
                    uncoveredCells: allUncoveredCells,
                    score: player.score,
                    finalScore: finalScore
                }
            };
        }
        
        return {
            success: true,
            update: {
                type: 'move',
                playerId: playerId,
                uncoveredCells: allUncoveredCells,
                score: player.score
            }
        };
    }
    
    handleMove(playerId, data) {
        const player = this.players.get(playerId);
        if (!player || !player.alive) {
            return { success: false, error: 'Player not active' };
        }
        
        const { x, y } = data;
        
        const cell = this.grid.getCell(x, y);
        if (cell.state === 'uncovered') {
            return { success: false, error: 'Cell already uncovered' };
        }
        
        if (!this.isAdjacentToPlayerCell(playerId, x, y)) {
            return { success: false, error: 'Not adjacent to your cells' };
        }
        
        const result = this.grid.uncoverCell(x, y, playerId);
        
        if (!result.success) {
            return { success: false, error: 'Cannot uncover cell' };
        }
        
        if (result.isMine) {
            const finalScore = player.score;
            player.die();
            player.score = 0;
            this.deadPlayers.set(playerId, Date.now());
            
            const clearResult = this.grid.clearPlayerCells(playerId);
            const playerCells = clearResult.cellsToReset;
            
            if (clearResult.flagsToRemove.length > 0 && this.io) {
                this.io.emit('flagsRemoved', { 
                    playerId: playerId,
                    flags: clearResult.flagsToRemove 
                });
            }
            
            setTimeout(() => {
                this.recoverPlayerCells(playerId, playerCells);
            }, 2000);
            
            return {
                success: true,
                update: {
                    type: 'death',
                    playerId: playerId,
                    mineCell: { x, y },
                    playerCells: playerCells,
                    uncoveredCells: result.uncoveredCells,
                    score: player.score,
                    finalScore: finalScore
                }
            };
        }
        
        player.addScore(result.uncoveredCells.length);
        
        if (!this.hasValidMoves(playerId)) {
            const finalScore = player.score;
            player.die();
            player.score = 0;
            this.deadPlayers.set(playerId, Date.now());
            
            return {
                success: true,
                update: {
                    type: 'noMoves',
                    playerId: playerId,
                    uncoveredCells: result.uncoveredCells,
                    score: player.score,
                    finalScore: finalScore
                }
            };
        }
        
        return {
            success: true,
            update: {
                type: 'move',
                playerId: playerId,
                uncoveredCells: result.uncoveredCells,
                score: player.score
            }
        };
    }
    
    recoverPlayerCells(playerId, cells) {
        let index = 0;
        let delay = 50;
        
        const recoverNext = () => {
            if (index >= cells.length) {
                if (this.io) {
                    this.io.emit('recoveryComplete', { playerId: playerId });
                }
                return;
            }
            
            const cell = cells[index];
            this.grid.recoverCell(cell.x, cell.y);
            
            if (this.io) {
                const updatedCells = [];
                const seen = new Set();
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        if (dx === 0 && dy === 0) continue;
                        const adjCell = this.grid.getCell(cell.x + dx, cell.y + dy);
                        if (adjCell.state === 'uncovered') {
                            const key = `${adjCell.x},${adjCell.y}`;
                            if (!seen.has(key)) {
                                seen.add(key);
                                updatedCells.push(adjCell);
                            }
                        }
                    }
                }
                if (updatedCells.length > 0) {
                    this.io.emit('cellsUpdated', { cells: updatedCells });
                }
            }
            
            if (this.io) {
                this.io.emit('cellRecovered', { 
                    playerId: playerId,
                    x: cell.x,
                    y: cell.y
                });
            }
            
            index++;
            
            delay = Math.max(10, delay * 0.95);
            
            setTimeout(recoverNext, delay);
        };
        
        recoverNext();
    }
    
    handleFlag(playerId, data) {
        const player = this.players.get(playerId);
        if (!player || !player.alive) {
            return { success: false, error: 'Player not active' };
        }
        
        const { x, y } = data;
        
        if (!this.isAdjacentToPlayerCell(playerId, x, y)) {
            return { success: false, error: 'Not adjacent to your cells' };
        }
        
        const result = this.grid.toggleFlag(x, y, playerId);
        
        if (!result.success) {
            return { success: false, error: 'Cannot flag cell' };
        }
        
        return {
            success: true,
            update: {
                type: 'flag',
                playerId: playerId,
                x: x,
                y: y,
                flagged: result.flagged
            }
        };
    }
    
    getChunks(chunkKeys) {
        const chunks = [];
        for (const key of chunkKeys) {
            const [x, y] = key.split(',').map(Number);
            chunks.push(this.grid.getChunk(x, y));
        }
        return chunks;
    }
    
    update() {
        const updates = [];
        const now = Date.now();
        
        for (const [playerId, deathTime] of this.deadPlayers.entries()) {
            if (now - deathTime >= 30000) {
                const player = this.players.get(playerId);
                if (player && !player.alive) {
                    this.grid.clearPlayerCells(playerId);
                    
                    const spawn = this.findSpawnLocation();
                    player.respawn(spawn.x, spawn.y);
                    
                    const uncoverResult = this.grid.uncoverCell(spawn.x, spawn.y, playerId);
                    if (uncoverResult.success && !uncoverResult.isMine) {
                        player.addScore(uncoverResult.uncoveredCells.length);
                    }
                    
                    updates.push({
                        type: 'respawn',
                        playerId: playerId,
                        x: spawn.x,
                        y: spawn.y,
                        uncoveredCells: uncoverResult.uncoveredCells
                    });
                    
                    this.deadPlayers.delete(playerId);
                }
            }
        }
        
        return updates;
    }
}

module.exports = Game;
