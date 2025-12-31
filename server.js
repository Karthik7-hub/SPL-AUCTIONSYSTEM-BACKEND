require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const Team = require('./models/Team');
const Player = require('./models/Player');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// --- SOCKET.IO SETUP (For Live Auction) ---
const io = new Server(server, {
    cors: {
        origin: "*", // Allow React Frontend to connect
        methods: ["GET", "POST"]
    }
});
// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ DB Error:", err));

// --- REAL-TIME STATE ---
let auctionState = {
    currentBid: 0,
    leadingTeamId: null,
    currentPlayerId: null,
    status: 'IDLE' // IDLE, ACTIVE, SOLD, UNSOLD
};

// --- API ROUTES ---

// Initialize Data
app.get('/api/init', async (req, res) => {
    try {
        const teams = await Team.find().populate('players');
        const players = await Player.find().sort('order');
        res.json({ teams, players });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add Team
app.post('/api/teams', async (req, res) => {
    const team = new Team(req.body);
    await team.save();
    io.emit('data_update');
    res.json(team);
});

// Add Player
app.post('/api/players', async (req, res) => {
    const count = await Player.countDocuments();
    const player = new Player({ ...req.body, order: count });
    await player.save();
    io.emit('data_update');
    res.json(player);
});
// --- ADD THESE NEW DELETE ROUTES ---

// Delete a specific team
app.delete('/api/teams/:id', async (req, res) => {
    await Team.findByIdAndDelete(req.params.id);
    // Optional: If you want to reset players bought by this team
    await Player.updateMany({ soldTo: req.params.id }, { isSold: false, soldTo: null, soldPrice: 0 });
    io.emit('data_update');
    res.json({ message: "Team deleted" });
});

// DELETE PLAYER ROUTE
app.delete('/api/players/:id', async (req, res) => {
    try {
        const player = await Player.findById(req.params.id);

        if (!player) return res.status(404).json({ message: "Player not found" });

        // 1. If player was sold, remove them from the Team & Refund Budget
        if (player.isSold && player.soldTo) {
            const team = await Team.findById(player.soldTo);
            if (team) {
                team.players = team.players.filter(pId => pId.toString() !== player._id.toString()); // Remove ID
                team.spent -= player.soldPrice; // Refund money
                await team.save();
            }
        }

        // 2. Now delete the player
        await Player.findByIdAndDelete(req.params.id);

        res.json({ message: "Player deleted and team updated" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});
// ... keep existing socket.io logic ...

// --- SOCKET.IO HANDLERS ---
io.on('connection', (socket) => {
    socket.emit('auction_state', auctionState);
    // ... inside io.on('connection') ...

    socket.on('start_player', async ({ playerId, basePrice }) => {
        auctionState = {
            currentBid: basePrice, // FORCE the bid to start at Base Price
            leadingTeamId: null,
            currentPlayerId: playerId,
            status: 'ACTIVE'
        };
        io.emit('auction_state', auctionState);
    });

    // ... keep other handlers ...
    socket.on('place_bid', ({ teamId, amount }) => {
        auctionState.currentBid = amount;
        auctionState.leadingTeamId = teamId;
        io.emit('auction_state', auctionState);
    });

    // --- UPDATED SOLD LOGIC ---
    socket.on('sell_player', async () => {
        const { currentPlayerId, leadingTeamId, currentBid } = auctionState;
        if (currentPlayerId && leadingTeamId) {
            await Player.findByIdAndUpdate(currentPlayerId, {
                isSold: true,
                isUnsold: false, // Ensure it's not marked unsold
                soldTo: leadingTeamId,
                soldPrice: currentBid
            });

            const team = await Team.findById(leadingTeamId);
            team.spent += currentBid;
            team.players.push(currentPlayerId);
            await team.save();

            auctionState.status = 'SOLD';
            io.emit('auction_state', auctionState);
            io.emit('data_update');
        }
    });



    // --- UPDATED UNSOLD LOGIC ---
    socket.on('unsell_player', async () => {
        const { currentPlayerId } = auctionState;
        if (currentPlayerId) {
            // Mark player as Unsold in DB so they are removed from the main queue
            await Player.findByIdAndUpdate(currentPlayerId, {
                isSold: false,
                isUnsold: true
            });

            auctionState.status = 'UNSOLD';
            io.emit('auction_state', auctionState);
            io.emit('data_update');
        }
    });

    // NEW: Reset round to IDLE state (clears the screen)
    socket.on('reset_round', () => {
        auctionState = {
            currentBid: 0,
            leadingTeamId: null,
            currentPlayerId: null,
            status: 'IDLE'
        };
        io.emit('auction_state', auctionState);
    });
});


const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));