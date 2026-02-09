const urlParams = new URLSearchParams(window.location.search);
const debugToken = urlParams.get('token');
const isDebugPage = window.location.pathname.endsWith('/debug') || window.location.pathname.endsWith('/debug.html'); // I cannot fucking remember why i have a debug endpoint and a debug param but whatever.
const isDebugMode = (urlParams.get('debug') === '1' && !!debugToken) || (isDebugPage && !!debugToken); // i probably had a separate debug thing before.
const socket = isDebugMode ? io({ auth: { debugToken } }) : io();
if (!isDebugMode) {
    socket.emit('initGame');
}

socket.on('connect', () => {
    if (!isDebugMode && hasSpawned) {
        socket.emit('initGame');
    }
    if (isDebugMode && !hasSpawned) {
        socket.emit('requestActivePlayers');
    }
});

socket.on('debugInvalid', () => {
    window.location.href = '/admin.html';
});

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const CELL_SIZE = 32;
const CHUNK_SIZE = 16;

let playerId = null;
let player = null;
let players = new Map();
let chunks = new Map();
let cameraX = 0;
let cameraY = 0;
let mouseWorldX = 0;
let mouseWorldY = 0;
let isDead = false;
let deathTime = null;
let playerCells = new Set();
let clickableCells = new Set();
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let dragThreshold = 25;
let zoom = 1.0;
let deadPlayerCells = new Map();
let lastCameraX = 0;
let lastCameraY = 0;
let lastZoom = 1.0;
let clickStartX = 0;
let clickStartY = 0;
let mouseDragged = false;
let panStartCameraX = 0;
let panStartCameraY = 0;
let hasSpawned = false;
let showDebugMines = true;
let debugPlayerCycleIndex = -1;

let dirtyChunks = new Set();
let uncoverRevealTimes = new Map();
const UNCOVER_REVEAL_STEP = 1;

let gridPattern = null;
let gridPatternCanvas = document.createElement('canvas');
gridPatternCanvas.width = CELL_SIZE;
gridPatternCanvas.height = CELL_SIZE;
const gridPatternCtx = gridPatternCanvas.getContext('2d');

gridPatternCtx.fillStyle = 'rgb(128, 128, 128)';
gridPatternCtx.fillRect(0, 0, CELL_SIZE, CELL_SIZE);

gridPatternCtx.strokeStyle = 'rgb(160, 160, 160)';
gridPatternCtx.lineWidth = 2;
gridPatternCtx.beginPath();
gridPatternCtx.moveTo(1, CELL_SIZE - 1);
gridPatternCtx.lineTo(1, 1);
gridPatternCtx.lineTo(CELL_SIZE - 1, 1);
gridPatternCtx.stroke();

gridPatternCtx.strokeStyle = 'rgb(80, 80, 80)';
gridPatternCtx.lineWidth = 2;
gridPatternCtx.beginPath();
gridPatternCtx.moveTo(CELL_SIZE - 1, 1);
gridPatternCtx.lineTo(CELL_SIZE - 1, CELL_SIZE - 1);
gridPatternCtx.lineTo(1, CELL_SIZE - 1);
gridPatternCtx.stroke();

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    render();
});

socket.on('init', (data) => {
    playerId = data.playerId;
    player = data.player;
    hasSpawned = true;
    
    cameraX = player.x * CELL_SIZE;
    cameraY = player.y * CELL_SIZE;
    
    players.clear();
    chunks.clear();
    deadPlayerCells.clear();
    
    for (const p of data.activePlayers) {
        players.set(p.id, p);
    }
    
    updateUI();
    requestVisibleChunks();
});

socket.on('activePlayers', (data) => {
    if (!data || !data.activePlayers) return;
    players.clear();
    for (const p of data.activePlayers) {
        players.set(p.id, p);
    }
    updateUI();
});

socket.on('playerJoined', (playerData) => {
    players.set(playerData.id, playerData);
    if (playerData.id === playerId) {
        player = playerData;
    }
    updateUI();
});

socket.on('playerLeft', (id) => {
    players.delete(id);
    if (deadPlayerCells.has(id)) {
        deadPlayerCells.delete(id);
    }
    if (debugPlayerCycleIndex >= players.size) {
        debugPlayerCycleIndex = -1;
    }
    updateUI();
});

socket.on('cellsCleared', (data) => {
    console.log('Cells cleared, refreshing chunks');
    if (data.cells && data.cells.length > 0) {
        markDirtyChunksForCells(data.cells);
        invalidateChunksForCells(data.cells);
        requestChunksForCells(data.cells);
    }
    if (data.playerId && deadPlayerCells.has(data.playerId)) {
        deadPlayerCells.delete(data.playerId);
    }
});

socket.on('flagsRemoved', (data) => {
    if (data.flags && data.flags.length > 0) {
        markDirtyChunksForCells(data.flags);
        requestChunksForCells(data.flags);
    }
});

socket.on('gameUpdate', (data) => {
    console.log('Game update received:', data);
    
    if (data.type === 'move' || data.type === 'death' || data.type === 'noMoves' || data.type === 'spawn') {
        if (data.playerId === playerId) {
            player.score = data.score || player.score;
            
            if (data.type === 'death') {
                isDead = true;
                deathTime = Date.now();
                lastDeathScore = data.finalScore !== undefined ? data.finalScore : player.score;
            } else if (data.type === 'noMoves') {
                lastDeathScore = data.finalScore !== undefined ? data.finalScore : player.score;
                handleDeath('No more moves available!');
            }
        }
        
        const p = players.get(data.playerId);
        if (p) {
            p.score = data.score || p.score;
            p.alive = data.type !== 'death' && data.type !== 'noMoves';
        }
        
        if (data.type === 'death' && data.playerCells) {
            deadPlayerCells.set(data.playerId, {
                mineCell: data.mineCell,
                cells: new Set(data.playerCells.map(c => `${c.x},${c.y}`)),
                startTime: Date.now()
            });
            
            markDirtyChunksForCells(data.playerCells);
            if (isDebugMode && data.playerId === playerId) {
                showDebugMines = false;
            }
        }
        
        if (data.uncoveredCells && data.uncoveredCells.length > 0) {
            scheduleUncoverReveal(data.uncoveredCells);
            markDirtyChunksForCells(data.uncoveredCells);
            requestChunksForCells(data.uncoveredCells);
        }
        
    } else if (data.type === 'flag') {
        if (data.x !== undefined && data.y !== undefined) {
            requestChunksForCells([{ x: data.x, y: data.y }]);
        }
        
    } else if (data.type === 'autoFlag') {
        if (data.flags && data.flags.length > 0) {
            requestChunksForCells(data.flags);
        }
        
    } else if (data.type === 'respawn') {
        if (data.playerId === playerId) {
            player.x = data.x;
            player.y = data.y;
            player.alive = true;
            isDead = false;
            deathTime = null;
            lastDeathScore = null;
            
            cameraX = player.x * CELL_SIZE;
            cameraY = player.y * CELL_SIZE;
            
            document.getElementById('deathScreen').classList.remove('show');
        }
        
        const p = players.get(data.playerId);
        if (p) {
            p.x = data.x;
            p.y = data.y;
            p.alive = true;
        }
        
        if (data.uncoveredCells && data.uncoveredCells.length > 0) {
            scheduleUncoverReveal(data.uncoveredCells);
            markDirtyChunksForCells(data.uncoveredCells);
            requestChunksForCells(data.uncoveredCells);
        }
        
    } else if (data.updates) {
        for (const update of data.updates) {
            if (update.type === 'respawn' && update.playerId === playerId) {
                player.x = update.x;
                player.y = update.y;
                player.alive = true;
                isDead = false;
                deathTime = null;
                
                cameraX = player.x * CELL_SIZE;
                cameraY = player.y * CELL_SIZE;
                
                document.getElementById('deathScreen').classList.remove('show');
            }
            
            if (update.uncoveredCells && update.uncoveredCells.length > 0) {
                scheduleUncoverReveal(update.uncoveredCells);
                markDirtyChunksForCells(update.uncoveredCells);
                requestChunksForCells(update.uncoveredCells);
            }
        }
    }

    updateUI();
});

