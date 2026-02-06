const CHUNK_SIZE = 16;
const MINE_PROBABILITY = 0.19;

class Grid {
    constructor() {
        this.chunks = new Map();
        this.cellStates = new Map();
        this.cellOwners = new Map();
        this.cellFlags = new Map();
        this.cellSeeds = new Map();
        console.log('Grid initialized - all data cleared');
    }
    
    getChunkKey(chunkX, chunkY) {
        return `${chunkX},${chunkY}`;
    }
    
    getCellKey(x, y) {
        return `${x},${y}`;
    }
    
    worldToChunk(x, y) {
        return {
            chunkX: Math.floor(x / CHUNK_SIZE),
            chunkY: Math.floor(y / CHUNK_SIZE),
            localX: ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE,
            localY: ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE
        };
    }
    
    seededRandom(x, y) {
        const cellKey = this.getCellKey(x, y);
        const cellSeed = this.cellSeeds.get(cellKey);
        const seedOffset = cellSeed !== undefined ? cellSeed : 0;
        const seed = x * 374761393 + y * 668265263 + seedOffset * 982451653;
        let value = Math.abs(Math.sin(seed) * 43758.5453123);
        return value - Math.floor(value);
    }
    
    isMine(x, y) {
        const cellKey = this.getCellKey(x, y);
        return this.seededRandom(x, y) < MINE_PROBABILITY;
    }
    
