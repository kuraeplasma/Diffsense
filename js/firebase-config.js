// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js";

// Your web app's Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyDq-rEHQcpmuVyNjKrVKDheCBBRFtNsoJ0",
    authDomain: "diffsense.spacegleam.co.jp",
    projectId: "diffsense-9a718",
    storageBucket: "diffsense-9a718.firebasestorage.app",
    messagingSenderId: "707048573054",
    appId: "1:707048573054:web:be9ac39e25bc938cb1702f",
    measurementId: "G-ZCBMSCE4C3"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const analytics = getAnalytics(app);

// Export servcies to be used in other files
export { auth };