socket.on('cellRecovered', (data) => {
    const deadData = deadPlayerCells.get(data.playerId);
    if (deadData && deadData.cells) {
        deadData.cells.delete(`${data.x},${data.y}`);
        
        if (deadData.cells.size === 0) {
            deadPlayerCells.delete(data.playerId);
        }
    }
    
    const chunkX = Math.floor(data.x / CHUNK_SIZE);
    const chunkY = Math.floor(data.y / CHUNK_SIZE);
    const chunkKey = `${chunkX},${chunkY}`;
    const chunk = chunks.get(chunkKey);
    
    if (chunk) {
        for (const cell of chunk.cells) {
            if (cell.x === data.x && cell.y === data.y) {
                cell.state = 'covered';
                cell.owner = null;
                cell.flag = false;
                break;
            }
        }
    }
    
    markDirtyChunksForCells([{ x: data.x, y: data.y }]);
    requestChunksForCells([{ x: data.x, y: data.y }]);
});

socket.on('cellsUpdated', (data) => {
    if (data.cells && data.cells.length > 0) {
        for (const cell of data.cells) {
            updateCellData(cell);
        }
    }
});

socket.on('recoveryComplete', (data) => {
    if (isDebugMode && data.playerId === playerId) {
        showDebugMines = true;
        chunks.clear();
        requestVisibleChunks();
    }
    if (isDebugMode) return;
    if (data.playerId === playerId) {
        document.getElementById('deathReason').textContent = 'You hit a mine!';
        const finalScore = lastDeathScore !== null ? lastDeathScore : player.score;
        document.getElementById('finalScore').textContent = `Final Score: ${finalScore}`;
        document.getElementById('deathScreen').classList.add('show');
        
        const timerInterval = setInterval(() => {
            if (!isDead) {
                clearInterval(timerInterval);
                return;
            }
            
            const elapsed = Math.floor((Date.now() - deathTime) / 1000);
            const remaining = Math.max(0, 30 - elapsed);
            document.getElementById('respawnTimer').textContent = remaining;
            
            if (remaining === 0) {
                clearInterval(timerInterval);
            }
        }, 100);
    }
});

socket.on('chunks', (chunksData) => {
    console.log('Received chunks:', chunksData.length);
    if (isDebugMode) {
        let mineCount = 0;
        for (const c of chunksData) {
            for (const cell of c.cells) {
                if (cell.isMine) mineCount++;
            }
        }
        console.log('Debug: mines in chunk data:', mineCount);
    }
    for (const newChunk of chunksData) {
        const key = `${newChunk.x},${newChunk.y}`;
        const existingChunk = chunks.get(key);
        
        let chunkChanged = false;
        
        if (existingChunk) {
            for (const newCell of newChunk.cells) {
                let found = false;
                for (const existingCell of existingChunk.cells) {
                    if (existingCell.x === newCell.x && existingCell.y === newCell.y) {
                        if (existingCell.state !== newCell.state ||
                            existingCell.owner !== newCell.owner ||
                            existingCell.flag !== newCell.flag ||
                            existingCell.isMine !== newCell.isMine ||
                            existingCell.adjacentMines !== newCell.adjacentMines) {
                            existingCell.state = newCell.state;
                            existingCell.owner = newCell.owner;
                            existingCell.flag = newCell.flag;
                            existingCell.isMine = newCell.isMine;
                            existingCell.adjacentMines = newCell.adjacentMines;
                            chunkChanged = true;
                        }
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    existingChunk.cells.push(newCell);
                    chunkChanged = true;
                }
            }
        } else {
            chunks.set(key, newChunk);
            chunkChanged = true;
        }
        
        if (dirtyChunks.has(key)) {
            dirtyChunks.delete(key);
        }
    }
    updatePlayerCells();
});

socket.on('error', (error) => {
    console.error('Game error:', error);
});

socket.on('adminMessage', (data) => {
    showAdminPopup(data.title, data.text);
});

socket.on('leaderboard', (data) => {
    updateLeaderboard(data);
});

function showAdminPopup(title, text) {
    document.getElementById('adminPopupTitle').textContent = title;
    document.getElementById('adminPopupText').textContent = text;
    document.getElementById('adminPopup').style.display = 'flex';
}

function closeAdminPopup() {
    document.getElementById('adminPopup').style.display = 'none';
}

window.closeAdminPopup = closeAdminPopup;

function handleDeath(reason) {
    isDead = true;
    deathTime = Date.now();
    if (isDebugMode) return;
    
    document.getElementById('deathReason').textContent = reason;
    document.getElementById('finalScore').textContent = `Final Score: ${player.score}`;
    document.getElementById('deathScreen').classList.add('show');
    
    const timerInterval = setInterval(() => {
        if (!isDead) {
            clearInterval(timerInterval);
            return;
        }
        
        const elapsed = Math.floor((Date.now() - deathTime) / 1000);
        const remaining = Math.max(0, 30 - elapsed);
        document.getElementById('respawnTimer').textContent = remaining;
        
        if (remaining === 0) {
            clearInterval(timerInterval);
        }
    }, 100);
}

function updateCellInChunk(cellData) {
    const chunkX = Math.floor(cellData.x / CHUNK_SIZE);
    const chunkY = Math.floor(cellData.y / CHUNK_SIZE);
    const chunkKey = `${chunkX},${chunkY}`;
    const chunk = chunks.get(chunkKey);
    
    if (chunk) {
        let found = false;
        for (const cell of chunk.cells) {
            if (cell.x === cellData.x && cell.y === cellData.y) {
                cell.state = 'uncovered';
                cell.owner = cellData.owner || null;
                cell.isMine = cellData.isMine || false;
                cell.adjacentMines = cellData.adjacentMines || 0;
                found = true;
                break;
            }
        }
        
        if (!found) {
            chunk.cells.push({
                x: cellData.x,
                y: cellData.y,
                state: 'uncovered',
                owner: cellData.owner || null,
                isMine: cellData.isMine || false,
                adjacentMines: cellData.adjacentMines || 0,
                flag: false
            });
        }
    }
}

function updateCellFlag(x, y, flagged) {
    const chunkX = Math.floor(x / CHUNK_SIZE);
    const chunkY = Math.floor(y / CHUNK_SIZE);
    const chunkKey = `${chunkX},${chunkY}`;
    const chunk = chunks.get(chunkKey);
    
    if (chunk) {
        for (const cell of chunk.cells) {
            if (cell.x === x && cell.y === y) {
                cell.flag = flagged;
                break;
            }
        }
    }
}

function updateCellData(cellData) {
    const chunkX = Math.floor(cellData.x / CHUNK_SIZE);
    const chunkY = Math.floor(cellData.y / CHUNK_SIZE);
    const chunkKey = `${chunkX},${chunkY}`;
    const chunk = chunks.get(chunkKey);
    
    if (!chunk) return;
    
    for (const cell of chunk.cells) {
        if (cell.x === cellData.x && cell.y === cellData.y) {
            cell.state = cellData.state;
            cell.owner = cellData.owner || null;
            cell.flag = cellData.flag || false;
            cell.isMine = cellData.isMine || false;
            cell.adjacentMines = cellData.adjacentMines || 0;
            return;
        }
    }
    
    chunk.cells.push({
        x: cellData.x,
        y: cellData.y,
        state: cellData.state || 'covered',
        owner: cellData.owner || null,
        flag: cellData.flag || false,
        isMine: cellData.isMine || false,
        adjacentMines: cellData.adjacentMines || 0
    });
}

function scheduleUncoverReveal(cells) {
    const startTime = Date.now();
    for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const key = `${cell.x},${cell.y}`;
        uncoverRevealTimes.set(key, startTime + i * UNCOVER_REVEAL_STEP);
    }
}

