const mongoose = require('mongoose');

const PlayerSchema = new mongoose.Schema({
    name: { type: String, required: true },
    role: { type: String, required: true },
    category: { type: String, default: 'Marquee Players' },
    basePrice: { type: Number, required: true },

    // Tracking Status
    isSold: { type: Boolean, default: false },
    isUnsold: { type: Boolean, default: false }, // <--- NEW FIELD

    soldTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
    soldPrice: { type: Number, default: 0 },
    order: { type: Number, default: 0 }
});

module.exports = mongoose.model('Player', PlayerSchema);