const mongoose = require('mongoose');

const TeamSchema = new mongoose.Schema({
    auctionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Auction', required: true },
    name: String,
    budget: Number,
    spent: { type: Number, default: 0 },
    color: String,
    players: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }]
});

TeamSchema.index({ auctionId: 1 });

module.exports = mongoose.model('Team', TeamSchema);