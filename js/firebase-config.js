// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js";

// Your web app's Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyDq-rEHQcpmuVyNjKrVKDheCBBRFtNsoJ0",
    authDomain: "diffsense-9a718.firebaseapp.com",
    projectId: "diffsense-9a718",
    storageBucket: "diffsense-9a718.firebasestorage.app",
    messagingSenderId: "707048573054",
    appId: "1:707048573054:web:be9ac39e25bc938cb1702f",
    measurementId: "G-ZCBMSCE4C3"
};

// Initialize Firebase
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

let auth = null;
try {
    auth = getAuth(app);
} catch (e) {
    console.warn('Firebase Auth initialization failed:', e);
}

// Analytics is optional. In some local/browser contexts it throws during module load,
// which prevents the dashboard bootstrap from running and leaves the page stuck on
// the initial "loading" markup.
try {
    if (typeof window !== 'undefined' && window.location?.protocol !== 'file:') {
        getAnalytics(app);
    }
} catch (error) {
    console.warn('Firebase Analytics init skipped:', error);
}

// Export servcies to be used in other files
export { auth };
