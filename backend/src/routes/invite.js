const express = require('express');
const router = express.Router();
const emailService = require('../services/email');
const logger = require('../utils/logger');
const authMiddleware = require('../middleware/authMiddleware');
const dbService = require('../services/db');
const { admin, firebaseInitialized } = require('../firebase');
const crypto = require('crypto');

/**
 * Generate a random password (12 chars, alphanumeric + symbols)
 */
function generatePassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
    let password = '';
    const bytes = crypto.randomBytes(12);
    for (let i = 0; i < 12; i++) {
        password += chars[bytes[i] % chars.length];
    }
    return password;
}

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

        // Create Firebase Auth account for the invited member
        let memberUid = null;
        let tempPassword = null;

        if (firebaseInitialized) {
            tempPassword = generatePassword();
            try {
                // Check if user already exists
                let existingUser = null;
                try {
                    existingUser = await admin.auth().getUserByEmail(email);
                } catch (e) {
                    // User does not exist - this is expected for new invites
                }

                if (existingUser) {
                    memberUid = existingUser.uid;
                    logger.info(`Invited user ${email} already has Firebase account: ${memberUid}`);
                    // Reset password for existing user so they can log in with new temp password
                    await admin.auth().updateUser(memberUid, { password: tempPassword });
                } else {
                    const userRecord = await admin.auth().createUser({
                        email: email,
                        password: tempPassword,
                        displayName: name
                    });
                    memberUid = userRecord.uid;
                    logger.info(`Created Firebase Auth account for ${email}: ${memberUid}`);
                }
            } catch (authError) {
                logger.error(`Failed to create Firebase Auth account for ${email}: ${authError.message}`);
                return res.status(500).json({ error: 'Failed to create member account' });
            }
        } else {
            logger.warn('Firebase not initialized - cannot create auth account for invited member');
            return res.status(500).json({ error: 'Firebase not available for account creation' });
        }

        // Save team member record (with memberUid)
        await dbService.addTeamMember(req.user.uid, { email, name, role, memberUid });

        // Try to send invitation email with login credentials
        let emailSent = false;
        const hasEmailConfig = process.env.SENDGRID_API_KEY && process.env.SENDGRID_API_KEY.startsWith('SG.');

        if (hasEmailConfig) {
            try {
                await emailService.sendInviteEmail(email, name, role, inviterName || '管理者', tempPassword);
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
                : 'Member registered (email skipped)',
            emailSent: emailSent,
            tempPassword: emailSent ? undefined : tempPassword // Only return password if email wasn't sent
        });
    } catch (error) {
        logger.error('Failed to process invitation:', error);
        res.status(500).json({ error: 'Failed to process invitation' });
    }
});

module.exports = router;