    countAdjacentMines(x, y) {
        let count = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                if (this.isMine(x + dx, y + dy)) {
                    count++;
                }
            }
        }
        return count;
    }
    
    getChunk(chunkX, chunkY) {
        const key = this.getChunkKey(chunkX, chunkY);
        
        if (this.chunks.has(key)) {
            return this.chunks.get(key);
        }
        
        const chunk = {
            x: chunkX,
            y: chunkY,
            cells: []
        };
        
        for (let localY = 0; localY < CHUNK_SIZE; localY++) {
            for (let localX = 0; localX < CHUNK_SIZE; localX++) {
                const worldX = chunkX * CHUNK_SIZE + localX;
                const worldY = chunkY * CHUNK_SIZE + localY;
                const cellKey = this.getCellKey(worldX, worldY);
                
                chunk.cells.push({
                    x: worldX,
                    y: worldY,
                    isMine: this.isMine(worldX, worldY),
                    adjacentMines: this.countAdjacentMines(worldX, worldY),
                    state: this.cellStates.get(cellKey) || 'covered',
                    owner: this.cellOwners.get(cellKey) || null,
                    flag: this.cellFlags.get(cellKey) || false
                });
            }
        }
        
        this.chunks.set(key, chunk);
        return chunk;
    }
    
    getCell(x, y) {
        const cellKey = this.getCellKey(x, y);
        return {
            x,
            y,
            isMine: this.isMine(x, y),
            adjacentMines: this.countAdjacentMines(x, y),
            state: this.cellStates.get(cellKey) || 'covered',
            owner: this.cellOwners.get(cellKey) || null,
            flag: this.cellFlags.get(cellKey) || false
        };
    }
    
    uncoverCell(x, y, playerId) {
        const cellKey = this.getCellKey(x, y);
        const currentState = this.cellStates.get(cellKey);
        
        if (currentState === 'uncovered') {
            return { success: false, reason: 'already_uncovered' };
        }
        
        if (this.cellFlags.get(cellKey)) {
            return { success: false, reason: 'flagged' };
        }
        
        const isMine = this.isMine(x, y);
        
        this.cellStates.set(cellKey, 'uncovered');
        this.cellOwners.set(cellKey, playerId);
        
        const chunksToInvalidate = new Set();
        const { chunkX, chunkY } = this.worldToChunk(x, y);
        chunksToInvalidate.add(this.getChunkKey(chunkX, chunkY));
        
        const uncoveredCells = [{ x, y, isMine, adjacentMines: this.countAdjacentMines(x, y) }];
        
        if (!isMine && this.countAdjacentMines(x, y) === 0) {
            const toProcess = [{ x, y }];
            const processed = new Set([cellKey]);
            
            while (toProcess.length > 0) {
                const current = toProcess.shift();
                
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        if (dx === 0 && dy === 0) continue;
                        
                        const nx = current.x + dx;
                        const ny = current.y + dy;
                        const nKey = this.getCellKey(nx, ny);
                        
                        if (processed.has(nKey)) continue;
                        processed.add(nKey);
                        
                        if (this.cellStates.get(nKey) === 'uncovered') continue;
                        if (this.cellFlags.get(nKey)) continue;
                        if (this.isMine(nx, ny)) continue;
                        
                        this.cellStates.set(nKey, 'uncovered');
                        this.cellOwners.set(nKey, playerId);
                        
                        const adjMines = this.countAdjacentMines(nx, ny);
                        uncoveredCells.push({ x: nx, y: ny, isMine: false, adjacentMines: adjMines });
                        
                        const { chunkX: nChunkX, chunkY: nChunkY } = this.worldToChunk(nx, ny);
                        chunksToInvalidate.add(this.getChunkKey(nChunkX, nChunkY));
                        
                        if (adjMines === 0) {
                            toProcess.push({ x: nx, y: ny });
                        }
                    }
                }
            }
        }
        
        for (const chunkKey of chunksToInvalidate) {
            this.chunks.delete(chunkKey);
        }
        
        return { success: true, isMine, uncoveredCells };
    }
    
    toggleFlag(x, y, playerId) {
        const cellKey = this.getCellKey(x, y);
        
        if (this.cellStates.get(cellKey) === 'uncovered') {
            return { success: false, reason: 'already_uncovered' };
        }
        
        const currentFlag = this.cellFlags.get(cellKey);
        this.cellFlags.set(cellKey, !currentFlag);
        
        const { chunkX, chunkY } = this.worldToChunk(x, y);
        this.chunks.delete(this.getChunkKey(chunkX, chunkY));
        
        return { success: true, flagged: !currentFlag };
    }
    
    getPlayerCells(playerId) {
        const cells = [];
        for (const [key, owner] of this.cellOwners.entries()) {
            if (owner === playerId) {
                const [x, y] = key.split(',').map(Number);
                cells.push({ x, y });
            }
        }
        return cells;
    }
    
    clearPlayerCells(playerId, immediate = false) {
        const cellsToReset = [];
        const flagsToRemove = [];
        
        for (const [key, owner] of this.cellOwners.entries()) {
            if (owner === playerId) {
                const [x, y] = key.split(',').map(Number);
                cellsToReset.push({ x, y });
                
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        if (dx === 0 && dy === 0) continue;
                        const adjKey = this.getCellKey(x + dx, y + dy);
                        if (this.cellFlags.get(adjKey)) {
                            const [fx, fy] = adjKey.split(',').map(Number);
                            flagsToRemove.push({ x: fx, y: fy });
                        }
                    }
                }
            }
        }
        
        for (const flag of flagsToRemove) {
            const flagKey = this.getCellKey(flag.x, flag.y);
            this.cellFlags.delete(flagKey);
            const { chunkX, chunkY } = this.worldToChunk(flag.x, flag.y);
            this.chunks.delete(this.getChunkKey(chunkX, chunkY));
        }
        
        return { cellsToReset, flagsToRemove };
    }
    
    recoverCell(x, y) {
        const cellKey = this.getCellKey(x, y);
        this.cellOwners.delete(cellKey);
        this.cellStates.delete(cellKey);
        this.cellFlags.delete(cellKey);
        
        const newSeed = Math.floor(Math.random() * 1000000000);
        this.cellSeeds.set(cellKey, newSeed);
        
        const { chunkX, chunkY } = this.worldToChunk(x, y);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const neighborKey = this.getChunkKey(chunkX + dx, chunkY + dy);
                this.chunks.delete(neighborKey);
            }
        }
        
        return true;
    }
}

module.exports = Grid;
