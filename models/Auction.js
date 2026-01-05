const mongoose = require('mongoose');

const AuctionSchema = new mongoose.Schema({
    name: { type: String, required: true },
    date: { type: Date, default: Date.now },
    accessCode: { type: String, required: true },
    isActive: { type: Boolean, default: true },

    // NEW FIELDS (With defaults for safety)
    categories: {
        type: [String],
        default: ['Marquee', 'Set 1', 'Set 2', 'Set 3', 'Set 4']
    },
    roles: {
        type: [String],
        default: ['Batsman', 'Bowler', 'All Rounder', 'Wicket Keeper']
    }
});

AuctionSchema.index({ date: -1 });

module.exports = mongoose.model('Auction', AuctionSchema);