const express = require('express');
const router = express.Router();
const dbService = require('../services/db');
const logger = require('../utils/logger');

/**
 * GET /api/user/subscription
 * Get current user subscription status and limits
 */
router.get('/subscription', async (req, res) => {
    try {
        const uid = req.user.uid;
        const userProfile = await dbService.getUserProfile(uid);

        const plan = userProfile.plan || 'starter';
        const limit = dbService.getUsageLimit(userProfile);
        const isInTrial = dbService.isTrialActive(userProfile);

        let daysRemaining = null;
        if (isInTrial) {
            const trialStart = new Date(userProfile.trialStartedAt);
            const now = new Date();
            const elapsed = Math.floor((now - trialStart) / (1000 * 60 * 60 * 24));
            daysRemaining = Math.max(0, 7 - elapsed);
        }

        res.json({
            success: true,
            data: {
                plan: plan,
                usageCount: userProfile.usageCount || 0,
                usageLimit: limit,
                daysRemaining: daysRemaining,
                trialStartedAt: userProfile.trialStartedAt,
                isInTrial: isInTrial,
                planLimit: dbService.getOriginalPlanLimit(plan)
            }
        });
    } catch (error) {
        logger.error('Error fetching subscription status:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * POST /api/user/select-plan
 * Set user's selected plan (called after signup)
 */
router.post('/select-plan', async (req, res) => {
    try {
        const uid = req.user.uid;
        const { plan } = req.body;

        const validPlans = ['starter', 'business', 'pro'];
        if (!plan || !validPlans.includes(plan)) {
            return res.status(400).json({ success: false, error: 'Invalid plan' });
        }

        await dbService.setUserPlan(uid, plan);
        logger.info(`User ${uid} selected plan: ${plan}`);

        res.json({ success: true, data: { plan } });
    } catch (error) {
        logger.error('Error setting user plan:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
