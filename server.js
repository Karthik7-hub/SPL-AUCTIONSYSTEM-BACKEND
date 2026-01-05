require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

// Import Models
const Auction = require('./models/Auction');
const Team = require('./models/Team');
const Player = require('./models/Player');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.status(200).send("Server is alive 🚀");
});

// --- MULTI-AUCTION STATE MANAGEMENT ---
const auctionRooms = new Map();

const getRoomState = (auctionId) => {
    if (!auctionRooms.has(auctionId)) {
        auctionRooms.set(auctionId, {
            currentBid: 0,
            leadingTeamId: null,
            currentPlayerId: null,
            status: 'IDLE',
            bidHistory: []
        });
    }
    return auctionRooms.get(auctionId);
};

// --- DATABASE ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Scalable DB Connected"))
    .catch(err => console.error("❌ DB Error:", err));

// --- API ROUTES ---

// 1. Create Auction
app.post('/api/create-auction', async (req, res) => {
    try {
        const auction = new Auction(req.body);
        await auction.save();
        res.json(auction);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auctions', async (req, res) => {
    try {
        const auctions = await Auction.find().sort({ date: -1 });
        res.json(auctions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Init Specific Auction Data
app.get('/api/init/:auctionId', async (req, res) => {
    try {
        const { auctionId } = req.params;
        const auction = await Auction.findById(auctionId); // Fetch Auction Config
        const teams = await Team.find({ auctionId }).populate('players').lean();
        const players = await Player.find({ auctionId }).sort('order').lean();
        const liveState = getRoomState(auctionId);

        // Send config back to client
        res.json({
            teams,
            players,
            liveState,
            config: { categories: auction.categories, roles: auction.roles }
        });
    } catch (err) {
        res.status(500).json({ error: "Failed to load data" });
    }
});

// 4. Verify Admin Password
app.post('/api/verify-admin', async (req, res) => {
    try {
        const { auctionId, password } = req.body;
        const auction = await Auction.findById(auctionId);
        if (!auction) return res.status(404).json({ success: false });

        if (auction.accessCode === password) return res.json({ success: true });
        else return res.status(401).json({ success: false });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. Add/Delete Logic (Scoped to AuctionId)
app.post('/api/teams', async (req, res) => {
    const team = new Team(req.body);
    await team.save();
    io.to(req.body.auctionId).emit('data_update');
    res.json(team);
});

app.post('/api/players', async (req, res) => {
    const count = await Player.countDocuments({ auctionId: req.body.auctionId });
    const player = new Player({ ...req.body, order: count });
    await player.save();
    io.to(req.body.auctionId).emit('data_update');
    res.json(player);
});

app.delete('/api/teams/:id', async (req, res) => {
    const team = await Team.findById(req.params.id);
    if (team) {
        const auctionId = team.auctionId.toString();
        await Team.findByIdAndDelete(req.params.id);
        await Player.updateMany({ soldTo: req.params.id }, { isSold: false, soldTo: null, soldPrice: 0 });
        io.to(auctionId).emit('data_update');
    }
    res.json({ message: "Deleted" });
});

app.delete('/api/players/:id', async (req, res) => {
    const player = await Player.findById(req.params.id);
    if (player) {
        const auctionId = player.auctionId.toString();
        if (player.isSold && player.soldTo) {
            await Team.findByIdAndUpdate(player.soldTo, { $pull: { players: player._id }, $inc: { spent: -player.soldPrice } });
        }
        await Player.findByIdAndDelete(req.params.id);
        io.to(auctionId).emit('data_update');
    }
    res.json({ message: "Deleted" });
});

// --- SUPER ADMIN ROUTES ---

// 1. Verify Master Password
// server.js

// server.js

app.post('/api/super-admin/login', (req, res) => {
    // Now it checks the hidden .env file
    if (req.body.password === process.env.SUPER_ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false });
    }
});

// 2. Delete Entire Auction (Cascade Delete)
app.delete('/api/auctions/:id', async (req, res) => {
    try {
        const auctionId = req.params.id;

        // 1. Delete Auction
        await Auction.findByIdAndDelete(auctionId);

        // 2. Delete All Linked Teams
        await Team.deleteMany({ auctionId });

        // 3. Delete All Linked Players
        await Player.deleteMany({ auctionId });

        res.json({ success: true, message: "Auction and all data deleted" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/auctions/:id', async (req, res) => {
    try {
        const updates = req.body;
        const updatedAuction = await Auction.findByIdAndUpdate(
            req.params.id,
            updates,
            { new: true } // Return the updated document
        );

        res.json({ success: true, auction: updatedAuction });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// --- SOCKET.IO ---
const io = new Server(server, { cors: { origin: "*" }, transports: ['websocket', 'polling'] });

io.on('connection', (socket) => {

    socket.on('join_auction', (auctionId) => {
        socket.join(auctionId);
        socket.emit('auction_state', getRoomState(auctionId));
    });

    socket.on('start_player', ({ auctionId, playerId, basePrice }) => {
        const state = getRoomState(auctionId);
        state.currentBid = basePrice;
        state.leadingTeamId = null;
        state.currentPlayerId = playerId;
        state.status = 'ACTIVE';
        state.bidHistory = []; // Reset history
        io.to(auctionId).emit('auction_state', state);
    });

    socket.on('place_bid', ({ auctionId, teamId, amount }) => {
        const state = getRoomState(auctionId);

        if (state.leadingTeamId === null) {
            if (amount < state.currentBid) return;
        } else {
            if (amount <= state.currentBid) return;
        }

        // Save History
        state.bidHistory.push({ bid: state.currentBid, leader: state.leadingTeamId });

        state.currentBid = amount;
        state.leadingTeamId = teamId;
        io.to(auctionId).emit('auction_state', state);
    });

    socket.on('undo_bid', ({ auctionId }) => {
        const state = getRoomState(auctionId);
        if (state.bidHistory.length > 0) {
            const prev = state.bidHistory.pop();
            state.currentBid = prev.bid;
            state.leadingTeamId = prev.leader;
            io.to(auctionId).emit('auction_state', state);
        }
    });

    socket.on('toggle_pause', ({ auctionId }) => {
        const state = getRoomState(auctionId);
        state.status = state.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED';
        io.to(auctionId).emit('auction_state', state);
    });

    socket.on('sell_player', async ({ auctionId }) => {
        const state = getRoomState(auctionId);
        const { currentPlayerId, leadingTeamId, currentBid } = state;

        if (currentPlayerId && leadingTeamId) {
            state.status = 'SOLD';
            state.bidHistory = [];
            io.to(auctionId).emit('auction_state', state);

            try {
                await Promise.all([
                    Player.findByIdAndUpdate(currentPlayerId, { isSold: true, soldTo: leadingTeamId, soldPrice: currentBid }),
                    Team.findByIdAndUpdate(leadingTeamId, { $inc: { spent: currentBid }, $push: { players: currentPlayerId } })
                ]);
                io.to(auctionId).emit('data_update');
            } catch (err) { console.error(err); }
        }
    });

    socket.on('unsell_player', async ({ auctionId }) => {
        const state = getRoomState(auctionId);
        if (state.currentPlayerId) {
            state.status = 'UNSOLD';
            io.to(auctionId).emit('auction_state', state);
            await Player.findByIdAndUpdate(state.currentPlayerId, { isSold: false, isUnsold: true });
            io.to(auctionId).emit('data_update');
        }
    });

    socket.on('reset_round', ({ auctionId }) => {
        const state = getRoomState(auctionId);
        state.currentBid = 0;
        state.leadingTeamId = null;
        state.currentPlayerId = null;
        state.status = 'IDLE';
        io.to(auctionId).emit('auction_state', state);
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Scalable Server running on port ${PORT}`));