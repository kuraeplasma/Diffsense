const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env'), override: true });
const { db } = require('./src/firebase');

async function simulatePayment() {
    const uid = 'dev-user-001';
    const userRef = db.collection('users').doc(uid);
    
    // 30 days from now
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const renewalDateStr = futureDate.toISOString().split('T')[0];
    const renewalTimestamp = Math.floor(futureDate.getTime() / 1000);

    console.log(`Simulating payment for user: ${uid}`);
    console.log(`Setting renewal date to: ${renewalDateStr}`);

    await userRef.set({
        plan: 'pro',
        stripeStatus: 'active',
        subscriptionState: 'active',
        currentPeriodEnd: renewalDateStr,
        // Also add some meta for debugging
        lastPaymentAt: new Date().toISOString(),
        hasPaymentMethod: true
    }, { merge: true });

    console.log('Successfully updated user profile in Firestore.');
    process.exit(0);
}

simulatePayment().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