function invalidateChunksForCells(cells) {
    const chunksToInvalidate = new Set();
    for (const cell of cells) {
        const chunkX = Math.floor(cell.x / CHUNK_SIZE);
        const chunkY = Math.floor(cell.y / CHUNK_SIZE);
        chunksToInvalidate.add(`${chunkX},${chunkY}`);
        
        const localX = ((cell.x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const localY = ((cell.y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        
        if (localX === 0) chunksToInvalidate.add(`${chunkX - 1},${chunkY}`);
        if (localX === CHUNK_SIZE - 1) chunksToInvalidate.add(`${chunkX + 1},${chunkY}`);
        if (localY === 0) chunksToInvalidate.add(`${chunkX},${chunkY - 1}`);
        if (localY === CHUNK_SIZE - 1) chunksToInvalidate.add(`${chunkX},${chunkY + 1}`);
    }
    for (const key of chunksToInvalidate) {
        chunks.delete(key);
    }
}

function invalidateChunksForCell(x, y) {
    const chunkX = Math.floor(x / CHUNK_SIZE);
    const chunkY = Math.floor(y / CHUNK_SIZE);
    chunks.delete(`${chunkX},${chunkY}`);
}

function requestChunksForCells(cells) {
    const chunkKeys = new Set();
    const visibleChunks = getVisibleChunkKeys();
    
    for (const cell of cells) {
        const chunkX = Math.floor(cell.x / CHUNK_SIZE);
        const chunkY = Math.floor(cell.y / CHUNK_SIZE);
        const chunkKey = `${chunkX},${chunkY}`;
        
        if (visibleChunks.has(chunkKey)) {
            chunkKeys.add(chunkKey);
        } else {
            dirtyChunks.add(chunkKey);
        }
        
        const localX = ((cell.x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const localY = ((cell.y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        
        if (localX === 0) {
            const adjKey = `${chunkX - 1},${chunkY}`;
            if (visibleChunks.has(adjKey)) chunkKeys.add(adjKey);
            else dirtyChunks.add(adjKey);
        }
        if (localX === CHUNK_SIZE - 1) {
            const adjKey = `${chunkX + 1},${chunkY}`;
            if (visibleChunks.has(adjKey)) chunkKeys.add(adjKey);
            else dirtyChunks.add(adjKey);
        }
        if (localY === 0) {
            const adjKey = `${chunkX},${chunkY - 1}`;
            if (visibleChunks.has(adjKey)) chunkKeys.add(adjKey);
            else dirtyChunks.add(adjKey);
        }
        if (localY === CHUNK_SIZE - 1) {
            const adjKey = `${chunkX},${chunkY + 1}`;
            if (visibleChunks.has(adjKey)) chunkKeys.add(adjKey);
            else dirtyChunks.add(adjKey);
        }
    }
    
    if (chunkKeys.size > 0) {
        socket.emit('requestChunks', { chunkKeys: Array.from(chunkKeys), debug: isDebugMode, debugToken: debugToken || undefined });
    }
}

function markDirtyChunksForCells(cells) {
    for (const cell of cells) {
        const chunkX = Math.floor(cell.x / CHUNK_SIZE);
        const chunkY = Math.floor(cell.y / CHUNK_SIZE);
        dirtyChunks.add(`${chunkX},${chunkY}`);
        
        const localX = ((cell.x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const localY = ((cell.y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        
        if (localX === 0) dirtyChunks.add(`${chunkX - 1},${chunkY}`);
        if (localX === CHUNK_SIZE - 1) dirtyChunks.add(`${chunkX + 1},${chunkY}`);
        if (localY === 0) dirtyChunks.add(`${chunkX},${chunkY - 1}`);
        if (localY === CHUNK_SIZE - 1) dirtyChunks.add(`${chunkX},${chunkY + 1}`);
    }
}

function getVisibleChunkKeys() {
    const keys = new Set();
    const buffer = zoom < 0.75 ? 0 : 1;
    const startChunkX = Math.floor((cameraX - canvas.width / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) - buffer;
    const endChunkX = Math.floor((cameraX + canvas.width / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) + buffer;
    const startChunkY = Math.floor((cameraY - canvas.height / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) - buffer;
    const endChunkY = Math.floor((cameraY + canvas.height / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) + buffer;
    
    for (let cx = startChunkX; cx <= endChunkX; cx++) {
        for (let cy = startChunkY; cy <= endChunkY; cy++) {
            keys.add(`${cx},${cy}`);
        }
    }
    
    return keys;
}

function cleanupDistantChunks() {
    const visibleKeys = getVisibleChunkKeys();
    const cleanupDistance = 5;
    const buffer = zoom < 0.75 ? 0 : 1;
    const startChunkX = Math.floor((cameraX - canvas.width / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) - buffer - cleanupDistance;
    const endChunkX = Math.floor((cameraX + canvas.width / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) + buffer + cleanupDistance;
    const startChunkY = Math.floor((cameraY - canvas.height / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) - buffer - cleanupDistance;
    const endChunkY = Math.floor((cameraY + canvas.height / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) + buffer + cleanupDistance;
    
    for (const [key, chunk] of chunks.entries()) {
        if (!visibleKeys.has(key)) {
            const [cx, cy] = key.split(',').map(Number);
            if (cx < startChunkX || cx > endChunkX || cy < startChunkY || cy > endChunkY) {
                chunks.delete(key);
            }
        }
    }
}

function requestVisibleChunks() {
    const chunkKeys = [];
    
    const buffer = zoom < 0.75 ? 0 : 1;
    const startChunkX = Math.floor((cameraX - canvas.width / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) - buffer;
    const endChunkX = Math.floor((cameraX + canvas.width / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) + buffer;
    const startChunkY = Math.floor((cameraY - canvas.height / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) - buffer;
    const endChunkY = Math.floor((cameraY + canvas.height / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) + buffer;
    
    const maxChunks = 50;
    
    for (let cx = startChunkX; cx <= endChunkX && chunkKeys.length < maxChunks; cx++) {
        for (let cy = startChunkY; cy <= endChunkY && chunkKeys.length < maxChunks; cy++) {
            const key = `${cx},${cy}`;
            if (!chunks.has(key) || dirtyChunks.has(key)) {
                chunkKeys.push(key);
            }
        }
    }
    
    if (chunkKeys.length > 0) {
        socket.emit('requestChunks', { chunkKeys, debug: isDebugMode, debugToken: debugToken || undefined });
    }
}

function updateUI() {
    document.getElementById('score').textContent = `Score: ${player ? player.score : 0}`;
    document.getElementById('playerCount').textContent = `Players: ${players.size}`;
}

function cycleCameraToNextPlayer() {
    const playerList = Array.from(players.values());
    if (playerList.length === 0) return;
    playerList.sort((a, b) => {
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
    });
    debugPlayerCycleIndex = (debugPlayerCycleIndex + 1) % playerList.length;
    const target = playerList[debugPlayerCycleIndex];
    if (!target) return;
    cameraX = target.x * CELL_SIZE;
    cameraY = target.y * CELL_SIZE;
    lastCameraX = cameraX;
    lastCameraY = cameraY;
}

function updateLeaderboard(leaderboardData) {
    const content = document.getElementById('leaderboardContent');
    if (!leaderboardData || leaderboardData.length === 0) {
        content.innerHTML = '<div style="text-align: center; color: rgb(128, 128, 128);">No players</div>';
        return;
    }
    
    const yourRank = leaderboardData.findIndex(p => p.id === playerId);
    const lines = [];
    
    const top10 = leaderboardData.slice(0, 10);
    for (let i = 0; i < top10.length; i++) {
        const isYou = top10[i].id === playerId;
        const className = isYou ? 'leaderboard-entry you' : 'leaderboard-entry';
        const youText = isYou ? ' (you)' : '';
        lines.push(`<div class="${className}">${i + 1}. ${top10[i].score} points${youText}</div>`);
    }
    
    if (yourRank >= 10) {
        lines.push('<div class="leaderboard-ellipsis">...</div>');
        
        const contextStart = Math.max(10, yourRank - 1);
        const contextEnd = Math.min(leaderboardData.length, yourRank + 2);
        
        for (let i = contextStart; i < contextEnd; i++) {
            const isYou = i === yourRank;
            const className = isYou ? 'leaderboard-entry you' : 'leaderboard-entry';
            const youText = isYou ? ' (you)' : '';
            lines.push(`<div class="${className}">${i + 1}. ${leaderboardData[i].score} points${youText}</div>`);
        }
    }
    
    content.innerHTML = lines.join('');
}

function toggleLeaderboard() {
    const content = document.getElementById('leaderboardContent');
    const header = document.getElementById('leaderboardHeader');
    
    if (content.classList.contains('hidden')) {
        content.classList.remove('hidden');
        header.textContent = '▼ Leaderboard';
    } else {
        content.classList.add('hidden');
        header.textContent = '▶ Leaderboard';
    }
}

window.toggleLeaderboard = toggleLeaderboard;

function updatePlayerCells() {
    playerCells.clear();
    clickableCells.clear();
    const now = Date.now();
    
    for (const chunk of chunks.values()) {
        for (const cell of chunk.cells) {
            if (cell.owner === playerId && cell.state === 'uncovered') {
                const cellKey = `${cell.x},${cell.y}`;
                const revealAt = uncoverRevealTimes.get(cellKey);
                if (revealAt && now < revealAt) {
                    continue;
                }
                playerCells.add(cellKey);
                
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        if (dx === 0 && dy === 0) continue;
                        clickableCells.add(`${cell.x + dx},${cell.y + dy}`);
                    }
                }
            }
        }
    }
}

function isAdjacentToPlayerCell(x, y) {
    return clickableCells.has(`${x},${y}`);
}

function render() {
    let revealExpired = false;
    if (uncoverRevealTimes.size > 0) {
        const now = Date.now();
        for (const revealAt of uncoverRevealTimes.values()) {
            if (revealAt <= now) {
                revealExpired = true;
                break;
            }
        }
    }
    if (revealExpired) {
        updatePlayerCells();
    }
    ctx.fillStyle = 'rgb(192, 192, 192)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const scaledCellSize = CELL_SIZE * zoom;
    const offsetX = canvas.width / 2 - cameraX * zoom;
    const offsetY = canvas.height / 2 - cameraY * zoom;
    const renderNow = Date.now();
    const visibleCells = new Map();
    
    const simplifiedRendering = scaledCellSize < 16;
    
    if (!gridPattern) {
        gridPattern = ctx.createPattern(gridPatternCanvas, 'repeat');
    }
    
    ctx.save();
	ctx.imageSmoothingEnabled = false;
    ctx.translate(offsetX % (CELL_SIZE * zoom), offsetY % (CELL_SIZE * zoom));
    ctx.scale(zoom, zoom);
    ctx.fillStyle = gridPattern;
    ctx.fillRect(
        -CELL_SIZE * 2,
        -CELL_SIZE * 2,
        (canvas.width / zoom) + CELL_SIZE * 4,
        (canvas.height / zoom) + CELL_SIZE * 4
    );
    ctx.restore();
    
    for (const chunk of chunks.values()) {
        for (const cell of chunk.cells) {
            const screenX = cell.x * scaledCellSize + offsetX;
            const screenY = cell.y * scaledCellSize + offsetY;
            
            if (screenX + scaledCellSize < 0 || screenX > canvas.width ||
                screenY + scaledCellSize < 0 || screenY > canvas.height) {
                continue;
            }
            
            if (scaledCellSize < 3) continue;
            
            const shouldRenderCovered = cell.flag || isAdjacentToPlayerCell(cell.x, cell.y);
            if (cell.state === 'uncovered') {
                const cellKey = `${cell.x},${cell.y}`;
                const revealAt = uncoverRevealTimes.get(cellKey);
                if (revealAt && renderNow < revealAt) {
                    continue;
                }
                if (revealAt) {
                    uncoverRevealTimes.delete(cellKey);
                }
                visibleCells.set(cellKey, cell);
                renderUncoveredCell(cell, screenX, screenY, scaledCellSize, simplifiedRendering);
            } else if (shouldRenderCovered) {
                renderCoveredCell(cell, screenX, screenY, scaledCellSize, simplifiedRendering, false);
            }
        }
    }

    if (visibleCells.size > 0) {
        renderPlayerBorders(visibleCells, scaledCellSize, offsetX, offsetY);
    }
    
    if (isDebugMode && showDebugMines) {
        for (const chunk of chunks.values()) {
            for (const cell of chunk.cells) {
                if (cell.state === 'covered' && cell.isMine && isAdjacentToPlayerCell(cell.x, cell.y)) {
                    const screenX = cell.x * scaledCellSize + offsetX;
                    const screenY = cell.y * scaledCellSize + offsetY;
                    
                    if (screenX + scaledCellSize < 0 || screenX > canvas.width ||
                        screenY + scaledCellSize < 0 || screenY > canvas.height) {
                        continue;
                    }
                    
                    const inset = Math.max(2, 6 * zoom);
                    ctx.strokeStyle = 'rgb(0, 0, 0)';
                    ctx.lineWidth = 2 * zoom;
                    ctx.beginPath();
                    ctx.moveTo(screenX + inset, screenY + inset);
                    ctx.lineTo(screenX + scaledCellSize - inset, screenY + scaledCellSize - inset);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(screenX + scaledCellSize - inset, screenY + inset);
                    ctx.lineTo(screenX + inset, screenY + scaledCellSize - inset);
                    ctx.stroke();
                }
            }
        }
    }
    
    if (!simplifiedRendering) {
        const hoverCellX = Math.floor((mouseWorldX) / CELL_SIZE);
        const hoverCellY = Math.floor((mouseWorldY) / CELL_SIZE);
        const hoverScreenX = hoverCellX * scaledCellSize + offsetX;
        const hoverScreenY = hoverCellY * scaledCellSize + offsetY;
        
        ctx.strokeStyle = 'rgb(255, 255, 0)';
        ctx.lineWidth = 2 * zoom;
        const inset = zoom;
        ctx.strokeRect(hoverScreenX + inset, hoverScreenY + inset, scaledCellSize - 2 * inset, scaledCellSize - 2 * inset);

    }

    if (isDebugMode) {
        renderChunkBorders(scaledCellSize, offsetX, offsetY);
    }
}

function renderPlayerBorders(visibleCells, scaledCellSize, offsetX, offsetY) {
    const thickness = Math.min(Math.max(3, Math.round(5 * zoom)), Math.floor(scaledCellSize / 2));
    const half = thickness / 2;
    for (const cell of visibleCells.values()) {
        if (!cell.owner) continue;
        const ownerA = players.get(cell.owner);
        if (!ownerA) continue;
        const colorA = darkenColor(ownerA.color, 0.65);
        const rightKey = `${cell.x + 1},${cell.y}`;
        const downKey = `${cell.x},${cell.y + 1}`;
        const rightCell = visibleCells.get(rightKey);
        if (rightCell && rightCell.owner && rightCell.owner !== cell.owner) {
            const ownerB = players.get(rightCell.owner);
            if (ownerB) {
                const screenX = cell.x * scaledCellSize + offsetX;
                const screenY = cell.y * scaledCellSize + offsetY;
                const xBoundary = screenX + scaledCellSize;
                ctx.fillStyle = colorA;
                ctx.fillRect(xBoundary - half, screenY, half, scaledCellSize);
                ctx.fillStyle = darkenColor(ownerB.color, 0.65);
                ctx.fillRect(xBoundary, screenY, half, scaledCellSize);
            }
        }
        const downCell = visibleCells.get(downKey);
        if (downCell && downCell.owner && downCell.owner !== cell.owner) {
            const ownerB = players.get(downCell.owner);
            if (ownerB) {
                const screenX = cell.x * scaledCellSize + offsetX;
                const screenY = cell.y * scaledCellSize + offsetY;
                const yBoundary = screenY + scaledCellSize;
                ctx.fillStyle = colorA;
                ctx.fillRect(screenX, yBoundary - half, scaledCellSize, half);
                ctx.fillStyle = darkenColor(ownerB.color, 0.65);
                ctx.fillRect(screenX, yBoundary, scaledCellSize, half);
            }
        }
    }
}

function darkenColor(color, factor) {
    if (!color || typeof color !== 'string') return color;
    if (color[0] !== '#' || (color.length !== 7 && color.length !== 4)) {
        return color;
    }
    let r = 0;
    let g = 0;
    let b = 0;
    if (color.length === 4) {
        r = parseInt(color[1] + color[1], 16);
        g = parseInt(color[2] + color[2], 16);
        b = parseInt(color[3] + color[3], 16);
    } else {
        r = parseInt(color.slice(1, 3), 16);
        g = parseInt(color.slice(3, 5), 16);
        b = parseInt(color.slice(5, 7), 16);
    }
    r = Math.max(0, Math.min(255, Math.round(r * factor)));
    g = Math.max(0, Math.min(255, Math.round(g * factor)));
    b = Math.max(0, Math.min(255, Math.round(b * factor)));
    const toHex = (v) => v.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function renderChunkBorders(scaledCellSize, offsetX, offsetY) {
    const buffer = zoom < 0.75 ? 0 : 1;
    const startChunkX = Math.floor((cameraX - canvas.width / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) - buffer;
    const endChunkX = Math.floor((cameraX + canvas.width / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) + buffer;
    const startChunkY = Math.floor((cameraY - canvas.height / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) - buffer;
    const endChunkY = Math.floor((cameraY + canvas.height / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) + buffer;
    
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 0, 255, 0.6)';
    ctx.lineWidth = Math.max(1, 1 * zoom);
    
    for (let cx = startChunkX; cx <= endChunkX; cx++) {
        for (let cy = startChunkY; cy <= endChunkY; cy++) {
            const x = cx * CHUNK_SIZE * scaledCellSize + offsetX;
            const y = cy * CHUNK_SIZE * scaledCellSize + offsetY;
            const size = CHUNK_SIZE * scaledCellSize;
            ctx.strokeRect(x, y, size, size);
        }
    }
    
    ctx.restore();
}

function renderUncoveredCell(cell, screenX, screenY, scaledCellSize, simplifiedRendering) {
    const cellKey = `${cell.x},${cell.y}`;
    let isDeadCell = false;
    let isMineCell = false;
    
    for (const [deadPlayerId, deadData] of deadPlayerCells.entries()) {
        if (deadData.cells.has(cellKey)) {
            isDeadCell = true;
            if (deadData.mineCell && cell.x === deadData.mineCell.x && cell.y === deadData.mineCell.y) {
                isMineCell = true;
            }
            break;
        }
    }
    
    ctx.fillStyle = 'rgb(192, 192, 192)';
    ctx.fillRect(screenX, screenY, scaledCellSize, scaledCellSize);
    
    if (!simplifiedRendering) {
        const halfLine = zoom * 0.5;
        ctx.strokeStyle = 'rgb(128, 128, 128)';
        ctx.lineWidth = 1 * zoom;
        ctx.beginPath();
        ctx.moveTo(screenX + halfLine, screenY + scaledCellSize - halfLine);
        ctx.lineTo(screenX + halfLine, screenY + halfLine);
        ctx.lineTo(screenX + scaledCellSize - halfLine, screenY + halfLine);
        ctx.stroke();
    }
    
    if (cell.owner && !isDeadCell) {
        const owner = players.get(cell.owner);
        if (owner) {
            ctx.fillStyle = owner.color;
            ctx.globalAlpha = simplifiedRendering ? 0.3 : 0.12;
            ctx.fillRect(screenX + 1, screenY + 1, scaledCellSize - 2, scaledCellSize - 2);
            ctx.globalAlpha = 1.0;
        }
    } else if (isDeadCell) {
        ctx.fillStyle = 'rgb(100, 100, 100)';
        ctx.globalAlpha = 0.3;
        ctx.fillRect(screenX + 1, screenY + 1, scaledCellSize - 2, scaledCellSize - 2);
        ctx.globalAlpha = 1.0;
    }
    
    if ((cell.isMine || isMineCell) && !simplifiedRendering) {
        const mineRadius = 5 * zoom;
        const centerX = screenX + scaledCellSize / 2;
        const centerY = screenY + scaledCellSize / 2;
        
        ctx.fillStyle = 'rgb(0, 0, 0)';
        ctx.beginPath();
        ctx.arc(centerX, centerY, mineRadius, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.strokeStyle = 'rgb(0, 0, 0)';
        ctx.lineWidth = 2 * zoom;
        for (let i = 0; i < 8; i++) {
            const angle = (i * Math.PI) / 4;
            const x1 = centerX + Math.cos(angle) * mineRadius * 0.7;
            const y1 = centerY + Math.sin(angle) * mineRadius * 0.7;
            const x2 = centerX + Math.cos(angle) * (mineRadius + 6 * zoom);
            const y2 = centerY + Math.sin(angle) * (mineRadius + 6 * zoom);
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }
        
        ctx.fillStyle = 'rgb(255, 255, 255)';
        ctx.beginPath();
        ctx.arc(centerX - 2 * zoom, centerY - 2 * zoom, 2 * zoom, 0, Math.PI * 2);
        ctx.fill();
    } else if ((cell.isMine || isMineCell) && simplifiedRendering) {
        ctx.fillStyle = 'rgb(0, 0, 0)';
        ctx.fillRect(screenX + 1, screenY + 1, scaledCellSize - 2, scaledCellSize - 2);
    } else if (cell.adjacentMines > 0 && !simplifiedRendering && !isDeadCell && cell.owner === playerId) {
        const numberColors = [
            null,
            'rgb(0, 0, 255)',
            'rgb(0, 128, 0)',
            'rgb(255, 0, 0)',
            'rgb(0, 0, 128)',
            'rgb(128, 0, 0)',
            'rgb(0, 128, 128)',
            'rgb(0, 0, 0)',
            'rgb(128, 128, 128)'
        ];
        ctx.fillStyle = numberColors[cell.adjacentMines];
        ctx.font = `bold ${16 * zoom}px "MS Sans Serif", "Microsoft Sans Serif", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(cell.adjacentMines, screenX + scaledCellSize / 2, screenY + scaledCellSize / 2);
    }

}

function renderCoveredCell(cell, screenX, screenY, scaledCellSize, simplifiedRendering, forceDraw = false) {
    const canClick = isAdjacentToPlayerCell(cell.x, cell.y) && !isDead;
    const shouldDraw = forceDraw || canClick;
    
    if (shouldDraw) {
        ctx.fillStyle = canClick ? 'rgb(192, 192, 192)' : 'rgb(128, 128, 128)';
        ctx.fillRect(screenX, screenY, scaledCellSize, scaledCellSize);
        
        if (!simplifiedRendering) {
            const halfLine = zoom;
            ctx.strokeStyle = canClick ? 'rgb(255, 255, 255)' : 'rgb(160, 160, 160)';
            ctx.lineWidth = 2 * zoom;
            ctx.beginPath();
            ctx.moveTo(screenX + halfLine, screenY + scaledCellSize - halfLine);
            ctx.lineTo(screenX + halfLine, screenY + halfLine);
            ctx.lineTo(screenX + scaledCellSize - halfLine, screenY + halfLine);
            ctx.stroke();
            
            ctx.strokeStyle = canClick ? 'rgb(128, 128, 128)' : 'rgb(80, 80, 80)';
            ctx.lineWidth = 2 * zoom;
            ctx.beginPath();
            ctx.moveTo(screenX + scaledCellSize - halfLine, screenY + halfLine);
            ctx.lineTo(screenX + scaledCellSize - halfLine, screenY + scaledCellSize - halfLine);
            ctx.lineTo(screenX + halfLine, screenY + scaledCellSize - halfLine);
            ctx.stroke();
        }
    }
    
    if (isDebugMode && showDebugMines && cell.isMine) {
        const inset = Math.max(2, 6 * zoom);
        ctx.strokeStyle = 'rgb(0, 0, 0)';
        ctx.lineWidth = Math.max(1, 2 * zoom);
        ctx.beginPath();
        ctx.moveTo(screenX + inset, screenY + inset);
        ctx.lineTo(screenX + scaledCellSize - inset, screenY + scaledCellSize - inset);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(screenX + scaledCellSize - inset, screenY + inset);
        ctx.lineTo(screenX + inset, screenY + scaledCellSize - inset);
        ctx.stroke();
    }

    if (cell.flag) {
        if (!simplifiedRendering) {
            ctx.fillStyle = 'rgb(0, 0, 0)';
            ctx.fillRect(screenX + scaledCellSize / 2 - 0.5 * zoom, screenY + 8 * zoom, 1 * zoom, 12 * zoom);
            
            ctx.fillStyle = 'rgb(255, 0, 0)';
            ctx.beginPath();
            ctx.moveTo(screenX + scaledCellSize / 2 + 1 * zoom, screenY + 8 * zoom);
            ctx.lineTo(screenX + scaledCellSize / 2 + 1 * zoom, screenY + 14 * zoom);
            ctx.lineTo(screenX + scaledCellSize / 2 + 8 * zoom, screenY + 11 * zoom);
            ctx.closePath();
            ctx.fill();
        } else {
            ctx.fillStyle = 'rgb(255, 0, 0)';
            ctx.fillRect(screenX + 1, screenY + 1, scaledCellSize - 2, scaledCellSize - 2);
        }
    }

}

function renderCellByCell() {
    const scaledCellSize = CELL_SIZE * zoom;
    const offsetX = canvas.width / 2 - cameraX * zoom;
    const offsetY = canvas.height / 2 - cameraY * zoom;
    
    const simplifiedRendering = scaledCellSize < 16;
    
    for (const chunk of chunks.values()) {
        for (const cell of chunk.cells) {
            const screenX = cell.x * scaledCellSize + offsetX;
            const screenY = cell.y * scaledCellSize + offsetY;
            
            if (screenX + scaledCellSize < 0 || screenX > canvas.width ||
                screenY + scaledCellSize < 0 || screenY > canvas.height) {
                continue;
            }
            
            if (scaledCellSize < 3) continue;
            
            if (cell.state === 'uncovered') {
                const cellKey = `${cell.x},${cell.y}`;
                const revealAt = uncoverRevealTimes.get(cellKey);
                if (revealAt && Date.now() < revealAt) {
                    continue;
                }
                if (revealAt) {
                    uncoverRevealTimes.delete(cellKey);
                }
                renderUncoveredCell(cell, screenX, screenY, scaledCellSize, simplifiedRendering);
            } else if (cell.flag) {
                renderCoveredCell(cell, screenX, screenY, scaledCellSize, simplifiedRendering);
            }
        }
    }
}

let keys = {};
window.addEventListener('keydown', (e) => {
    keys[e.key.toLowerCase()] = true;
    if (isDebugMode && (e.key === ']' || e.code === 'BracketRight') && !e.repeat) {
        cycleCameraToNextPlayer();
        e.preventDefault();
    }

});

window.addEventListener('keyup', (e) => {
    keys[e.key.toLowerCase()] = false;
});

function gameLoop() {
    const speed = 10;
    let moved = false;
    
    if (keys['w'] || keys['arrowup']) {
        cameraY -= speed;
        moved = true;
    }
    if (keys['s'] || keys['arrowdown']) {
        cameraY += speed;
        moved = true;
    }
    if (keys['a'] || keys['arrowleft']) {
        cameraX -= speed;
        moved = true;
    }
    if (keys['d'] || keys['arrowright']) {
        cameraX += speed;
        moved = true;
    }
    
    render();
    requestAnimationFrame(gameLoop);
}

canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    if (isPanning) {
        const deltaX = mouseX - panStartX;
        const deltaY = mouseY - panStartY;
        cameraX -= deltaX / zoom;
        cameraY -= deltaY / zoom;
        panStartX = mouseX;
        panStartY = mouseY;

        const dragDistance = Math.sqrt(
            Math.pow(mouseX - clickStartX, 2) + Math.pow(mouseY - clickStartY, 2)
        );
        if (dragDistance > dragThreshold) {
            mouseDragged = true;
        }
    }
    
    mouseWorldX = (mouseX - canvas.width / 2) / zoom + cameraX;
    mouseWorldY = (mouseY - canvas.height / 2) / zoom + cameraY;
});

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const worldXBefore = (mouseX - canvas.width / 2) / zoom + cameraX;
    const worldYBefore = (mouseY - canvas.height / 2) / zoom + cameraY;
    
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    zoom = Math.max(0.5, Math.min(3, zoom * zoomFactor));
    
    const worldXAfter = (mouseX - canvas.width / 2) / zoom + cameraX;
    const worldYAfter = (mouseY - canvas.height / 2) / zoom + cameraY;
    
    cameraX += worldXBefore - worldXAfter;
    cameraY += worldYBefore - worldYAfter;
});

canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    if (e.button === 0 || e.button === 1) {
        isPanning = true;
        panStartX = mouseX;
        panStartY = mouseY;
        clickStartX = mouseX;
        clickStartY = mouseY;
        panStartCameraX = cameraX;
        panStartCameraY = cameraY;
        mouseDragged = false;
        e.preventDefault();
    }
});

window.addEventListener('mouseup', (e) => {
    if (isPanning) {
        isPanning = false;
    }
});

window.addEventListener('blur', () => {
    if (isPanning) {
        isPanning = false;
        mouseDragged = false;
    }
});

canvas.addEventListener('mouseleave', () => {
    if (isPanning) {
        isPanning = false;
        mouseDragged = false;
    }
});

canvas.addEventListener('mouseup', (e) => {
    if (e.button === 0 && isPanning) {
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        isPanning = false;
        
        if (!mouseDragged) {
            const cellX = Math.floor(mouseWorldX / CELL_SIZE);
            const cellY = Math.floor(mouseWorldY / CELL_SIZE);
            
            if (isDebugMode && !hasSpawned) {
                console.log('Emitting debugSpawn at', cellX, cellY);
                socket.emit('debugSpawn', { x: cellX, y: cellY });
                return;
            }
            
            if (isDebugMode && isDead) {
                console.log('Emitting debugSpawn at', cellX, cellY);
                socket.emit('debugSpawn', { x: cellX, y: cellY });
                return;
            }

            if (!isDead) {
                const now = Date.now();
                const cellKey = `${cellX},${cellY}`;
                
                if (now - lastClickTime < 300 && lastClickCell === cellKey) {
                    console.log('Double clicking cell:', cellX, cellY);
                    socket.emit('chord', { x: cellX, y: cellY });
                    lastClickTime = 0;
                    lastClickCell = null;
                } else {
                    console.log('Clicking cell:', cellX, cellY);
                    socket.emit('move', { x: cellX, y: cellY });
                    lastClickTime = now;
                    lastClickCell = cellKey;
                }
            }
        }
    } else if (e.button === 1) {
        if (!mouseDragged && !isDead) {
            const cellX = Math.floor(mouseWorldX / CELL_SIZE);
            const cellY = Math.floor(mouseWorldY / CELL_SIZE);
            console.log('Middle clicking cell (chord):', cellX, cellY);
            socket.emit('chord', { x: cellX, y: cellY });
        }
        isPanning = false;
        e.preventDefault();
    }
});

canvas.addEventListener('click', (e) => {
    e.preventDefault();
});

canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (isDead) return;
    if (isDebugMode && !hasSpawned) return;
    
    const cellX = Math.floor(mouseWorldX / CELL_SIZE);
    const cellY = Math.floor(mouseWorldY / CELL_SIZE);
    
    socket.emit('flag', { x: cellX, y: cellY });
    return false;
});

let lastChunkRequest = Date.now();
let lastCleanup = Date.now();

setInterval(() => {
    const cameraMoved = Math.abs(cameraX - lastCameraX) > CELL_SIZE * 2 || 
                       Math.abs(cameraY - lastCameraY) > CELL_SIZE * 2 ||
                       Math.abs(zoom - lastZoom) > 0.1;
    
    if (cameraMoved || Date.now() - lastChunkRequest > 2000) {
        requestVisibleChunks();
        lastChunkRequest = Date.now();
        lastCameraX = cameraX;
        lastCameraY = cameraY;
        lastZoom = zoom;
    }
    
    if (Date.now() - lastCleanup > 5000) {
        cleanupDistantChunks();
        lastCleanup = Date.now();
    }
}, 200);

let touches = [];
let lastTouchDistance = 0;
let touchStartTime = 0;
let touchMoved = false;
let longPressTimer = null;
let lastTouchCenterX = 0;
let lastTouchCenterY = 0;
let lastTapTime = 0;
let lastTapCell = null;
let lastClickTime = 0;
let lastClickCell = null;
let lastDeathScore = null;

canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    touches = Array.from(e.touches);
    touchMoved = false;
    
    if (touches.length === 2) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        lastTouchDistance = Math.sqrt(dx * dx + dy * dy);
        
        const rect = canvas.getBoundingClientRect();
        lastTouchCenterX = (touches[0].clientX + touches[1].clientX) / 2 - rect.left;
        lastTouchCenterY = (touches[0].clientY + touches[1].clientY) / 2 - rect.top;
        
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    } else if (touches.length === 1) {
        const rect = canvas.getBoundingClientRect();
        isPanning = true;
        panStartX = touches[0].clientX - rect.left;
        panStartY = touches[0].clientY - rect.top;
        touchStartTime = Date.now();
        
        const worldX = (panStartX - canvas.width / 2) / zoom + cameraX;
        const worldY = (panStartY - canvas.height / 2) / zoom + cameraY;
        const cellX = Math.floor(worldX / CELL_SIZE);
        const cellY = Math.floor(worldY / CELL_SIZE);
        
        longPressTimer = setTimeout(() => {
            if (!touchMoved && !isDead) {
                socket.emit('flag', { x: cellX, y: cellY });
                longPressTimer = null;
                navigator.vibrate && navigator.vibrate(50);
            }
        }, 500);
    }
});

canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    touches = Array.from(e.touches);
    const rect = canvas.getBoundingClientRect();
    
    if (touches.length === 2) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        const centerX = (touches[0].clientX + touches[1].clientX) / 2 - rect.left;
        const centerY = (touches[0].clientY + touches[1].clientY) / 2 - rect.top;
        
        if (lastTouchDistance > 0) {
            const worldXBefore = (centerX - canvas.width / 2) / zoom + cameraX;
            const worldYBefore = (centerY - canvas.height / 2) / zoom + cameraY;
            
            const zoomFactor = distance / lastTouchDistance;
            zoom = Math.max(0.5, Math.min(3, zoom * zoomFactor));
            
            const worldXAfter = (centerX - canvas.width / 2) / zoom + cameraX;
            const worldYAfter = (centerY - canvas.height / 2) / zoom + cameraY;
            
            cameraX += worldXBefore - worldXAfter;
            cameraY += worldYBefore - worldYAfter;
            
            const deltaX = centerX - lastTouchCenterX;
            const deltaY = centerY - lastTouchCenterY;
            cameraX -= deltaX / zoom;
            cameraY -= deltaY / zoom;
        }
        
        lastTouchDistance = distance;
        lastTouchCenterX = centerX;
        lastTouchCenterY = centerY;
        touchMoved = true;
        
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    } else if (touches.length === 1 && isPanning) {
        const mouseX = touches[0].clientX - rect.left;
        const mouseY = touches[0].clientY - rect.top;
        const deltaX = mouseX - panStartX;
        const deltaY = mouseY - panStartY;
        
        if (Math.abs(deltaX) > 12 || Math.abs(deltaY) > 12) {
            touchMoved = true;
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        }
        
        cameraX -= deltaX / zoom;
        cameraY -= deltaY / zoom;
        panStartX = mouseX;
        panStartY = mouseY;
    }
});

canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
    }
    
    if (touches.length === 1 && !touchMoved && !isDead) {
        const elapsed = Date.now() - touchStartTime;
        if (elapsed < 500) {
            const rect = canvas.getBoundingClientRect();
            const worldX = (panStartX - canvas.width / 2) / zoom + cameraX;
            const worldY = (panStartY - canvas.height / 2) / zoom + cameraY;
            const cellX = Math.floor(worldX / CELL_SIZE);
            const cellY = Math.floor(worldY / CELL_SIZE);
            
            if (isDebugMode && !hasSpawned) {
                socket.emit('debugSpawn', { x: cellX, y: cellY });
                return;
            }

            const now = Date.now();
            const cellKey = `${cellX},${cellY}`;
            
            if (now - lastTapTime < 300 && lastTapCell === cellKey) {
                console.log('Double tapping cell:', cellX, cellY);
                socket.emit('chord', { x: cellX, y: cellY });
                lastTapTime = 0;
                lastTapCell = null;
            } else {
                console.log('Tapping cell:', cellX, cellY);
                socket.emit('move', { x: cellX, y: cellY });
                lastTapTime = now;
                lastTapCell = cellKey;
            }
        }
    }
    
    touches = Array.from(e.touches);
    
    if (touches.length < 2) {
        lastTouchDistance = 0;
    }
    
    if (touches.length === 0) {
        isPanning = false;
        touchMoved = false;
    } else if (touches.length === 1) {
        const rect = canvas.getBoundingClientRect();
        panStartX = touches[0].clientX - rect.left;
        panStartY = touches[0].clientY - rect.top;
    }
});

canvas.addEventListener('touchcancel', (e) => {
    e.preventDefault();
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
    }
    touches = [];
    lastTouchDistance = 0;
    isPanning = false;
    touchMoved = false;
});

gameLoop();
