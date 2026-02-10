require('dotenv').config();
const sgMail = require('@sendgrid/mail');

if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
} else {
    console.error('SENDGRID_API_KEY is missing');
    process.exit(1);
}

const msg = {
    to: 'test@example.com', // Dummy address
    from: process.env.FROM_EMAIL || 'noreply@diffsense.com',
    subject: 'Test Email',
    text: 'This is a test.',
};

sgMail
    .send(msg)
    .then(() => {
        console.log('Email sent successfully');
    })
    .catch((error) => {
        console.error('Error sending email:');
        console.error(error.toString());
        if (error.response) {
            console.error(JSON.stringify(error.response.body, null, 2));
        }
    });
