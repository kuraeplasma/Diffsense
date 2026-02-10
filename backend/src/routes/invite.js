const express = require('express');
const router = express.Router();
const emailService = require('../services/email');
const logger = require('../utils/logger');

// POST /api/invite
router.post('/', async (req, res) => {
    const { name, email, role, inviterName } = req.body;

    if (!name || !email || !role) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        // In a real app, you might check if the user already exists here
        // or generate a unique invite token. For now, we just send the email.

        await emailService.sendInviteEmail(email, name, role, inviterName || '管理者');

        res.status(200).json({ message: 'Invitation sent successfully' });
    } catch (error) {
        logger.error('Failed to send invitation:', error);
        res.status(500).json({ error: 'Failed to send invitation email' });
    }
});

module.exports = router;
