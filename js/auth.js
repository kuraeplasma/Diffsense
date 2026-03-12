import { auth } from './firebase-config.js?v=20260311c';
import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    GoogleAuthProvider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

function resolveSafeNextUrl(nextRaw, fallbackPath = 'dashboard.html') {
    if (!nextRaw || typeof nextRaw !== 'string') {
        return `${window.location.origin}/${fallbackPath}`;
    }
    // Block absolute/protocol-relative external redirects
    if (/^https?:\/\//i.test(nextRaw) || nextRaw.startsWith('//')) {
        return `${window.location.origin}/${fallbackPath}`;
    }
    const normalized = nextRaw.startsWith('/') ? nextRaw : `/${nextRaw}`;
    return `${window.location.origin}${normalized}`;
}

function getApiBase() {
    return (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        ? 'http://localhost:3001'
        : 'https://api-qf37m5ba2q-an.a.run.app';
}

function normalizeBillingCycle(value) {
    return value === 'annual' ? 'annual' : 'monthly';
}

function getPasswordResetContinueUrl() {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
        return 'http://localhost:3000/login.html?tab=login';
    }
    return 'https://diffsense.spacegleam.co.jp/login.html?tab=login';
}

function persistPlanIntentFromUrl(options = {}) {
    const markSignupFlow = options.markSignupFlow === true;
    const params = new URLSearchParams(window.location.search);
    const billing = normalizeBillingCycle(params.get('billing'));

    // 無料登録導線はすべてProトライアルへ統一
    localStorage.setItem('diffsense_selected_plan', 'pro');
    localStorage.setItem('diffsense_selected_billing_cycle', billing);
    if (markSignupFlow) {
        localStorage.setItem('diffsense_signup_flow', '1');
        localStorage.removeItem('diffsense_trial_expired_flow');
        localStorage.removeItem('diffsense_trial_expired');
    }
}

async function isTrialExpiredWithoutPayment(user) {
    try {
        if (!user) return false;
        const token = await user.getIdToken();
        if (!token) return false;

        const apiBase = getApiBase();
        const [subRes, paymentRes] = await Promise.all([
            fetch(`${apiBase}/user/subscription`, {
                headers: { 'Authorization': `Bearer ${token}` }
            }),
            fetch(`${apiBase}/payment/status`, {
                headers: { 'Authorization': `Bearer ${token}` }
            })
        ]);

        if (!subRes.ok || !paymentRes.ok) return false;
        const subJson = await subRes.json();
        const paymentJson = await paymentRes.json();

        const sub = subJson?.data || {};
        const payment = paymentJson?.data || {};
        return !!sub.trialStartedAt && !sub.isInTrial && !payment.hasPaymentMethod;
    } catch (error) {
        console.warn('Trial expired check failed on login:', error);
        return false;
    }
}

/**
 * Handle Sign Up
 * @param {string} email
 * @param {string} password
 */
export async function handleSignUp(email, password) {
    try {
        persistPlanIntentFromUrl({ markSignupFlow: true });
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        console.log("Signed up user:", user);
        // プランがLP経由で既に選択済みならサンクスページ経由でダッシュボードへ
        const selectedPlan = localStorage.getItem('diffsense_selected_plan');
        const selectedBillingCycle = normalizeBillingCycle(localStorage.getItem('diffsense_selected_billing_cycle'));
        if (selectedPlan) {
            window.location.replace(`thanks-signup.html?next=dashboard&billing=${selectedBillingCycle}`);
        } else {
            window.location.replace("thanks-signup.html");
        }
    } catch (error) {
        console.error("Error signing up:", error);
        let msg = "エラーが発生しました。\n詳細: " + error.code;
        if (error.code === 'auth/email-already-in-use') {
            msg = "このメールアドレスは既に登録されています。";
        } else if (error.code === 'auth/weak-password') {
            msg = "パスワードは6文字以上で設定してください。";
        } else if (error.code === 'auth/operation-not-allowed') {
            msg = "Firebaseの設定で「メール/パスワード」ログインが有効になっていません。";
        }
        Notify.error(msg);
    }
}

/**
 * Handle Login
 * @param {string} email
 * @param {string} password
 */
