import { auth } from './firebase-config.js?v=20260422_auth_timeout';
import { Notify } from './notify.js';

import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    GoogleAuthProvider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    getAdditionalUserInfo,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getApiBaseUrl } from './api-base.js';

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
    return getApiBaseUrl();
}

function normalizeBillingCycle(value) {
    return value === 'annual' ? 'annual' : 'monthly';
}

function getStoredAttributionValue(key) {
    const storageKey = `attr_${key}`;
    try {
        const localValue = localStorage.getItem(storageKey);
        if (localValue) return localValue;
    } catch (_) {
        // Ignore localStorage access errors.
    }
    try {
        const sessionValue = sessionStorage.getItem(storageKey);
        if (sessionValue) return sessionValue;
    } catch (_) {
        // Ignore sessionStorage access errors.
    }
    return '';
}

function appendAttributionParams(url) {
    if (window.DiffsenseAttribution && typeof window.DiffsenseAttribution.appendAttributionParams === 'function') {
        return window.DiffsenseAttribution.appendAttributionParams(url, ['gclid', 'wbraid', 'gbraid']);
    }

    const targetUrl = new URL(url, window.location.origin);
    ['gclid', 'wbraid', 'gbraid'].forEach((key) => {
        const value = targetUrl.searchParams.get(key) || getStoredAttributionValue(key);
        if (value) {
            targetUrl.searchParams.set(key, value);
        }
    });
    return targetUrl.toString();
}

function getPasswordResetContinueUrl() {
    return `${window.location.origin}/login.html?tab=login`;
}

function persistPlanIntentFromUrl(options = {}) {
    const markSignupFlow = options.markSignupFlow === true;
    const params = new URLSearchParams(window.location.search);
    const billing = normalizeBillingCycle(params.get('billing'));
    const planFromUrl = params.get('plan');

    // LP経由でプランが指定されている場合はそれを優先
    if (planFromUrl && ['free', 'starter', 'business', 'pro'].includes(planFromUrl.toLowerCase())) {
        localStorage.setItem('diffsense_selected_plan', planFromUrl.toLowerCase());
    } else {
        // 指定がない新規登録はデフォルトでFreeプランへ
        const currentPlan = localStorage.getItem('diffsense_selected_plan');
        if (!currentPlan || markSignupFlow) {
            localStorage.setItem('diffsense_selected_plan', 'free');
        }
    }
    
    localStorage.setItem('diffsense_selected_billing_cycle', billing);
    if (markSignupFlow) {
        localStorage.setItem('diffsense_signup_flow', '1');
    }
}

/**
 * Handle Sign Up
 * @param {string} email
 * @param {string} password
 */
export async function handleSignUp(email, password) {
    try {
        const normalizedEmail = (email || '').toLowerCase().trim();
        
        // 1. Check if user already exists in backend before creating in Firebase
        try {
            const apiBase = getApiBase();
            const checkRes = await fetch(`${apiBase}/api/user/check-exists?email=${encodeURIComponent(normalizedEmail)}`);
            const checkData = await checkRes.json();
            
            if (checkData.success && checkData.exists) {
                Notify.warning('このメールアドレスは既に登録されています。ログインタブからログインしてください。', { title: '登録済み' });
                return;
            }
        } catch (checkError) {
            console.warn('Pre-signup check failed, proceeding anyway:', checkError);
        }

        persistPlanIntentFromUrl({ markSignupFlow: true });
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        console.log("Signed up user:", user);
        
        redirectToThanksSignup();
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
    const params = new URLSearchParams(window.location.search);
    const next = params.get('next');
    window.location.replace(resolveSafeNextUrl(next, 'dashboard.html'));
    return true;
}

function redirectToThanksSignup() {
    persistPlanIntentFromUrl({ markSignupFlow: true });
    const selectedPlan = (localStorage.getItem('diffsense_selected_plan') || 'free').toLowerCase();
    const selectedBillingCycle = normalizeBillingCycle(localStorage.getItem('diffsense_selected_billing_cycle'));
    
    if (selectedPlan === 'free') {
        window.location.replace(appendAttributionParams(`thanks-signup.html?next=dashboard&billing=${selectedBillingCycle}`));
    } else {
        window.location.replace(appendAttributionParams(`thanks-plan.html?plan=${selectedPlan}&billing=${selectedBillingCycle}`));
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
        
        // Correct way to get additional user info in Firebase v9+ Modular SDK
        const addInfo = getAdditionalUserInfo(userCredential);
        let isNewUser = Boolean(addInfo?.isNewUser);
        
        // Final guard: Even if Firebase says isNewUser, check our backend DB
        if (isNewUser && user.email) {
            try {
                const checkRes = await fetch(`${getApiBaseUrl()}/api/user/check-exists?email=${encodeURIComponent(user.email)}`);
                const checkData = await checkRes.json();
                if (checkData.exists) {
                    console.log("Backend confirmed user exists, overrides Firebase isNewUser: true");
                    isNewUser = false;
                }
            } catch (e) {
                console.warn("Backend check failed during Google login:", e);
            }
        }

        console.log("Google signed in user:", user, "isNewUser:", isNewUser);
        localStorage.removeItem('diffsense_auth_intent');
        
        if (normalizedIntent === 'signup' && isNewUser) {
            redirectToThanksSignup();
            return;
        }
        
        if (!isNewUser) {
            Notify.info('既にご登録済みのため、ログインしました。', { title: 'ログイン完了' });
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
        
        const addInfo = getAdditionalUserInfo(result);
        let isNewUser = Boolean(addInfo?.isNewUser);
        const user = result.user;

        // Final guard: Even if Firebase says isNewUser, check our backend DB
        if (isNewUser && user.email) {
            try {
                const checkRes = await fetch(`${getApiBaseUrl()}/api/user/check-exists?email=${encodeURIComponent(user.email)}`);
                const checkData = await checkRes.json();
                if (checkData.exists) {
                    isNewUser = false;
                }
            } catch (e) {
                console.warn("Backend check failed during Google redirect:", e);
            }
        }

        const authIntent = localStorage.getItem('diffsense_auth_intent');
        localStorage.removeItem('diffsense_auth_intent');
        
        if (authIntent === 'signup' && isNewUser) {
            redirectToThanksSignup();
            return true;
        }
        if (!isNewUser) {
            Notify.info('既にご登録済みのため、ログインしました。', { title: 'ログイン完了' });
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
