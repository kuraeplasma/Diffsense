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

        // Try to send invitation email
        let emailSent = false;
        const hasEmailConfig = process.env.SENDGRID_API_KEY && process.env.SENDGRID_API_KEY.startsWith('SG.');

        if (hasEmailConfig) {
            try {
                await emailService.sendInviteEmail(email, name, role, inviterName || '管理者');
                emailSent = true;
            } catch (emailError) {
                logger.warn(`Email send failed (non-fatal): ${emailError.message}`);
            }
        } else {
            logger.info('SendGrid not configured - skipping email, member registered only');
        }

        res.status(200).json({
            message: emailSent
                ? 'Invitation sent successfully'
                : 'Member registered successfully (email notification skipped - SendGrid not configured)',
            emailSent: emailSent
        });
    } catch (error) {
        logger.error('Failed to process invitation:', error);
        res.status(500).json({ error: 'Failed to process invitation' });
    }
});

module.exports = router;
