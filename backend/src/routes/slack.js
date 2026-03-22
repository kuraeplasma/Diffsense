'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const dbService = require('../services/db');
const logger = require('../utils/logger');

const CLIENT_ID = process.env.SLACK_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.SLACK_REDIRECT_URI || '';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://diffsense.spacegleam.co.jp').replace(/\/$/, '');

/**
 * GET /api/slack/oauth/start  (requires auth middleware upstream)
 * Slack OAuth認証を開始する
 */
router.get('/oauth/start', async (req, res) => {
    try {
        if (!CLIENT_ID) {
            return res.status(500).json({ success: false, error: 'Slack連携が設定されていません' });
        }
        const uid = req.user.uid;
        const state = crypto.randomBytes(16).toString('hex');

        // stateをFirestoreに一時保存（10分TTL想定）
        await dbService.saveSlackOAuthState(state, uid);

        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            scope: 'incoming-webhook',
            redirect_uri: REDIRECT_URI,
            state
        });

        const oauthUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;
        // fetchリクエスト（APIコール）の場合はJSON、ブラウザ直接の場合はリダイレクト
        if (req.headers.accept && req.headers.accept.includes('application/json')) {
            return res.json({ success: true, url: oauthUrl });
        }
        res.redirect(oauthUrl);
    } catch (err) {
        logger.error('Slack OAuth start error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/slack/oauth/callback  (auth middleware不要 - Slackからのコールバック)
 * Slackからのコールバックを受取り、トークンを取得してDBに保存する
 */
router.get('/oauth/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        logger.warn(`Slack OAuth denied: ${error}`);
        return res.redirect(`${FRONTEND_URL}/dashboard.html?slack_error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
        return res.redirect(`${FRONTEND_URL}/dashboard.html?slack_error=invalid_request`);
    }

    try {
        // stateからuidを取得
        const uid = await dbService.getSlackOAuthState(state);
        if (!uid) {
            return res.redirect(`${FRONTEND_URL}/dashboard.html?slack_error=invalid_state`);
        }

        // Slackのトークンエンドポイントでcodeを交換
        const tokenRes = await axios.post('https://slack.com/api/oauth.v2.access', new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            redirect_uri: REDIRECT_URI
        }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const tokenData = tokenRes.data;
        if (!tokenData.ok) {
            logger.error('Slack token exchange failed:', tokenData.error);
            return res.redirect(`${FRONTEND_URL}/dashboard.html?slack_error=${encodeURIComponent(tokenData.error)}`);
        }

        const webhookUrl = tokenData.incoming_webhook?.url || '';
        const channelName = tokenData.incoming_webhook?.channel || '';
        const channelId = tokenData.incoming_webhook?.channel_id || '';
        const teamName = tokenData.team?.name || '';

        // 通知設定にwebhook URLを保存 + 連携情報を保存
        const currentSettings = await dbService.getNotificationSettings(uid);
        await dbService.updateNotificationSettings(uid, {
            ...currentSettings,
            slack: {
                enabled: true,
                webhookUrl,
                channelName,
                channelId,
                teamName,
                connectedAt: new Date().toISOString()
            }
        });

        // stateを削除
        await dbService.deleteSlackOAuthState(state);

        logger.info(`Slack connected for uid=${uid}, channel=${channelName}`);
        res.redirect(`${FRONTEND_URL}/dashboard.html?slack_connected=1&channel=${encodeURIComponent(channelName)}`);
    } catch (err) {
        logger.error('Slack OAuth callback error:', err.message);
        res.redirect(`${FRONTEND_URL}/dashboard.html?slack_error=${encodeURIComponent(err.message)}`);
    }
});

/**
 * DELETE /api/slack/oauth/disconnect  (requires auth)
 * Slack連携を解除する
 */
router.delete('/oauth/disconnect', async (req, res) => {
    try {
        const uid = req.user.uid;
        const currentSettings = await dbService.getNotificationSettings(uid);
        await dbService.updateNotificationSettings(uid, {
            ...currentSettings,
            slack: {
                enabled: false,
                webhookUrl: '',
                channelName: '',
                channelId: '',
                teamName: '',
                connectedAt: null
            }
        });
        res.json({ success: true });
    } catch (err) {
        logger.error('Slack disconnect error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
