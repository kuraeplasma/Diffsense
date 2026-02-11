const express = require('express');
const router = express.Router();
const emailService = require('../services/email');
const logger = require('../utils/logger');
const authMiddleware = require('../middleware/authMiddleware');
const dbService = require('../services/db');

// POST /api/invite
router.post('/', authMiddleware, async (req, res) => {
    const { name, email, role, inviterName } = req.body;

    if (!name || !email || !role) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        // Enforce plan-based team limits
        const canAdd = await dbService.canAddMember(req.user.uid);
        if (!canAdd) {
            return res.status(403).json({
                error: 'Plan Limit Reached',
                message: 'Your current plan does not allow adding more members. Please upgrade your plan.'
            });
        }

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
