const { randomUUID } = require('crypto');
const logger = require('../utils/logger');
const { validateApiKey } = require('./auth');
const oauthStore = require('./oauthStore');
const {
    generateOpaqueSecret,
    buildOpaqueTokenRecord,
    maskSecretForLogs
} = require('./keys');

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTH_CODE_TTL_SECONDS = 10 * 60;

function isExpired(expiresAt) {
    return Number(expiresAt || 0) <= Math.floor(Date.now() / 1000);
}

function renderAuthorizePage({ client, error = '', maskedKey = '未発行', postUrl = '', hiddenFields = {} }) {
    const connectorIconUrl = '/images/scaled_favicon.png?v=20260329_oauthicon1';
    const hiddenInputs = Object.entries(hiddenFields).map(([key, value]) => {
        const safeValue = String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        return `<input type="hidden" name="${key}" value="${safeValue}">`;
    }).join('');

    const errorHtml = error
        ? `<div style="padding:12px 14px; border-radius:10px; background:#fff1f2; color:#9f1239; font-size:13px; line-height:1.5;">${error}</div>`
        : '';

    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DIFFsense MCP 認証</title>
  <meta name="application-name" content="DIFFsense">
  <link rel="icon" type="image/png" href="${connectorIconUrl}">
  <link rel="shortcut icon" href="${connectorIconUrl}">
  <link rel="apple-touch-icon" href="${connectorIconUrl}">
</head>
<body style="margin:0; background:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#0f172a;">
  <main style="max-width:560px; margin:48px auto; padding:0 20px;">
    <section style="background:#fff; border:1px solid #e2e8f0; border-radius:20px; padding:28px; box-shadow:0 20px 60px rgba(15,23,42,0.08);">
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
        <img src="${connectorIconUrl}" alt="DIFFsense" width="32" height="32" style="display:block; width:32px; height:32px; object-fit:contain;">
        <div style="font-size:12px; font-weight:700; color:#a16207; letter-spacing:0.04em; text-transform:uppercase;">DIFFsense Connector</div>
      </div>
      <h1 style="margin:0 0 12px; font-size:28px; line-height:1.2;">MCP 接続を承認</h1>
      <p style="margin:0 0 18px; font-size:14px; line-height:1.7; color:#475569;">
        <strong>${client?.client_name || 'Claude'}</strong> から DIFFsense の契約解析ツールを使うための認証です。<br>
        URLにキーは含めず、ここで一度だけ MCP キーを確認します。
      </p>
      ${errorHtml}
      <form method="post" action="${postUrl}" style="display:flex; flex-direction:column; gap:16px; margin-top:${error ? '16px' : '0'};">
        ${hiddenInputs}
        <label style="display:flex; flex-direction:column; gap:8px;">
          <span style="font-size:13px; font-weight:700;">MCP専用キー</span>
          <input
            type="password"
            name="mcp_api_key"
            autocomplete="off"
            spellcheck="false"
            placeholder="mcp_..."
            style="padding:12px 14px; border:1px solid #cbd5e1; border-radius:12px; font-size:14px;"
            required
          >
        </label>
        <div style="font-size:12px; color:#64748b; line-height:1.6;">
          現在の登録状態: <strong>${maskedKey}</strong><br>
          キーが分からない場合は DIFFsense のダッシュボードで新規発行してください。既存キーは安全のため再表示されません。
        </div>
        <button type="submit" style="padding:12px 16px; border:none; border-radius:12px; background:#c19b4a; color:#fff; font-size:14px; font-weight:800; cursor:pointer;">
          接続を許可
        </button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

class DiffsenseOAuthProvider {
    constructor(resourceServerUrl) {
        this.resourceServerUrl = resourceServerUrl;
        this.clientsStore = oauthStore;
    }

    async authorize(client, params, res) {
        const req = res.req;
        const existingMaskedKey = req.query.masked_key || '未発行';
        const hiddenFields = {
            client_id: client.client_id,
            redirect_uri: params.redirectUri,
            response_type: 'code',
            code_challenge: params.codeChallenge,
            code_challenge_method: 'S256',
            scope: Array.isArray(params.scopes) ? params.scopes.join(' ') : '',
            state: params.state || '',
            resource: params.resource?.href || ''
        };

        if (req.method !== 'POST') {
            return res.status(200).send(renderAuthorizePage({
                client,
                maskedKey: existingMaskedKey,
                postUrl: req.originalUrl || req.url,
                hiddenFields
            }));
        }

        const apiKey = String(req.body?.mcp_api_key || '').trim();
        const user = await validateApiKey(apiKey);
        if (!user) {
            return res.status(401).send(renderAuthorizePage({
                client,
                error: 'MCPキーを確認できませんでした。最新のキーをダッシュボードで発行してから再度お試しください。',
                maskedKey: existingMaskedKey,
                postUrl: req.originalUrl || req.url,
                hiddenFields
            }));
        }

        const code = randomUUID();
        const expiresAt = Math.floor(Date.now() / 1000) + AUTH_CODE_TTL_SECONDS;
        await oauthStore.saveAuthorizationCode(code, {
            clientId: client.client_id,
            redirectUri: params.redirectUri,
            codeChallenge: params.codeChallenge,
            scopes: Array.isArray(params.scopes) ? params.scopes : [],
            resource: params.resource?.href || this.resourceServerUrl.href,
            uid: user.uid,
            email: user.email || '',
            expiresAt,
            createdAt: new Date().toISOString()
        });

        const targetUrl = new URL(params.redirectUri);
        targetUrl.searchParams.set('code', code);
        if (params.state !== undefined) {
            targetUrl.searchParams.set('state', params.state);
        }

        logger.info(`[mcp-oauth] authorization granted uid=${user.uid} client=${client.client_id}`);
        return res.redirect(targetUrl.toString());
    }

    async challengeForAuthorizationCode(client, authorizationCode) {
        const codeData = await oauthStore.getAuthorizationCode(authorizationCode);
        if (!codeData) {
            throw new Error('Invalid authorization code');
        }
        if (codeData.clientId !== client.client_id) {
            throw new Error('Authorization code was not issued to this client');
        }
        if (isExpired(codeData.expiresAt)) {
            await oauthStore.deleteAuthorizationCode(authorizationCode);
            throw new Error('Authorization code has expired');
        }
        return codeData.codeChallenge;
    }

    async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
        const codeData = await oauthStore.getAuthorizationCode(authorizationCode);
        if (!codeData) {
            throw new Error('Invalid authorization code');
        }
        if (codeData.clientId !== client.client_id) {
            throw new Error('Authorization code was not issued to this client');
        }
        if (redirectUri && codeData.redirectUri !== redirectUri) {
            throw new Error('redirect_uri does not match the authorization code');
        }
        if (resource && codeData.resource && codeData.resource !== resource.href) {
            throw new Error('resource does not match the authorization code');
        }
        if (isExpired(codeData.expiresAt)) {
            await oauthStore.deleteAuthorizationCode(authorizationCode);
            throw new Error('Authorization code has expired');
        }

        await oauthStore.deleteAuthorizationCode(authorizationCode);
        return this._issueTokens({
            clientId: client.client_id,
            uid: codeData.uid,
            email: codeData.email,
            scopes: Array.isArray(codeData.scopes) ? codeData.scopes : [],
            resource: codeData.resource || this.resourceServerUrl.href
        });
    }

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
        const refreshLookup = buildOpaqueTokenRecord(refreshToken).lookup;
        const refresh = await oauthStore.getTokenByLookup('refresh', refreshLookup);
        if (!refresh || refresh.clientId !== client.client_id) {
            throw new Error('Invalid refresh token');
        }
        if (refresh.revokedAt || isExpired(refresh.expiresAt)) {
            throw new Error('Refresh token has expired');
        }

        const nextScopes = Array.isArray(scopes) && scopes.length > 0 ? scopes : refresh.scopes;
        const nextResource = resource?.href || refresh.resource || this.resourceServerUrl.href;

        return this._issueTokens({
            clientId: client.client_id,
            uid: refresh.uid,
            email: refresh.email,
            scopes: nextScopes,
            resource: nextResource
        });
    }

    async verifyAccessToken(token) {
        const accessLookup = buildOpaqueTokenRecord(token).lookup;
        const access = await oauthStore.getTokenByLookup('access', accessLookup);
        if (!access || access.revokedAt) {
            throw new Error('Invalid access token');
        }
        if (isExpired(access.expiresAt)) {
            throw new Error('Access token has expired');
        }

        return {
            token,
            clientId: access.clientId,
            scopes: Array.isArray(access.scopes) ? access.scopes : [],
            expiresAt: access.expiresAt,
            resource: access.resource ? new URL(access.resource) : undefined,
            extra: {
                uid: access.uid,
                email: access.email || ''
            }
        };
    }

    async _issueTokens({ clientId, uid, email, scopes, resource }) {
        const now = Math.floor(Date.now() / 1000);
        const accessToken = generateOpaqueSecret('mcp_at');
        const refreshToken = generateOpaqueSecret('mcp_rt');

        await oauthStore.saveToken(randomUUID(), {
            type: 'access',
            clientId,
            uid,
            email: email || '',
            scopes: Array.isArray(scopes) ? scopes : [],
            resource,
            expiresAt: now + ACCESS_TOKEN_TTL_SECONDS,
            createdAt: new Date().toISOString(),
            ...buildOpaqueTokenRecord(accessToken)
        });

        await oauthStore.saveToken(randomUUID(), {
            type: 'refresh',
            clientId,
            uid,
            email: email || '',
            scopes: Array.isArray(scopes) ? scopes : [],
            resource,
            expiresAt: now + REFRESH_TOKEN_TTL_SECONDS,
            createdAt: new Date().toISOString(),
            ...buildOpaqueTokenRecord(refreshToken)
        });

        logger.info(`[mcp-oauth] issued bearer tokens uid=${uid} client=${clientId} access=${maskSecretForLogs(accessToken)}`);
        return {
            access_token: accessToken,
            token_type: 'bearer',
            expires_in: ACCESS_TOKEN_TTL_SECONDS,
            refresh_token: refreshToken,
            scope: (Array.isArray(scopes) ? scopes : []).join(' ')
        };
    }
}

function createDiffsenseOAuthProvider(resourceServerUrl) {
    return new DiffsenseOAuthProvider(resourceServerUrl);
}

module.exports = {
    createDiffsenseOAuthProvider,
    renderAuthorizePage
};
