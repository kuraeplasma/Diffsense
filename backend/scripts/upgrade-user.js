const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const projectId = process.env.FB_PROJECT_ID;
const clientEmail = process.env.FB_CLIENT_EMAIL;
const privateKey = process.env.FB_PRIVATE_KEY;

if (!projectId || !clientEmail || !privateKey) {
    console.error('Error: Firebase credentials not found in backend/.env');
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey: privateKey.replace(/\\n/g, '\n'),
    })
});

const db = admin.firestore();

async function upgradeUser(email) {
    try {
        console.log(`Searching for user with email: ${email}...`);
        
        // Find user by email in 'users' collection
        const snapshot = await db.collection('users').where('email', '==', email).limit(1).get();
        
        if (snapshot.empty) {
            console.error(`Error: User with email ${email} not found in Firestore 'users' collection.`);
            process.exit(1);
        }

        const userDoc = snapshot.docs[0];
        const uid = userDoc.id;

        console.log(`Found user: ${uid}. Upgrading to Pro plan and updating password...`);

        // Update password in Firebase Auth
        const targetPassword = process.argv[3];
        if (targetPassword) {
            await admin.auth().updateUser(uid, {
                password: targetPassword
            });
            console.log('Password updated successfully.');
        }

        await db.collection('users').doc(uid).update({
            plan: 'pro',
            subscriptionState: 'active',
            stripeStatus: 'ACTIVE',
            hasPaymentMethod: true,
            updatedAt: new Date().toISOString()
        });

        console.log(`Success! User ${email} (UID: ${uid}) has been upgraded to Pro plan.`);
    } catch (error) {
        console.error('Error upgrading user:', error.message);
        process.exit(1);
    }
}

const targetEmail = process.argv[2];
if (!targetEmail) {
    console.log('Usage: node upgrade-user.js <email>');
    process.exit(1);
}

upgradeUser(targetEmail);