export async function handleLogin(email, password) {
    try {
        persistPlanIntentFromUrl();
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        console.log("Logged in user:", user);

        // 無料期間が切れており決済未登録なら、ログイン直後にプラン選択画面へ
        const mustShowPlanSelect = await isTrialExpiredWithoutPayment(user);
        if (mustShowPlanSelect) {
            localStorage.setItem('diffsense_trial_expired', '1');
            const selectedBillingCycle = normalizeBillingCycle(localStorage.getItem('diffsense_selected_billing_cycle'));
            window.location.replace(`${window.location.origin}/select-plan-preview.html?reason=trial_expired&billing=${selectedBillingCycle}`);
            return;
        }

        const params = new URLSearchParams(window.location.search);
        const next = params.get('next');
        window.location.replace(resolveSafeNextUrl(next, 'dashboard.html'));
    } catch (error) {
        console.error("Error logging in:", error);
        Notify.error("メールアドレスまたはパスワードが間違っています。", { title: 'ログイン失敗' });
    }
}

/**
 * Send password reset email
 * @param {string} email
 */
export async function handlePasswordReset(email) {
    const normalizedEmail = (email || '').trim();
    if (!normalizedEmail) {
        Notify.error('メールアドレスを入力してください。', { title: '再発行メール送信' });
        return false;
    }
    if (window.location.protocol === 'file:') {
        Notify.error('ローカルファイルでは送信できません。http://localhost で開いてください。', { title: '再発行メール送信失敗' });
        return false;
    }

    try {
        auth.languageCode = 'ja';
        const actionCodeSettings = {
            url: getPasswordResetContinueUrl(),
            handleCodeInApp: false
        };
        await sendPasswordResetEmail(auth, normalizedEmail, actionCodeSettings);
        Notify.success('パスワード再発行メールを送信しました。メールをご確認ください。', { title: '送信完了' });
        return true;
    } catch (error) {
        console.error('Error sending password reset email:', error);
        let msg = '再発行メールの送信に失敗しました。時間をおいて再度お試しください。';
        if (error?.code === 'auth/invalid-email') {
            msg = 'メールアドレスの形式が正しくありません。';
        } else if (error?.code === 'auth/missing-email') {
            msg = 'メールアドレスを入力してください。';
        } else if (error?.code === 'auth/user-not-found') {
            msg = 'このメールアドレスのアカウントは見つかりません。';
        } else if (error?.code === 'auth/too-many-requests') {
            msg = '試行回数が多すぎます。しばらくしてから再度お試しください。';
        }
        Notify.error(msg, { title: '再発行メール送信失敗' });
        return false;
    }
}

async function finalizePostLogin(user) {
    const mustShowPlanSelect = await isTrialExpiredWithoutPayment(user);
    if (mustShowPlanSelect) {
        localStorage.setItem('diffsense_trial_expired', '1');
        const selectedBillingCycle = normalizeBillingCycle(localStorage.getItem('diffsense_selected_billing_cycle'));
        window.location.replace(`${window.location.origin}/select-plan-preview.html?reason=trial_expired&billing=${selectedBillingCycle}`);
        return true;
    }

    const params = new URLSearchParams(window.location.search);
    const next = params.get('next');
    window.location.replace(resolveSafeNextUrl(next, 'dashboard.html'));
    return true;
}

function redirectToThanksSignup() {
    persistPlanIntentFromUrl({ markSignupFlow: true });
    const selectedPlan = localStorage.getItem('diffsense_selected_plan');
    const selectedBillingCycle = normalizeBillingCycle(localStorage.getItem('diffsense_selected_billing_cycle'));
    if (selectedPlan) {
        window.location.replace(`thanks-signup.html?next=dashboard&billing=${selectedBillingCycle}`);
    } else {
        window.location.replace('thanks-signup.html');
    }
}

/**
 * Handle Google Login / Signup
 */
