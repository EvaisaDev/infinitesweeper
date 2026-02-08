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
        this.safeRadius = 5;
        this.aiPlayers = new Set();
        this.aiNextActionAt = new Map();
        this.aiFocus = new Map();
        this.aiSkill = new Map();
        this.aiIdCounter = 0;
        this.aiMoveIntervalMs = 350;
        this.aiProfiles = [
            { flagChance: 0.45, chordChance: 0.0, baseDelayMult: 1.6, guessDelayMin: 1100, guessDelayMax: 2100 },
            { flagChance: 0.8, chordChance: 0.6, baseDelayMult: 1.1, guessDelayMin: 800, guessDelayMax: 1400 },
            { flagChance: 1.0, chordChance: 1.0, baseDelayMult: 0.9, guessDelayMin: 600, guessDelayMax: 1100 }
        ];
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

    addAIPlayers(count) {
        const added = [];
        for (let i = 0; i < count; i++) {
            const id = this.getNextAIId();
            const playerData = this.addPlayer(id);
            this.aiPlayers.add(id);
            this.aiNextActionAt.set(id, 0);
            this.aiFocus.set(id, { x: playerData.player.x, y: playerData.player.y, ttl: 40 });
            const profile = this.aiProfiles[Math.floor(Math.random() * this.aiProfiles.length)];
            this.aiSkill.set(id, profile);
            added.push({ id: id, player: playerData.player, uncoveredCells: playerData.uncoveredCells });
        }
        return added;
    }

    getNextAIId() {
        let id = '';
        do {
            this.aiIdCounter += 1;
            id = `ai-${this.aiIdCounter}`;
        } while (this.players.has(id));
        return id;
    }

    setAIPlayerCount(targetCount) {
        const desired = Math.max(0, targetCount);
        const current = this.aiPlayers.size;
        const added = [];
        const removed = [];
        if (desired > current) {
            added.push(...this.addAIPlayers(desired - current));
        } else if (desired < current) {
            const toRemove = current - desired;
            const ids = Array.from(this.aiPlayers.values()).slice(0, toRemove);
            for (const id of ids) {
                const cellsCleared = this.removePlayer(id);
                this.aiPlayers.delete(id);
                this.aiNextActionAt.delete(id);
                this.aiFocus.delete(id);
                this.aiSkill.delete(id);
                removed.push({ id: id, cellsCleared: cellsCleared });
            }
        }
        return { added, removed };
    }

    updateSafeZones() {
        const zones = [];
        for (const player of this.players.values()) {
            if (player.alive) {
                zones.push({ x: player.x, y: player.y, radius: this.safeRadius });
            }
        }
        this.grid.setSafeZones(zones);
    }

    findSpawnLocation(playerId) {
        const activePlayers = Array.from(this.players.values()).filter(p => p.alive);
        const isValidSpawn = (candidate) => {
            if (this.grid.hasOtherPlayerNearby(candidate.x, candidate.y, playerId || null, this.safeRadius)) {
                return false;
            }
            const cell = this.grid.getCell(candidate.x, candidate.y);
            if (cell.state === 'uncovered') return false;
            if (cell.owner && cell.owner !== playerId) return false;
            if (cell.isMine) return false;
            return true;
        };
        
        if (activePlayers.length === 0) {
            const maxAttempts = 2000;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const candidate = {
                    x: Math.floor(Math.random() * 1000 - 500),
                    y: Math.floor(Math.random() * 1000 - 500)
                };
                if (isValidSpawn(candidate)) {
                    return candidate;
                }
            }
            return {
                x: Math.floor(Math.random() * 2000 - 1000),
                y: Math.floor(Math.random() * 2000 - 1000)
            };
        }
        
        const maxAttempts = 1000;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const targetPlayer = activePlayers[Math.floor(Math.random() * activePlayers.length)];
            const distance = 20 + Math.floor(Math.random() * 41);
            const angle = Math.random() * Math.PI * 2;
            
            const candidate = {
                x: Math.floor(targetPlayer.x + Math.cos(angle) * distance),
                y: Math.floor(targetPlayer.y + Math.sin(angle) * distance)
            };
            
            let validDistance = true;
            for (const player of activePlayers) {
                const dx = candidate.x - player.x;
                const dy = candidate.y - player.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 20 || dist > 60) {
                    validDistance = false;
                    break;
                }
            }
            
            if (validDistance && isValidSpawn(candidate)) {
                return candidate;
            }
        }
        
        const targetPlayer = activePlayers[Math.floor(Math.random() * activePlayers.length)];
        const distance = 40;
        const angle = Math.random() * Math.PI * 2;
        const candidate = {
            x: Math.floor(targetPlayer.x + Math.cos(angle) * distance),
            y: Math.floor(targetPlayer.y + Math.sin(angle) * distance)
        };
        if (isValidSpawn(candidate)) {
            return candidate;
        }
        for (let attempt = 0; attempt < 2000; attempt++) {
            const fallback = {
                x: Math.floor(Math.random() * 2000 - 1000),
                y: Math.floor(Math.random() * 2000 - 1000)
            };
            if (isValidSpawn(fallback)) {
                return fallback;
            }
        }
        return candidate;
    }

    
    addPlayer(id) {
        const spawn = this.findSpawnLocation(id);
        return this.addPlayerAt(id, spawn.x, spawn.y);
    }

    addPlayerAt(id, x, y) {
        const color = this.getNextColor();
        const player = new Player(id, x, y, color);
        
        this.players.set(id, player);
        this.updateSafeZones();
        if (!this.grid.hasOtherPlayerNearby(x, y, id, this.safeRadius)) {
            this.grid.reserveSafeZone(x, y, this.safeRadius, id);
        }
        
        const safeRadius = this.safeRadius;
        const isInSafeZone = (sx, sy) => {
            const dx = sx - x;
            const dy = sy - y;
            return Math.sqrt(dx * dx + dy * dy) <= safeRadius;
        };
        
        const uncoveredCells = [];
        const toProcess = [{ x, y }];
        const processed = new Set();
        processed.add(`${x},${y}`);
        
        while (toProcess.length > 0) {
            const current = toProcess.shift();
            
            const cell = this.grid.getCell(current.x, current.y);
            if (cell.state === 'uncovered') continue;
            if (cell.flag) continue;
            
            if (!isInSafeZone(current.x, current.y)) {
                this.grid.assignMinesInRadius(current.x, current.y, 3);
            }
            
            const result = this.grid.uncoverCell(current.x, current.y, id);
            if (!result.success || result.isMine) continue;
            
            uncoveredCells.push(...result.uncoveredCells);
            
            if (result.uncoveredCells[0]?.adjacentMines === 0) {
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = current.x + dx;
                        const ny = current.y + dy;
                        const nKey = `${nx},${ny}`;
                        if (!processed.has(nKey)) {
                            processed.add(nKey);
                            toProcess.push({ x: nx, y: ny });
                        }
                    }
                }
            }
        }
        
        player.addScore(uncoveredCells.length);
        
        return {
            player: player.toJSON(),
            uncoveredCells: uncoveredCells
        };
    }
    
    removePlayer(id) {
        const clearResult = this.grid.clearPlayerCells(id);
        
        for (const cell of clearResult.cellsToReset) {
            this.grid.recoverCell(cell.x, cell.y, id);
        }
        
        this.players.delete(id);
        this.deadPlayers.delete(id);
        this.updateSafeZones();
        
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
            this.grid.recoverCell(cell.x, cell.y, playerId);
            
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
                    if (adjCell.state === 'covered' && !this.grid.isMine(cell.x + dx, cell.y + dy)) {
                        return true;
                    }
                }
            }
        }
        
        return false;
    }

    getAIAction(playerId) {
        const playerCells = this.grid.getPlayerCells(playerId);
        if (playerCells.length === 0) return null;
        const coveredSeen = new Set();
        const safeMoves = [];
        const flagMoves = [];
        const chordMoves = [];
        const guessMoves = [];
        const skill = this.aiSkill.get(playerId) || this.aiProfiles[1];
        const focus = this.aiFocus.get(playerId) || null;
        const isNearFocus = (pos) => {
            if (!focus) return false;
            const dx = pos.x - focus.x;
            const dy = pos.y - focus.y;
            return Math.abs(dx) <= 6 && Math.abs(dy) <= 6;
        };
        
        for (const cell of playerCells) {
            const cellData = this.grid.getCell(cell.x, cell.y);
            if (cellData.state !== 'uncovered') continue;
            if (cellData.owner !== playerId) continue;
            const number = cellData.adjacentMines || 0;
            if (number === 0) continue;
            
            const covered = [];
            let flaggedCount = 0;
            
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = cell.x + dx;
                    const ny = cell.y + dy;
                    const adjCell = this.grid.getCell(nx, ny);
                    if (adjCell.flag) {
                        flaggedCount++;
                        continue;
                    }
                    if (adjCell.state === 'covered') {
                        covered.push({ x: nx, y: ny });
                    }
                }
            }
            
            if (covered.length === 0) continue;
            
            if (flaggedCount === number) {
                chordMoves.push({ x: cell.x, y: cell.y });
                for (const pos of covered) {
                    const key = `${pos.x},${pos.y}`;
                    if (!coveredSeen.has(key)) {
                        coveredSeen.add(key);
                        safeMoves.push({ x: pos.x, y: pos.y });
                    }
                }
                continue;
            }
            
            if (flaggedCount + covered.length === number) {
                for (const pos of covered) {
                    const key = `${pos.x},${pos.y}`;
                    if (!coveredSeen.has(key)) {
                        coveredSeen.add(key);
                        flagMoves.push({ x: pos.x, y: pos.y });
                    }
                }
            }
        }
        
        if (flagMoves.length > 0 && Math.random() < skill.flagChance) {
            const focusFlags = flagMoves.filter(isNearFocus);
            const pick = (focusFlags.length > 0 ? focusFlags : flagMoves)[Math.floor(Math.random() * (focusFlags.length > 0 ? focusFlags.length : flagMoves.length))];
            return { type: 'flag', ...pick, isGuess: false, focusMove: true };
        }
        
        if (chordMoves.length > 0 && Math.random() < skill.chordChance) {
            const focusChords = chordMoves.filter(isNearFocus);
            const pick = (focusChords.length > 0 ? focusChords : chordMoves)[Math.floor(Math.random() * (focusChords.length > 0 ? focusChords.length : chordMoves.length))];
            return { type: 'chord', ...pick, isGuess: false, focusMove: true };
        }
        
        if (safeMoves.length > 0) {
            const focusSafe = safeMoves.filter(isNearFocus);
            const pick = (focusSafe.length > 0 ? focusSafe : safeMoves)[Math.floor(Math.random() * (focusSafe.length > 0 ? focusSafe.length : safeMoves.length))];
            return { type: 'move', ...pick, isGuess: false, focusMove: true };
        }
        
        for (const cell of playerCells) {
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    const x = cell.x + dx;
                    const y = cell.y + dy;
                    const key = `${x},${y}`;
                    if (coveredSeen.has(key)) continue;
                    coveredSeen.add(key);
                    const adjCell = this.grid.getCell(x, y);
                    if (adjCell.state !== 'covered') continue;
                    if (adjCell.flag) continue;
                    guessMoves.push({ x, y });
                }
            }
        }
        
        if (guessMoves.length > 0) {
            const focusGuess = guessMoves.filter(isNearFocus);
            const pick = (focusGuess.length > 0 ? focusGuess : guessMoves)[Math.floor(Math.random() * (focusGuess.length > 0 ? focusGuess.length : guessMoves.length))];
            return { type: 'move', ...pick, isGuess: true, focusMove: true };
        }
        
        return null;
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
            this.updateSafeZones();
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
            this.updateSafeZones();
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
    
    handleMove(playerId, data, force = false) {
        const player = this.players.get(playerId);
        if (!player || !player.alive) {
            return { success: false, error: 'Player not active' };
        }
        
        const { x, y } = data;
        
        const cell = this.grid.getCell(x, y);
        if (cell.state === 'uncovered') {
            return { success: false, error: 'Cell already uncovered' };
        }
        
        if (!force && !this.isAdjacentToPlayerCell(playerId, x, y)) {
            return { success: false, error: 'Not adjacent to your cells' };
        }
        
        const result = this.grid.uncoverCell(x, y, playerId);
        
        if (!result.success) {
            return { success: false, error: 'Cannot uncover cell' };
        }
        
        if (result.isMine) {
            const finalScore = player.score;
            player.die();
            this.updateSafeZones();
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
            this.updateSafeZones();
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
        if (!cells || cells.length === 0) {
            if (this.io) {
                this.io.emit('recoveryComplete', { playerId: playerId });
            }
            return;
        }
        let legacyTotal = 0;
        let legacyDelay = 50;
        for (let i = 0; i < cells.length; i++) {
            legacyTotal += legacyDelay;
            legacyDelay = Math.max(10, legacyDelay * 0.95);
        }
        if (legacyTotal <= 10000) {
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
                this.grid.recoverCell(cell.x, cell.y, playerId);
                
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
            return;
        }
        
        let index = 0;
        const totalDurationMs = 10000;
        const startTime = Date.now();
        const tickMs = 50;
        
        const recoverCellAtIndex = (cell) => {
            this.grid.recoverCell(cell.x, cell.y, playerId);
            
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
        };
        
        const interval = setInterval(() => {
            const elapsed = Date.now() - startTime;
            const targetIndex = Math.min(cells.length, Math.floor((elapsed / totalDurationMs) * cells.length));
            while (index < targetIndex) {
                recoverCellAtIndex(cells[index]);
                index++;
            }
            if (elapsed >= totalDurationMs || index >= cells.length) {
                while (index < cells.length) {
                    recoverCellAtIndex(cells[index]);
                    index++;
                }
                clearInterval(interval);
                if (this.io) {
                    this.io.emit('recoveryComplete', { playerId: playerId });
                }
            }
        }, tickMs);
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
    
    getChunks(chunkKeys, options = null) {
        const chunks = [];
        for (const key of chunkKeys) {
            const [x, y] = key.split(',').map(Number);
            chunks.push(this.grid.getChunk(x, y, options));
        }
        return chunks;
    }

    
    update(debugPlayers = new Set()) {
        const updates = [];
        const now = Date.now();
        
        for (const [playerId, deathTime] of this.deadPlayers.entries()) {
            if (debugPlayers.has(playerId)) continue;
            if (now - deathTime >= 30000) {
                const player = this.players.get(playerId);
                if (player && !player.alive) {
                    this.grid.clearPlayerCells(playerId);
                    
                    const spawn = this.findSpawnLocation(playerId);
                    player.respawn(spawn.x, spawn.y);
                    this.updateSafeZones();
                    if (!this.grid.hasOtherPlayerNearby(spawn.x, spawn.y, playerId, this.safeRadius)) {
                        this.grid.reserveSafeZone(spawn.x, spawn.y, this.safeRadius, playerId);
                    }
                    
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

        for (const playerId of this.aiPlayers) {
            const player = this.players.get(playerId);
            if (!player || !player.alive) continue;
            const nextActionAt = this.aiNextActionAt.get(playerId) || 0;
            if (now < nextActionAt) continue;
            const action = this.getAIAction(playerId);
            if (!action) continue;
            const skill = this.aiSkill.get(playerId) || this.aiProfiles[1];
            const jitter = Math.floor(Math.random() * 300) - 150;
            const baseDelay = Math.max(120, Math.floor(this.aiMoveIntervalMs * skill.baseDelayMult) + jitter);
            const guessDelay = Math.max(350, skill.guessDelayMin + Math.floor(Math.random() * (skill.guessDelayMax - skill.guessDelayMin)) + jitter);
            this.aiNextActionAt.set(playerId, now + (action.isGuess ? guessDelay : baseDelay));
            let result = null;
            if (action.type === 'move') {
                result = this.handleMove(playerId, action);
            } else if (action.type === 'flag') {
                result = this.handleFlag(playerId, action);
            } else if (action.type === 'chord') {
                result = this.handleChord(playerId, action);
            }
            if (result && result.success && result.update) {
                updates.push(result.update);
            }
            const focus = this.aiFocus.get(playerId);
            if (focus) {
                focus.ttl -= 1;
                if (action.focusMove) {
                    focus.x = action.x;
                    focus.y = action.y;
                }
                if (focus.ttl <= 0 || Math.random() < 0.1) {
                    const playerCells = this.grid.getPlayerCells(playerId);
                    if (playerCells.length > 0) {
                        const seed = playerCells[Math.floor(Math.random() * playerCells.length)];
                        focus.x = seed.x;
                        focus.y = seed.y;
                        focus.ttl = 30 + Math.floor(Math.random() * 30);
                    } else {
                        focus.ttl = 20 + Math.floor(Math.random() * 20);
                    }
                }
                this.aiFocus.set(playerId, focus);
            } else {
                this.aiFocus.set(playerId, { x: action.x, y: action.y, ttl: 30 + Math.floor(Math.random() * 30) });
            }
        }
        
        return updates;
    }
}

module.exports = Game;
