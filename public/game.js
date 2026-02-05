const socket = io();

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
let dragThreshold = 5;
let zoom = 1.0;
let deadPlayerCells = new Map();

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
    
    cameraX = player.x * CELL_SIZE;
    cameraY = player.y * CELL_SIZE;
    
    for (const p of data.activePlayers) {
        players.set(p.id, p);
    }
    
    updateUI();
    requestVisibleChunks();
});

socket.on('playerJoined', (playerData) => {
    players.set(playerData.id, playerData);
    updateUI();
});

socket.on('playerLeft', (id) => {
    players.delete(id);
    updateUI();
});

socket.on('cellsCleared', (data) => {
    console.log('Cells cleared, refreshing chunks');
    if (data.cells && data.cells.length > 0) {
        invalidateChunksForCells(data.cells);
        requestVisibleChunks();
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
            } else if (data.type === 'noMoves') {
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
        }
        
        if (data.uncoveredCells && data.uncoveredCells.length > 0) {
            invalidateChunksForCells(data.uncoveredCells);
            requestVisibleChunks();
        }
        
    } else if (data.type === 'flag') {
        if (data.x !== undefined && data.y !== undefined) {
            invalidateChunksForCell(data.x, data.y);
            requestVisibleChunks();
        }
        
    } else if (data.type === 'respawn') {
        if (data.playerId === playerId) {
            player.x = data.x;
            player.y = data.y;
            player.alive = true;
            isDead = false;
            deathTime = null;
            
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
            invalidateChunksForCells(data.uncoveredCells);
            requestVisibleChunks();
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
                invalidateChunksForCells(update.uncoveredCells);
            }
        }
        requestVisibleChunks();
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
});

socket.on('recoveryComplete', (data) => {
    if (data.playerId === playerId) {
        document.getElementById('deathReason').textContent = 'You hit a mine!';
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
});

socket.on('chunks', (chunksData) => {
    console.log('Received chunks:', chunksData.length);
    for (const newChunk of chunksData) {
        const key = `${newChunk.x},${newChunk.y}`;
        const existingChunk = chunks.get(key);
        
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
                        }
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    existingChunk.cells.push(newCell);
                }
            }
        } else {
            chunks.set(key, newChunk);
        }
    }
    updatePlayerCells();
    render();
});

socket.on('error', (error) => {
    console.error('Game error:', error);
});

