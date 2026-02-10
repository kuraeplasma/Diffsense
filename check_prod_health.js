const https = require('https');

const url = 'https://api-qf37m5ba2q-uc.a.run.app/health';

console.log(`Checking production health: ${url}`);

https.get(url, (res) => {
    let data = '';

    console.log(`Status Code: ${res.statusCode}`);
    console.log('Headers:', res.headers);

    res.on('data', (chunk) => {
        data += chunk;
    });

    res.on('end', () => {
        console.log('Response Body:');
        console.log(data);
        if (res.statusCode === 200) {
            try {
                const json = JSON.parse(data);
                console.log('✅ Health Check Passed');
                console.log('Environment:', json.environment);
            } catch (e) {
                console.log('⚠️ Response is not valid JSON');
            }
        } else {
            console.log('❌ Health Check Failed');
        }
    });

}).on('error', (err) => {
    console.error('Error:', err.message);
});
