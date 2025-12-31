const mongoose = require('mongoose');

const TeamSchema = new mongoose.Schema({
    name: { type: String, required: true },
    budget: { type: Number, required: true },
    spent: { type: Number, default: 0 },
    color: { type: String, default: '#000000' },
    players: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }]
});

module.exports = mongoose.model('Team', TeamSchema);