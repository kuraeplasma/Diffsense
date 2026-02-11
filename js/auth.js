import { auth } from './firebase-config.js';
import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

/**
 * Handle Sign Up
 * @param {string} email 
 * @param {string} password 
 */
export async function handleSignUp(email, password) {
    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        console.log("Signed up user:", user);
        // Alert is used for simplicity, in production custom UI is better
        alert("アカウント作成に成功しました！");
        // プランがLP経由で既に選択済みならダッシュボードへ直行、未選択ならプラン選択画面へ
        const selectedPlan = localStorage.getItem('diffsense_selected_plan');
        if (selectedPlan) {
            window.location.replace("dashboard.html");
        } else {
            window.location.replace("select-plan.html");
        }
    } catch (error) {
        console.error("Error signing up:", error);
        let msg = "エラーが発生しました。\n詳細: " + error.code;
        if (error.code === 'auth/email-already-in-use') {
            msg = "このメールアドレスは既に登録されています。";
        } else if (error.code === 'auth/weak-password') {
            msg = "パスワードは6文字以上で設定してください。";
        } else if (error.code === 'auth/operation-not-allowed') {
            msg = "【重要】Firebaseの設定で「メール/パスワード」ログインが有効になっていません。\nFirebaseコンソールのAuthentication設定を確認してください。";
        }
        alert(msg);
    }
}

/**
 * Handle Login
 * @param {string} email 
 * @param {string} password 
 */
export async function handleLogin(email, password) {
    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        console.log("Logged in user:", user);
        window.location.replace("dashboard.html");
    } catch (error) {
        console.error("Error logging in:", error);
        alert("メールアドレスまたはパスワードが間違っています。");
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
            // No user is signed in, redirect to login
            console.log("No user found, redirecting to login.");
            window.location.replace("login.html");
        } else {
            // User is signed in
            console.log("User is authenticated:", user.email);
            // Optionally update UI with user info
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
                    const token = await user.getIdToken(true); // Force refresh
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