function handleDeath(reason) {
    isDead = true;
    deathTime = Date.now();
    
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

function invalidateChunksForCells(cells) {
    const chunksToInvalidate = new Set();
    for (const cell of cells) {
        const chunkX = Math.floor(cell.x / CHUNK_SIZE);
        const chunkY = Math.floor(cell.y / CHUNK_SIZE);
        chunksToInvalidate.add(`${chunkX},${chunkY}`);
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

function requestVisibleChunks() {
    const chunkKeys = [];
    
    const buffer = zoom < 0.75 ? 1 : 2;
    const startChunkX = Math.floor((cameraX - canvas.width / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) - buffer;
    const endChunkX = Math.floor((cameraX + canvas.width / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) + buffer;
    const startChunkY = Math.floor((cameraY - canvas.height / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) - buffer;
    const endChunkY = Math.floor((cameraY + canvas.height / (2 * zoom)) / (CHUNK_SIZE * CELL_SIZE)) + buffer;
    
    const maxChunks = 100;
    
    for (let cx = startChunkX; cx <= endChunkX && chunkKeys.length < maxChunks; cx++) {
        for (let cy = startChunkY; cy <= endChunkY && chunkKeys.length < maxChunks; cy++) {
            const key = `${cx},${cy}`;
            if (!chunks.has(key)) {
                chunkKeys.push(key);
            }
        }
    }
    
    if (chunkKeys.length > 0) {
        socket.emit('requestChunks', { chunkKeys });
    }
}

function updateUI() {
    document.getElementById('score').textContent = `Score: ${player ? player.score : 0}`;
    document.getElementById('playerCount').textContent = `Players: ${players.size}`;
}

function updatePlayerCells() {
    playerCells.clear();
    clickableCells.clear();
    
    for (const chunk of chunks.values()) {
        for (const cell of chunk.cells) {
            if (cell.owner === playerId && cell.state === 'uncovered') {
                const cellKey = `${cell.x},${cell.y}`;
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
    ctx.fillStyle = 'rgb(192, 192, 192)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const scaledCellSize = CELL_SIZE * zoom;
    const offsetX = canvas.width / 2 - cameraX * zoom;
    const offsetY = canvas.height / 2 - cameraY * zoom;
    
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
            
            if (cell.state === 'uncovered') {
                ctx.fillStyle = 'rgb(192, 192, 192)';
                ctx.fillRect(screenX, screenY, scaledCellSize, scaledCellSize);
                
                if (!simplifiedRendering) {
                    ctx.strokeStyle = 'rgb(128, 128, 128)';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(screenX, screenY + scaledCellSize - 0.5);
                    ctx.lineTo(screenX, screenY);
                    ctx.lineTo(screenX + scaledCellSize - 0.5, screenY);
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
                    ctx.fillStyle = numberColors[cell.adjacentMines];
                    ctx.font = `bold ${16 * zoom}px "MS Sans Serif", "Microsoft Sans Serif", sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(cell.adjacentMines, screenX + scaledCellSize / 2, screenY + scaledCellSize / 2);
                }
            } else {
                const canClick = isAdjacentToPlayerCell(cell.x, cell.y) && !isDead;
                
                if (canClick) {
                    ctx.fillStyle = 'rgb(192, 192, 192)';
                } else {
                    ctx.fillStyle = 'rgb(128, 128, 128)';
                }
                ctx.fillRect(screenX, screenY, scaledCellSize, scaledCellSize);
                
                if (!simplifiedRendering) {
                    if (canClick) {
                        ctx.strokeStyle = 'rgb(255, 255, 255)';
                    } else {
                        ctx.strokeStyle = 'rgb(160, 160, 160)';
                    }
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(screenX + 1, screenY + scaledCellSize - 1);
                    ctx.lineTo(screenX + 1, screenY + 1);
                    ctx.lineTo(screenX + scaledCellSize - 1, screenY + 1);
                    ctx.stroke();
                    
                    if (canClick) {
                        ctx.strokeStyle = 'rgb(128, 128, 128)';
                    } else {
                        ctx.strokeStyle = 'rgb(80, 80, 80)';
                    }
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(screenX + scaledCellSize - 1, screenY + 1);
                    ctx.lineTo(screenX + scaledCellSize - 1, screenY + scaledCellSize - 1);
                    ctx.lineTo(screenX + 1, screenY + scaledCellSize - 1);
                    ctx.stroke();
                    
                    if (cell.flag) {
                        ctx.fillStyle = 'rgb(0, 0, 0)';
                        ctx.fillRect(screenX + scaledCellSize / 2 - 0.5 * zoom, screenY + 8 * zoom, 1 * zoom, 12 * zoom);
                        
                        ctx.fillStyle = 'rgb(255, 0, 0)';
                        ctx.beginPath();
                        ctx.moveTo(screenX + scaledCellSize / 2 + 1 * zoom, screenY + 8 * zoom);
                        ctx.lineTo(screenX + scaledCellSize / 2 + 1 * zoom, screenY + 14 * zoom);
                        ctx.lineTo(screenX + scaledCellSize / 2 + 8 * zoom, screenY + 11 * zoom);
                        ctx.closePath();
                        ctx.fill();
                    }
                } else if (cell.flag) {
                    ctx.fillStyle = 'rgb(255, 0, 0)';
                    ctx.fillRect(screenX + 1, screenY + 1, scaledCellSize - 2, scaledCellSize - 2);
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
        ctx.lineWidth = 2;
        ctx.strokeRect(hoverScreenX + 1, hoverScreenY + 1, scaledCellSize - 2, scaledCellSize - 2);
    }
}

let keys = {};
window.addEventListener('keydown', (e) => {
    keys[e.key.toLowerCase()] = true;
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
        e.preventDefault();
    }
});

canvas.addEventListener('mouseup', (e) => {
    if (e.button === 0 && isPanning) {
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const dragDistance = Math.sqrt(
            Math.pow(mouseX - panStartX, 2) + Math.pow(mouseY - panStartY, 2)
        );
        
        isPanning = false;
        
        if (dragDistance < dragThreshold && !isDead) {
            const cellX = Math.floor(mouseWorldX / CELL_SIZE);
            const cellY = Math.floor(mouseWorldY / CELL_SIZE);
            
            console.log('Clicking cell:', cellX, cellY);
            socket.emit('move', { x: cellX, y: cellY });
        }
    } else if (e.button === 1) {
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
    
    const cellX = Math.floor(mouseWorldX / CELL_SIZE);
    const cellY = Math.floor(mouseWorldY / CELL_SIZE);
    
    socket.emit('flag', { x: cellX, y: cellY });
    return false;
});

let lastChunkRequest = Date.now();
setInterval(() => {
    if (Date.now() - lastChunkRequest > 500) {
        requestVisibleChunks();
        lastChunkRequest = Date.now();
    }
}, 500);

gameLoop();
