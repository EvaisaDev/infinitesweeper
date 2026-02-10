class Player {
    constructor(id, x, y, color) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.color = color;
        this.score = 0;
        this.alive = true;
    }
    
    addScore(points) {
        this.score += points;
    }
    
    die() {
        this.alive = false;
    }
    
    respawn(x, y) {
        this.x = x;
        this.y = y;
        this.alive = true;
    }
    
    toJSON() {
        return {
            id: this.id,
            x: this.x,
            y: this.y,
            color: this.color,
            score: this.score,
            alive: this.alive
        };
    }
}

module.exports = Player;