export async function handleGoogleLogin(intent = 'auto') {
    try {
        const normalizedIntent = intent === 'signup' ? 'signup' : 'login';
        persistPlanIntentFromUrl({ markSignupFlow: normalizedIntent === 'signup' });
        localStorage.setItem('diffsense_auth_intent', normalizedIntent);
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });

        const userCredential = await signInWithPopup(auth, provider);
        const user = userCredential.user;
        const isNewUser = Boolean(userCredential?.additionalUserInfo?.isNewUser);
        console.log("Google signed in user:", user);
        localStorage.removeItem('diffsense_auth_intent');
        if (normalizedIntent === 'signup' || isNewUser) {
            redirectToThanksSignup();
            return;
        }
        await finalizePostLogin(user);
    } catch (error) {
        console.error("Error with Google login:", error);
        const code = error?.code || 'unknown';
        let msg = `Googleログインに失敗しました。（${code}）`;
        if (error?.code === 'auth/popup-closed-by-user') {
            msg = 'Googleログインがキャンセルされました。';
        } else if (error?.code === 'auth/popup-blocked') {
            msg = 'ポップアップがブロックされました。ブラウザ設定をご確認ください。';
        } else if (error?.code === 'auth/operation-not-allowed') {
            msg = 'Firebaseの設定で「Googleログイン」が有効になっていません。';
        } else if (error?.code === 'auth/unauthorized-domain') {
            msg = 'このドメインはGoogleログイン未許可です。Firebaseの承認済みドメインを確認してください。';
        } else if (error?.code === 'auth/operation-not-supported-in-this-environment') {
            msg = '現在の環境ではGoogleログインを実行できません（file:// など）。http(s)で開いてください。';
        } else if (error?.code === 'auth/network-request-failed') {
            msg = 'ネットワーク接続エラーです。接続環境またはブラウザ拡張を確認してください。';
        } else if (error?.code === 'auth/invalid-api-key' || error?.code === 'auth/app-not-authorized') {
            msg = 'Firebase APIキー設定でこの実行元が許可されていません。APIキー制限を確認してください。';
        }
        Notify.error(msg, { title: 'Googleログイン失敗' });
    }
}

/**
 * Complete Google redirect flow (mainly for localhost)
 */
export async function handleGoogleRedirectResult() {
    try {
        const result = await getRedirectResult(auth);
        if (!result || !result.user) return false;
        const isNewUser = Boolean(result?.additionalUserInfo?.isNewUser);
        const authIntent = localStorage.getItem('diffsense_auth_intent');
        localStorage.removeItem('diffsense_auth_intent');
        if (authIntent === 'signup' || isNewUser) {
            redirectToThanksSignup();
            return true;
        }
        await finalizePostLogin(result.user);
        return true;
    } catch (error) {
        console.error("Error handling Google redirect result:", error);
        const code = error?.code || 'unknown';
        Notify.error(`Googleログインに失敗しました。（${code}）`, { title: 'Googleログイン失敗' });
        return false;
    }
}

/**
 * Handle Logout
 */
export async function handleLogout() {
    try {
        await signOut(auth);
        console.log("User signed out");
        window.location.replace("login.html");
    } catch (error) {
        console.error("Error signing out:", error);
    }
}

/**
 * Monitor Auth State for Protected Pages
 * Call this on pages that require login (e.g. dashboard)
 */
export function requireAuth() {
    // Development Bypass for localhost
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        console.log("Local development detected, bypassing Firebase Auth check.");
        processDevBypass();
        return;
    }

    onAuthStateChanged(auth, (user) => {
        if (!user) {
            console.log("No user found, redirecting to login.");
            const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
            window.location.replace(`${window.location.origin}/login.html?next=${encodeURIComponent(next)}`);
        } else {
            console.log("User is authenticated:", user.email);
            const userEmailEl = document.getElementById('user-email-display');
            if (userEmailEl) {
                userEmailEl.textContent = user.email;
            }
        }
    });
}

function processDevBypass() {
    console.log("DEV AUTH BYPASS ACTIVE");
    const userEmailEl = document.getElementById('user-email-display');
    if (userEmailEl) {
        userEmailEl.textContent = 'dev@localhost';
    }
    const userNameEl = document.getElementById('user-name-display');
    if (userNameEl) {
        userNameEl.textContent = 'テストユーザー';
    }
}
/**
 * Get current user's ID Token
 */
export function getIdToken() {
    return new Promise((resolve, reject) => {
        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            unsubscribe();
            if (user) {
                try {
                    const token = await user.getIdToken();
                    resolve(token);
                } catch (e) {
                    reject(e);
                }
            } else {
                resolve(null);
            }
        });
    });
}
