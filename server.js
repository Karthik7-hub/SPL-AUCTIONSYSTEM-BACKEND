require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const compression = require('compression'); // Speed: Gzip
const helmet = require('helmet'); // Security: Headers
const morgan = require('morgan'); // Debugging: Logger
const { Server } = require('socket.io');

// Import Models
const Auction = require('./models/Auction');
const Team = require('./models/Team');
const Player = require('./models/Player');

const app = express();
const server = http.createServer(app);

// --- MIDDLEWARE ---
app.use(helmet()); // Secure HTTP headers
app.use(compression()); // Compress all responses
app.use(morgan('tiny')); // Log requests to console
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.status(200).send("Server is alive and optimized 🚀");
});

// --- IN-MEMORY STATE MANAGEMENT ---
const auctionRooms = new Map();

const getRoomState = (auctionId) => {
    const id = String(auctionId);
    if (!auctionRooms.has(id)) {
        auctionRooms.set(id, {
            currentBid: 0,
            leadingTeamId: null,
            currentPlayerId: null,
            status: 'IDLE',
            bidHistory: []
        });
    }
    return auctionRooms.get(id);
};

// --- DATABASE CONNECTION ---
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

// 2. Get All Auctions (Optimized)
app.get('/api/auctions', async (req, res) => {
    try {
        const auctions = await Auction.find()
            .sort({ date: -1 })
            .select('name date accessCode isActive categories roles') // Fetch only needed fields
            .lean(); // Return plain JS objects (Faster)
        res.json(auctions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Update Auction (For Editing/Status Toggle)
app.put('/api/auctions/:id', async (req, res) => {
    try {
        const updated = await Auction.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, auction: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Init Specific Auction Data (High Performance Parallel Load)
app.get('/api/init/:auctionId', async (req, res) => {
    try {
        const { auctionId } = req.params;

        // Run these 3 queries at the same time instead of one-by-one
        const [auction, teams, players] = await Promise.all([
            Auction.findById(auctionId).select('categories roles').lean(),
            Team.find({ auctionId }).populate('players').lean(),
            Player.find({ auctionId }).sort('order').lean()
        ]);

        if (!auction) return res.status(404).json({ error: "Auction not found" });

        res.json({
            teams,
            players,
            liveState: getRoomState(auctionId),
            config: { categories: auction.categories, roles: auction.roles }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to load data" });
    }
});

// 5. Host Login
app.post('/api/verify-admin', async (req, res) => {
    try {
        const { auctionId, password } = req.body;
        const auction = await Auction.findById(auctionId).select('accessCode').lean();

        if (!auction) return res.status(404).json({ success: false });
        if (auction.accessCode === password) return res.json({ success: true });
        else return res.status(401).json({ success: false });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. Super Admin Login
app.post('/api/super-admin/login', (req, res) => {
    if (req.body.password === process.env.SUPER_ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false });
    }
});

// 7. Add/Delete Items
app.post('/api/teams', async (req, res) => {
    try {
        const team = new Team(req.body);
        await team.save();
        io.to(req.body.auctionId).emit('data_update');
        res.json(team);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/players', async (req, res) => {
    try {
        const count = await Player.countDocuments({ auctionId: req.body.auctionId });
        const player = new Player({ ...req.body, order: count });
        await player.save();
        io.to(req.body.auctionId).emit('data_update');
        res.json(player);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/teams/:id', async (req, res) => {
    try {
        const team = await Team.findById(req.params.id);
        if (team) {
            const auctionId = team.auctionId.toString();
            await Team.findByIdAndDelete(req.params.id);
            // Reset players owned by this team
            await Player.updateMany({ soldTo: req.params.id }, { isSold: false, soldTo: null, soldPrice: 0 });
            io.to(auctionId).emit('data_update');
        }
        res.json({ message: "Deleted" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/players/:id', async (req, res) => {
    try {
        const player = await Player.findById(req.params.id);
        if (player) {
            const auctionId = player.auctionId.toString();
            if (player.isSold && player.soldTo) {
                // Refund team money
                await Team.findByIdAndUpdate(player.soldTo, { $pull: { players: player._id }, $inc: { spent: -player.soldPrice } });
            }
            await Player.findByIdAndDelete(req.params.id);
            io.to(auctionId).emit('data_update');
        }
        res.json({ message: "Deleted" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. Delete Entire Auction (Cascade & Memory Cleanup)
app.delete('/api/auctions/:id', async (req, res) => {
    try {
        const auctionId = req.params.id;
        await Auction.findByIdAndDelete(auctionId);
        await Team.deleteMany({ auctionId });
        await Player.deleteMany({ auctionId });

        // Clean up memory
        if (auctionRooms.has(auctionId)) {
            auctionRooms.delete(auctionId);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- SOCKET.IO LOGIC ---
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
        state.bidHistory = [];
        io.to(auctionId).emit('auction_state', state);
    });

    socket.on('place_bid', ({ auctionId, teamId, amount }) => {
        if (!auctionId || !teamId || typeof amount !== 'number') return;

        const state = getRoomState(auctionId);

        // Prevent lower bids
        if (state.leadingTeamId === null) {
            if (amount < state.currentBid) return;
        } else {
            if (amount <= state.currentBid) return;
        }

        // Save history for Undo
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
                // Update DB in parallel
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
            try {
                await Player.findByIdAndUpdate(state.currentPlayerId, { isSold: false, isUnsold: true });
                io.to(auctionId).emit('data_update');
            } catch (err) { console.error(err); }
        }
    });

    socket.on('reset_round', ({ auctionId }) => {
        const state = getRoomState(auctionId);
        Object.assign(state, { currentBid: 0, leadingTeamId: null, currentPlayerId: null, status: 'IDLE', bidHistory: [] });
        io.to(auctionId).emit('auction_state', state);
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Scalable Server running on port ${PORT}`));