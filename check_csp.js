const https = require('https');

const url = 'https://api-qf37m5ba2q-uc.a.run.app/health';

console.log(`Checking CSP on: ${url}`);

https.get(url, (res) => {
    console.log('CSP Header:');
    console.log(res.headers['content-security-policy']);
}).on('error', (err) => {
    console.error('Error:', err.message);
});
